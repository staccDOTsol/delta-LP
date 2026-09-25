//! Sync: recompute equity / health / delta from on-chain state and write NAV. Permissionless.
//! EndRebalance: Sync + the guards, then Idle.

use crate::{
    error::VaultError,
    ix::common::*,
    state::*,
    venue::{drift, klend, whirlpool},
};
use dlp_math::nav;
use pinocchio::{error::ProgramError, AccountView, Address, ProgramResult};

pub struct Snapshot {
    pub equity_q: u64,
    pub supply: u64,
    pub price_raw_e12: u64,
    pub lp_base: u64,
    pub idle_base: u64,
    pub hedge_base: u64,
    pub health_x100: u32,
    pub pool_dev_bps: u32,
    pub oracle_ok: bool,
}

/// Fair value of the current LP position at the oracle sqrt price: (base, quote) incl. fees owed.
fn lp_fair(v: &Vault, position: &AccountView, sqrt_oracle: u128) -> Result<(u64, u64), ProgramError> {
    if !v.has_position() || v.liquidity() == 0 {
        // fees may still be owed on an empty position that hasn't been collected
        if v.has_position() {
            require_key(position, &v.position)?;
            let p = whirlpool::read_position(position)?;
            return Ok((p.fee_owed_a, p.fee_owed_b));
        }
        return Ok((0, 0));
    }
    require_key(position, &v.position)?;
    let p = whirlpool::read_position(position)?;
    if p.liquidity != v.liquidity() || p.tick_lower_index != v.tick_lower() || p.tick_upper_index != v.tick_upper() {
        return Err(VaultError::UnexpectedState.into());
    }
    let (a, b) = nav::lp_fair_amounts(sqrt_oracle, p.tick_lower_index, p.tick_upper_index, p.liquidity).map_err(|_| VaultError::MathOverflow)?;
    Ok((a.checked_add(p.fee_owed_a).ok_or(VaultError::MathOverflow)?, b.checked_add(p.fee_owed_b).ok_or(VaultError::MathOverflow)?))
}

/// quote-per-base raw price ×1e12 from two USD prices (×1e12) and decimals.
fn raw_price_e12(base_usd_e12: u64, quote_usd_e12: u64, base_decimals: u8, quote_decimals: u8) -> Result<u64, ProgramError> {
    // P_raw = (base_usd / quote_usd) · 10^dq / 10^db
    let num = (base_usd_e12 as u128).checked_mul(10u128.pow(quote_decimals as u32)).ok_or(VaultError::MathOverflow)?;
    let den = (quote_usd_e12 as u128).checked_mul(10u128.pow(base_decimals as u32)).ok_or(VaultError::MathOverflow)?;
    let v = dlp_math::u256::mul_div_u128(num, 1_000_000_000_000, den).ok_or(VaultError::MathOverflow)?;
    u64::try_from(v).map_err(|_| VaultError::MathOverflow.into())
}

pub struct KlendSyncAccounts<'a> {
    pub vault: &'a AccountView,
    pub whirlpool: &'a AccountView,
    pub position: &'a AccountView,
    pub base_ata: &'a AccountView,
    pub quote_ata: &'a AccountView,
    pub receipt_mint: &'a AccountView,
    pub klend_program: &'a AccountView,
    pub lending_market: &'a AccountView,
    pub obligation: &'a AccountView,
    pub quote_reserve: &'a AccountView,
    pub base_reserve: &'a AccountView,
    pub scope_prices: &'a AccountView,
}

impl<'a> KlendSyncAccounts<'a> {
    pub fn parse(accounts: &'a [AccountView]) -> Result<Self, ProgramError> {
        let a = need(accounts, 12)?;
        Ok(KlendSyncAccounts {
            vault: &a[0], whirlpool: &a[1], position: &a[2], base_ata: &a[3], quote_ata: &a[4], receipt_mint: &a[5],
            klend_program: &a[6], lending_market: &a[7], obligation: &a[8], quote_reserve: &a[9], base_reserve: &a[10], scope_prices: &a[11],
        })
    }
}

/// Refresh klend state (CPI) and value everything at the Scope oracle. Writes the vault mirror.
pub fn sync_klend(program_id: &Address, a: &KlendSyncAccounts) -> Result<Snapshot, ProgramError> {
    let clock = clock()?;
    let (whirlpool_key, position_key, params, base_dec, quote_dec) = {
        let d = a.vault.try_borrow()?;
        let v = Vault::load(&d)?;
        check_vault_pda(program_id, a.vault, v)?;
        if v.hedge_kind()? != HedgeKind::Klend {
            return Err(VaultError::HedgeKindMismatch.into());
        }
        require_key(a.whirlpool, &v.whirlpool)?;
        require_key(a.base_ata, &v.base_ata)?;
        require_key(a.quote_ata, &v.quote_ata)?;
        require_key(a.receipt_mint, &v.receipt_mint)?;
        require_key(a.lending_market, &v.hedge_market)?;
        require_key(a.obligation, &v.hedge_account)?;
        require_key(a.quote_reserve, &v.hedge_quote)?;
        require_key(a.base_reserve, &v.hedge_base)?;
        (v.whirlpool, v.position, v.params, v.base_decimals, v.quote_decimals)
    };
    let _ = whirlpool_key;
    let _ = position_key;

    // ---- refresh reserves + obligation so every klend number is current-slot
    {
        let rq = klend::read_reserve(a.quote_reserve)?;
        klend::check_scope_only(&rq, a.scope_prices)?;
        let rb = klend::read_reserve(a.base_reserve)?;
        klend::check_scope_only(&rb, a.scope_prices)?;
    }
    klend::refresh_reserve(&klend::RefreshReserveAccounts { reserve: a.quote_reserve, lending_market: a.lending_market, klend_program: a.klend_program, scope_prices: a.scope_prices })?;
    klend::refresh_reserve(&klend::RefreshReserveAccounts { reserve: a.base_reserve, lending_market: a.lending_market, klend_program: a.klend_program, scope_prices: a.scope_prices })?;
    // a fully unwound obligation is closed by klend; it then holds nothing (reopen via ReopenObligation)
    let ob_open = klend::obligation_is_open(a.obligation);
    if ob_open {
        klend::refresh_obligation(a.klend_program, a.lending_market, a.obligation, &[a.quote_reserve, a.base_reserve])?;
    }

    let rq = klend::read_reserve(a.quote_reserve)?;
    let rb = klend::read_reserve(a.base_reserve)?;
    let health_x100 = if ob_open {
        let ob = klend::read_obligation(a.obligation)?;
        if ob.owner != *a.vault.address().as_array() {
            return Err(VaultError::BadVenueAccount.into());
        }
        ob.health_x100()
    } else {
        u32::MAX
    };
    let oracle_ok = rq.price_status == klend::PRICE_STATUS_ALL_CHECKS && rb.price_status == klend::PRICE_STATUS_ALL_CHECKS && !rq.stale && !rb.stale;

    // ---- prices
    let price_raw_e12 = raw_price_e12(rb.price_usd_e12()?, rq.price_usd_e12()?, base_dec, quote_dec)?;
    let sqrt_oracle = nav::sqrt_price_x64_from_price_e12(price_raw_e12).ok_or(VaultError::MathOverflow)?;
    let wp = whirlpool::read_whirlpool(a.whirlpool)?;
    // sqrt deviation ≈ half the price deviation
    let pool_dev_bps = (nav::deviation_bps(wp.sqrt_price, sqrt_oracle).saturating_mul(2)).min(u32::MAX as u128) as u32;

    // ---- legs
    let (lp_base, lp_quote) = {
        let d = a.vault.try_borrow()?;
        let v = Vault::load(&d)?;
        lp_fair(v, a.position, sqrt_oracle)?
    };
    let idle_base = token_amount(a.base_ata)?;
    let idle_quote = token_amount(a.quote_ata)?;
    let (collateral_q, hedge_base) = if ob_open {
        let ctokens = klend::obligation_deposit_ctokens(a.obligation, a.quote_reserve.address().as_array())?;
        // vault invariant: nothing else in the obligation
        klend::obligation_only_uses(a.obligation, a.quote_reserve.address().as_array(), a.base_reserve.address().as_array())?;
        (rq.ctokens_to_liquidity(ctokens)?, klend::obligation_debt_amount(a.obligation, a.base_reserve.address().as_array())?)
    } else {
        (0, 0)
    };

    // ---- equity (quote units)
    let long_base = (lp_base as u128) + idle_base as u128;
    let long_base_q = base_to_quote(u64::try_from(long_base).map_err(|_| VaultError::MathOverflow)?, price_raw_e12)? as u128;
    let debt_q = base_to_quote(hedge_base, price_raw_e12)? as u128;
    let assets = long_base_q + lp_quote as u128 + idle_quote as u128 + collateral_q as u128;
    let equity = assets.saturating_sub(debt_q);
    let equity_q = u64::try_from(equity).map_err(|_| VaultError::MathOverflow)?;
    let supply = mint_supply(a.receipt_mint)?;

    // ---- write mirror + flags
    {
        let v = Vault::load_mut_acc(&a.vault)?;
        v.set_equity_q(equity_q);
        v.set_receipt_supply(supply);
        v.set_sync_slot(clock.slot);
        v.set_oracle_price_raw_e12(price_raw_e12);
        v.set_hedge_base_amount(hedge_base);
        v.set_lp_base_amount(lp_base);
        v.set_health_x100(health_x100);
        let mut flags = 0u8;
        if health_x100 < params.min_health_x100() as u32 {
            flags |= FLAG_UNDER_HEALTH;
        }
        if pool_dev_bps > params.max_price_dev_bps() as u32 || !oracle_ok {
            flags |= FLAG_PRICE_DEVIATION;
        }
        v.flags = flags;
    }
    Ok(Snapshot { equity_q, supply, price_raw_e12, lp_base, idle_base, hedge_base, health_x100, pool_dev_bps, oracle_ok })
}

pub struct DriftSyncAccounts<'a> {
    pub vault: &'a AccountView,
    pub whirlpool: &'a AccountView,
    pub position: &'a AccountView,
    pub base_ata: &'a AccountView,
    pub quote_ata: &'a AccountView,
    pub receipt_mint: &'a AccountView,
    pub drift_program: &'a AccountView,
    pub user: &'a AccountView,
    pub perp_market: &'a AccountView,
    pub quote_spot_market: &'a AccountView,
}

impl<'a> DriftSyncAccounts<'a> {
    pub fn parse(accounts: &'a [AccountView]) -> Result<Self, ProgramError> {
        let a = need(accounts, 10)?;
        Ok(DriftSyncAccounts { vault: &a[0], whirlpool: &a[1], position: &a[2], base_ata: &a[3], quote_ata: &a[4], receipt_mint: &a[5], drift_program: &a[6], user: &a[7], perp_market: &a[8], quote_spot_market: &a[9] })
    }
}

/// Read-only valuation against Drift's own last oracle price (no CPI). Drift's perp mark is in
/// PRICE_PRECISION USD; quote (USDC/USDT) is taken at par.
pub fn sync_drift(program_id: &Address, a: &DriftSyncAccounts) -> Result<Snapshot, ProgramError> {
    let clock = clock()?;
    let (params, base_dec, quote_dec) = {
        let d = a.vault.try_borrow()?;
        let v = Vault::load(&d)?;
        check_vault_pda(program_id, a.vault, v)?;
        if v.hedge_kind()? != HedgeKind::Drift {
            return Err(VaultError::HedgeKindMismatch.into());
        }
        require_key(a.whirlpool, &v.whirlpool)?;
        require_key(a.base_ata, &v.base_ata)?;
        require_key(a.quote_ata, &v.quote_ata)?;
        require_key(a.receipt_mint, &v.receipt_mint)?;
        require_key(a.user, &v.hedge_account)?;
        require_key(a.perp_market, &v.hedge_market)?;
        require_key(a.quote_spot_market, &v.hedge_quote)?;
        (v.params, v.base_decimals, v.quote_decimals)
    };
    if a.drift_program.address() != &drift::ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    let pm = drift::read_perp_market(a.perp_market)?;
    let sm = drift::read_spot_market(a.quote_spot_market)?;
    let user = drift::read_user(a.user, sm.market_index, pm.market_index)?;
    if user.authority != *a.vault.address().as_array() {
        return Err(VaultError::BadVenueAccount.into());
    }
    let h = drift::health(&user, &pm, &sm)?;
    if h.oracle_price <= 0 {
        return Err(VaultError::BadVenueAccount.into());
    }
    // drift price is USD·1e6; P_raw_e12 = price_usd_e12 · 10^dq / 10^db with quote at par
    let base_usd_e12 = (h.oracle_price as u64).checked_mul(1_000_000).ok_or(VaultError::MathOverflow)?;
    let price_raw_e12 = raw_price_e12(base_usd_e12, 1_000_000_000_000, base_dec, quote_dec)?;
    let sqrt_oracle = nav::sqrt_price_x64_from_price_e12(price_raw_e12).ok_or(VaultError::MathOverflow)?;
    let wp = whirlpool::read_whirlpool(a.whirlpool)?;
    let pool_dev_bps = (nav::deviation_bps(wp.sqrt_price, sqrt_oracle).saturating_mul(2)).min(u32::MAX as u128) as u32;

    let (lp_base, lp_quote) = {
        let d = a.vault.try_borrow()?;
        let v = Vault::load(&d)?;
        lp_fair(v, a.position, sqrt_oracle)?
    };
    let idle_base = token_amount(a.base_ata)?;
    let idle_quote = token_amount(a.quote_ata)?;
    let long_base = (lp_base as u128) + idle_base as u128;
    let long_base_q = base_to_quote(u64::try_from(long_base).map_err(|_| VaultError::MathOverflow)?, price_raw_e12)? as i128;
    // drift equity = total collateral (deposit + weighted pnl + funding) — already quote units
    let equity = long_base_q + lp_quote as i128 + idle_quote as i128 + h.total_collateral;
    let equity_q = u64::try_from(equity.max(0)).map_err(|_| VaultError::MathOverflow)?;
    let supply = mint_supply(a.receipt_mint)?;
    // hedge base for the delta check: drift base is 1e9-scaled regardless of mint decimals
    let hedge_base = if base_dec == 9 { h.short_base } else { scale_base(h.short_base, base_dec)? };
    let oracle_ok = pm.status == 1; // MarketStatus::Active
    {
        let v = Vault::load_mut_acc(&a.vault)?;
        v.set_equity_q(equity_q);
        v.set_receipt_supply(supply);
        v.set_sync_slot(clock.slot);
        v.set_oracle_price_raw_e12(price_raw_e12);
        v.set_hedge_base_amount(hedge_base);
        v.set_lp_base_amount(lp_base);
        v.set_health_x100(h.health_x100);
        let mut flags = 0u8;
        if h.health_x100 < params.min_health_x100() as u32 {
            flags |= FLAG_UNDER_HEALTH;
        }
        if pool_dev_bps > params.max_price_dev_bps() as u32 || !oracle_ok {
            flags |= FLAG_PRICE_DEVIATION;
        }
        v.flags = flags;
    }
    Ok(Snapshot { equity_q, supply, price_raw_e12, lp_base, idle_base, hedge_base, health_x100: h.health_x100, pool_dev_bps, oracle_ok })
}

fn scale_base(amount_1e9: u64, decimals: u8) -> Result<u64, ProgramError> {
    if decimals > 9 {
        amount_1e9.checked_mul(10u64.pow((decimals - 9) as u32)).ok_or(VaultError::MathOverflow.into())
    } else {
        Ok(amount_1e9 / 10u64.pow((9 - decimals) as u32))
    }
}

/// Sync — accounts: klend layout (12) or drift layout (10) depending on vault.hedge_kind.
pub fn sync(program_id: &Address, accounts: &mut [AccountView], _data: &[u8]) -> ProgramResult {
    let accounts = views(accounts);
    let kind = {
        let d = need(accounts, 1)?[0].try_borrow()?;
        Vault::load(&d)?.hedge_kind()?
    };
    match kind {
        HedgeKind::Klend => sync_klend(program_id, &KlendSyncAccounts::parse(accounts)?).map(|_| ()),
        HedgeKind::Drift => sync_drift(program_id, &DriftSyncAccounts::parse(accounts)?).map(|_| ()),
    }
}

/// EndRebalance — accounts: [crank (s)] ++ Sync accounts. Any non-Idle phase → Idle if guards hold.
pub fn end_rebalance(program_id: &Address, accounts: &mut [AccountView], _data: &[u8]) -> ProgramResult {
    let accounts = views(accounts);
    let accounts = need(accounts, 2)?;
    let crank = &accounts[0];
    let rest = &accounts[1..];
    let (kind, params) = {
        let d = rest[0].try_borrow()?;
        let v = Vault::load(&d)?;
        require_crank(v, crank)?;
        if v.phase()? == Phase::Idle {
            return Err(VaultError::WrongPhase.into());
        }
        (v.hedge_kind()?, v.params)
    };
    let snap = match kind {
        HedgeKind::Klend => sync_klend(program_id, &KlendSyncAccounts::parse(rest)?)?,
        HedgeKind::Drift => sync_drift(program_id, &DriftSyncAccounts::parse(rest)?)?,
    };
    // ---- guards
    if !snap.oracle_ok || snap.pool_dev_bps > params.max_price_dev_bps() as u32 {
        return Err(VaultError::PriceDeviation.into());
    }
    if snap.health_x100 < params.min_health_x100() as u32 {
        return Err(VaultError::UnderHealth.into());
    }
    let dust_base = {
        let d = rest[0].try_borrow()?;
        10u64.pow(Vault::load(&d)?.base_decimals as u32) / 1_000 // 0.001 base units of dust
    };
    if !nav::delta_within(snap.lp_base, snap.idle_base, snap.hedge_base, params.eps_bps(), dust_base) {
        return Err(VaultError::DeltaTooLarge.into());
    }
    let v = Vault::load_mut_acc(&rest[0])?;
    v.phase = Phase::Idle as u8;
    v.set_epoch(v.epoch().checked_add(1).ok_or(VaultError::MathOverflow)?);
    v.set_epoch_supply_start(snap.supply);
    v.set_epoch_minted(0);
    v.set_epoch_burned(0);
    v.set_phase_started_slot(0);
    Ok(())
}
