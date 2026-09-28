//! Drift / Velocity (protocol-v2, `dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH`) adapter.
//! Hand-rolled CPI; discriminators + account orders from the master (2.162.0) IDL, which for
//! these instructions equals the on-chain 2.150.0 IDL. Struct offsets verified against live
//! mainnet accounts (SOL-PERP, USDC spot, state) on 2026-09-25.
//!
//! Status: compiles, ABI-verified, **not exercised against a live venue** — Drift v2 mainnet has
//! not traded since the 2026-04-01 exploit and Velocity (same program id) is pre-launch.

use crate::error::VaultError;
use pinocchio::{
    cpi::{invoke_signed, invoke_signed_with_bounds, Signer},
    error::ProgramError,
    instruction::{InstructionAccount, InstructionView},
    AccountView, Address,
};

pub const ID: Address = Address::from_str_const("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH");

pub const PERP_MARKET_DISC: [u8; 8] = [10, 223, 12, 44, 107, 245, 55, 247];
pub const USER_LEN: usize = 4376;
pub const PERP_MARKET_LEN: usize = 1216;
pub const SPOT_MARKET_LEN: usize = 776;

mod disc {
    pub const INITIALIZE_USER_STATS: [u8; 8] = [254, 243, 72, 98, 251, 130, 168, 213];
    pub const INITIALIZE_USER: [u8; 8] = [111, 17, 185, 250, 60, 122, 38, 254];
    pub const DEPOSIT: [u8; 8] = [242, 35, 198, 137, 82, 225, 242, 182];
    pub const WITHDRAW: [u8; 8] = [183, 18, 70, 156, 148, 109, 161, 34];
    pub const PLACE_AND_TAKE_PERP_ORDER: [u8; 8] = [213, 51, 1, 187, 108, 220, 230, 224];
    pub const SETTLE_PNL: [u8; 8] = [43, 61, 234, 45, 15, 95, 152, 153];
}

#[inline(always)]
fn rd_u16(d: &[u8], o: usize) -> u16 { u16::from_le_bytes(d[o..o + 2].try_into().unwrap()) }
#[inline(always)]
fn rd_u32(d: &[u8], o: usize) -> u32 { u32::from_le_bytes(d[o..o + 4].try_into().unwrap()) }
#[inline(always)]
fn rd_u64(d: &[u8], o: usize) -> u64 { u64::from_le_bytes(d[o..o + 8].try_into().unwrap()) }
#[inline(always)]
fn rd_i64(d: &[u8], o: usize) -> i64 { i64::from_le_bytes(d[o..o + 8].try_into().unwrap()) }
#[inline(always)]
fn rd_u128(d: &[u8], o: usize) -> u128 { u128::from_le_bytes(d[o..o + 16].try_into().unwrap()) }
#[inline(always)]
fn rd_i128(d: &[u8], o: usize) -> i128 { i128::from_le_bytes(d[o..o + 16].try_into().unwrap()) }
#[inline(always)]
fn rd_pk(d: &[u8], o: usize) -> [u8; 32] { d[o..o + 32].try_into().unwrap() }

pub struct PerpMarketView {
    pub oracle: [u8; 32],
    pub last_oracle_price: i64,
    pub last_oracle_price_twap_5min: i64,
    pub cumulative_funding_rate_long: i128,
    pub cumulative_funding_rate_short: i128,
    pub order_step_size: u64,
    pub imf_factor: u32,
    pub margin_ratio_maintenance: u32,
    pub unrealized_pnl_maintenance_asset_weight: u32,
    pub market_index: u16,
    pub status: u8,
    pub quote_spot_market_index: u16,
}

#[inline(never)]
pub fn read_perp_market(acc: &AccountView) -> Result<PerpMarketView, ProgramError> {
    if acc.owner() != &ID {
        return Err(VaultError::BadVenueAccount.into());
    }
    let d = acc.try_borrow()?;
    if d.len() < PERP_MARKET_LEN || d[..8] != PERP_MARKET_DISC {
        return Err(VaultError::BadVenueAccount.into());
    }
    Ok(PerpMarketView {
        oracle: rd_pk(&d, 40),
        last_oracle_price: rd_i64(&d, 72),
        last_oracle_price_twap_5min: rd_i64(&d, 104),
        cumulative_funding_rate_long: rd_i128(&d, 608),
        cumulative_funding_rate_short: rd_i128(&d, 624),
        order_step_size: rd_u64(&d, 808),
        imf_factor: rd_u32(&d, 1120),
        margin_ratio_maintenance: rd_u32(&d, 1140),
        unrealized_pnl_maintenance_asset_weight: rd_u32(&d, 1148),
        market_index: rd_u16(&d, 1160),
        status: d[1162],
        quote_spot_market_index: rd_u16(&d, 1166),
    })
}

pub struct SpotMarketView {
    pub oracle: [u8; 32],
    pub mint: [u8; 32],
    pub vault: [u8; 32],
    pub cumulative_deposit_interest: u128,
    pub decimals: u32,
    pub market_index: u16,
}

#[inline(never)]
pub fn read_spot_market(acc: &AccountView) -> Result<SpotMarketView, ProgramError> {
    if acc.owner() != &ID {
        return Err(VaultError::BadVenueAccount.into());
    }
    let d = acc.try_borrow()?;
    if d.len() < SPOT_MARKET_LEN {
        return Err(VaultError::BadVenueAccount.into());
    }
    Ok(SpotMarketView {
        oracle: rd_pk(&d, 40),
        mint: rd_pk(&d, 72),
        vault: rd_pk(&d, 104),
        cumulative_deposit_interest: rd_u128(&d, 464),
        decimals: rd_u32(&d, 680),
        market_index: rd_u16(&d, 684),
    })
}

pub struct PerpPositionView {
    pub last_cumulative_funding_rate: i64,
    pub base_asset_amount: i64,
    pub quote_asset_amount: i64,
    pub open_orders: u8,
}

pub struct UserView {
    pub authority: [u8; 32],
    pub delegate: [u8; 32],
    /// quote spot deposit scaled balance for `quote_market_index` (0 if none / borrow)
    pub quote_scaled_balance: u64,
    pub quote_is_borrow: bool,
    pub perp: Option<PerpPositionView>,
    /// any other non-empty spot or perp position (vault invariant: must be false)
    pub has_other_positions: bool,
    pub max_margin_ratio: u32,
    pub margin_mode: u8,
    pub open_orders: u8,
}

#[inline(never)]
pub fn read_user(acc: &AccountView, quote_market_index: u16, perp_market_index: u16) -> Result<UserView, ProgramError> {
    if acc.owner() != &ID {
        return Err(VaultError::BadVenueAccount.into());
    }
    let d = acc.try_borrow()?;
    if d.len() < USER_LEN {
        return Err(VaultError::BadVenueAccount.into());
    }
    let mut v = UserView {
        authority: rd_pk(&d, 8),
        delegate: rd_pk(&d, 40),
        quote_scaled_balance: 0,
        quote_is_borrow: false,
        perp: None,
        has_other_positions: false,
        max_margin_ratio: rd_u32(&d, 4340),
        margin_mode: d[4355],
        open_orders: d[4351],
    };
    for i in 0..8 {
        let o = 104 + 40 * i;
        let scaled = rd_u64(&d, o);
        if scaled == 0 {
            continue;
        }
        let idx = rd_u16(&d, o + 32);
        if idx == quote_market_index {
            v.quote_scaled_balance = scaled;
            v.quote_is_borrow = d[o + 34] != 0;
        } else {
            v.has_other_positions = true;
        }
    }
    for i in 0..8 {
        let o = 424 + 96 * i;
        let base = rd_i64(&d, o + 8);
        let quote = rd_i64(&d, o + 16);
        let idx = rd_u16(&d, o + 92);
        let lp_shares = rd_u64(&d, o + 64);
        if base == 0 && quote == 0 && lp_shares == 0 {
            continue;
        }
        if idx == perp_market_index && lp_shares == 0 {
            v.perp = Some(PerpPositionView { last_cumulative_funding_rate: rd_i64(&d, o), base_asset_amount: base, quote_asset_amount: quote, open_orders: d[o + 94] });
        } else {
            v.has_other_positions = true;
        }
    }
    Ok(v)
}

// ---------------------------------------------------------------- CPI

#[inline(always)]
fn check_program(p: &AccountView) -> Result<(), ProgramError> {
    if p.address() != &ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    Ok(())
}

pub struct InitUserAccounts<'a> {
    pub user: &'a AccountView,       // ["user", authority, sub_account_id u16 LE]
    pub user_stats: &'a AccountView, // ["user_stats", authority]
    pub state: &'a AccountView,      // ["drift_state"]
    pub authority: &'a AccountView,  // vault PDA (signer via seeds)
    pub payer: &'a AccountView,
    pub rent: &'a AccountView,
    pub system_program: &'a AccountView,
    pub drift_program: &'a AccountView,
}

#[inline(never)]
pub fn initialize_user_stats(a: &InitUserAccounts, signer: &[Signer]) -> Result<(), ProgramError> {
    check_program(a.drift_program)?;
    let metas = [
        InstructionAccount::writable(a.user_stats.address()),
        InstructionAccount::writable(a.state.address()),
        InstructionAccount::readonly_signer(a.authority.address()),
        InstructionAccount::writable_signer(a.payer.address()),
        InstructionAccount::readonly(a.rent.address()),
        InstructionAccount::readonly(a.system_program.address()),
    ];
    let ix = InstructionView { program_id: &ID, accounts: &metas, data: &disc::INITIALIZE_USER_STATS };
    invoke_signed::<6, &AccountView>(&ix, &[a.user_stats, a.state, a.authority, a.payer, a.rent, a.system_program], signer)
}

#[inline(never)]
pub fn initialize_user(a: &InitUserAccounts, sub_account_id: u16, name: &[u8; 32], signer: &[Signer]) -> Result<(), ProgramError> {
    check_program(a.drift_program)?;
    let mut data = [0u8; 8 + 2 + 32];
    data[..8].copy_from_slice(&disc::INITIALIZE_USER);
    data[8..10].copy_from_slice(&sub_account_id.to_le_bytes());
    data[10..42].copy_from_slice(name);
    let metas = [
        InstructionAccount::writable(a.user.address()),
        InstructionAccount::writable(a.user_stats.address()),
        InstructionAccount::writable(a.state.address()),
        InstructionAccount::readonly_signer(a.authority.address()),
        InstructionAccount::writable_signer(a.payer.address()),
        InstructionAccount::readonly(a.rent.address()),
        InstructionAccount::readonly(a.system_program.address()),
    ];
    let ix = InstructionView { program_id: &ID, accounts: &metas, data: &data };
    invoke_signed::<7, &AccountView>(&ix, &[a.user, a.user_stats, a.state, a.authority, a.payer, a.rent, a.system_program], signer)
}

/// Remaining accounts in Drift's canonical order: oracles, spot markets, perp markets.
pub struct MarketContext<'a> {
    pub oracles: &'a [&'a AccountView],
    pub spot_markets: &'a [&'a AccountView], // writable flags per klend-like table: quote spot writable on deposit/withdraw
    pub perp_markets: &'a [&'a AccountView],
}

const MAX_CPI: usize = 24;

#[inline(never)]
fn with_remaining<'a>(
    fixed_metas: &[InstructionAccount<'a>],
    fixed_views: &[&'a AccountView],
    ctx: &MarketContext<'a>,
    spot_writable: bool,
    perp_writable: bool,
    data: &[u8],
    signer: &[Signer],
) -> Result<(), ProgramError> {
    let mut metas: [core::mem::MaybeUninit<InstructionAccount<'a>>; MAX_CPI] = [const { core::mem::MaybeUninit::uninit() }; MAX_CPI];
    let mut views: [core::mem::MaybeUninit<&'a AccountView>; MAX_CPI] = [const { core::mem::MaybeUninit::uninit() }; MAX_CPI];
    let mut n = 0usize;
    let mut push = |m: InstructionAccount<'a>, v: &'a AccountView| -> Result<(), ProgramError> {
        if n >= MAX_CPI {
            return Err(VaultError::UnexpectedState.into());
        }
        metas[n].write(m);
        views[n].write(v);
        n += 1;
        Ok(())
    };
    for (m, v) in fixed_metas.iter().zip(fixed_views.iter()) {
        push(m.clone(), v)?;
    }
    for o in ctx.oracles {
        push(InstructionAccount::readonly(o.address()), o)?;
    }
    for s in ctx.spot_markets {
        push(if spot_writable { InstructionAccount::writable(s.address()) } else { InstructionAccount::readonly(s.address()) }, s)?;
    }
    for p in ctx.perp_markets {
        push(if perp_writable { InstructionAccount::writable(p.address()) } else { InstructionAccount::readonly(p.address()) }, p)?;
    }
    // SAFETY: first n entries initialized
    let metas: &[InstructionAccount<'a>] = unsafe { core::slice::from_raw_parts(metas.as_ptr() as *const InstructionAccount<'a>, n) };
    let views: &[&'a AccountView] = unsafe { core::slice::from_raw_parts(views.as_ptr() as *const &'a AccountView, n) };
    let ix = InstructionView { program_id: &ID, accounts: metas, data };
    invoke_signed_with_bounds::<MAX_CPI, &AccountView>(&ix, views, signer)
}

pub struct CollateralAccounts<'a> {
    pub state: &'a AccountView,
    pub user: &'a AccountView,
    pub user_stats: &'a AccountView,
    pub authority: &'a AccountView, // vault PDA
    pub spot_market_vault: &'a AccountView,
    pub drift_signer: &'a AccountView, // withdraw only
    pub user_token_account: &'a AccountView,
    pub token_program: &'a AccountView,
    pub drift_program: &'a AccountView,
}

/// deposit(market_index, amount, reduce_only=false) + remaining [oracles, spot(w), perps]
#[inline(never)]
pub fn deposit<'a>(a: &CollateralAccounts<'a>, ctx: &MarketContext<'a>, market_index: u16, amount: u64, signer: &[Signer]) -> Result<(), ProgramError> {
    check_program(a.drift_program)?;
    let mut data = [0u8; 8 + 2 + 8 + 1];
    data[..8].copy_from_slice(&disc::DEPOSIT);
    data[8..10].copy_from_slice(&market_index.to_le_bytes());
    data[10..18].copy_from_slice(&amount.to_le_bytes());
    data[18] = 0;
    let metas = [
        InstructionAccount::readonly(a.state.address()),
        InstructionAccount::writable(a.user.address()),
        InstructionAccount::writable(a.user_stats.address()),
        InstructionAccount::readonly_signer(a.authority.address()),
        InstructionAccount::writable(a.spot_market_vault.address()),
        InstructionAccount::writable(a.user_token_account.address()),
        InstructionAccount::readonly(a.token_program.address()),
    ];
    with_remaining(&metas, &[a.state, a.user, a.user_stats, a.authority, a.spot_market_vault, a.user_token_account, a.token_program], ctx, true, true, &data, signer)
}

/// withdraw(market_index, amount, reduce_only=true) + remaining [oracles, spot(w), perps(w)]
#[inline(never)]
pub fn withdraw<'a>(a: &CollateralAccounts<'a>, ctx: &MarketContext<'a>, market_index: u16, amount: u64, signer: &[Signer]) -> Result<(), ProgramError> {
    check_program(a.drift_program)?;
    let mut data = [0u8; 8 + 2 + 8 + 1];
    data[..8].copy_from_slice(&disc::WITHDRAW);
    data[8..10].copy_from_slice(&market_index.to_le_bytes());
    data[10..18].copy_from_slice(&amount.to_le_bytes());
    data[18] = 1;
    let metas = [
        InstructionAccount::readonly(a.state.address()),
        InstructionAccount::writable(a.user.address()),
        InstructionAccount::writable(a.user_stats.address()),
        InstructionAccount::readonly_signer(a.authority.address()),
        InstructionAccount::writable(a.spot_market_vault.address()),
        InstructionAccount::readonly(a.drift_signer.address()),
        InstructionAccount::writable(a.user_token_account.address()),
        InstructionAccount::readonly(a.token_program.address()),
    ];
    with_remaining(&metas, &[a.state, a.user, a.user_stats, a.authority, a.spot_market_vault, a.drift_signer, a.user_token_account, a.token_program], ctx, true, true, &data, signer)
}

pub struct OrderAccounts<'a> {
    pub state: &'a AccountView,
    pub user: &'a AccountView,
    pub user_stats: &'a AccountView,
    pub authority: &'a AccountView,
    pub drift_program: &'a AccountView,
}

/// place_and_take_perp_order(OrderParams{Market, Perp, direction, base_asset_amount, price=limit,
/// reduce_only, immediate-or-cancel bit}, success_condition=None). Fills against the vAMM in-ix.
#[inline(never)]
pub fn place_and_take_market<'a>(a: &OrderAccounts<'a>, ctx: &MarketContext<'a>, market_index: u16, short: bool, base_asset_amount: u64, limit_price: u64, reduce_only: bool, signer: &[Signer]) -> Result<(), ProgramError> {
    check_program(a.drift_program)?;
    // OrderParams (borsh)
    let mut data = [0u8; 8 + 64];
    let mut i = 0usize;
    let mut put = |b: &[u8]| { data[i..i + b.len()].copy_from_slice(b); i += b.len(); };
    put(&disc::PLACE_AND_TAKE_PERP_ORDER);
    put(&[0u8]); // order_type: Market
    put(&[1u8]); // market_type: Perp
    put(&[if short { 1 } else { 0 }]); // direction
    put(&[0u8]); // user_order_id
    put(&base_asset_amount.to_le_bytes());
    put(&limit_price.to_le_bytes());
    put(&market_index.to_le_bytes());
    put(&[reduce_only as u8]);
    put(&[0u8]); // post_only: None
    put(&[1u8]); // bit_flags: IMMEDIATE_OR_CANCEL
    put(&[0u8]); // max_ts: None
    put(&[0u8]); // trigger_price: None
    put(&[0u8]); // trigger_condition: Above
    put(&[0u8]); // oracle_price_offset: None
    put(&[1u8, 0u8]); // auction_duration: Some(0)
    put(&[0u8]); // auction_start_price: None
    put(&[0u8]); // auction_end_price: None
    put(&[0u8]); // success_condition: None
    let len = i;
    let metas = [
        InstructionAccount::readonly(a.state.address()),
        InstructionAccount::writable(a.user.address()),
        InstructionAccount::writable(a.user_stats.address()),
        InstructionAccount::readonly_signer(a.authority.address()),
    ];
    with_remaining(&metas, &[a.state, a.user, a.user_stats, a.authority], ctx, false, true, &data[..len], signer)
}

pub struct SettlePnlAccounts<'a> {
    pub state: &'a AccountView,
    pub user: &'a AccountView,
    pub authority: &'a AccountView,
    pub spot_market_vault: &'a AccountView,
    pub drift_program: &'a AccountView,
}

/// settle_pnl(market_index) + remaining [oracles, spot(w), perps(w)]
#[inline(never)]
pub fn settle_pnl<'a>(a: &SettlePnlAccounts<'a>, ctx: &MarketContext<'a>, market_index: u16, signer: &[Signer]) -> Result<(), ProgramError> {
    check_program(a.drift_program)?;
    let mut data = [0u8; 10];
    data[..8].copy_from_slice(&disc::SETTLE_PNL);
    data[8..10].copy_from_slice(&market_index.to_le_bytes());
    let metas = [
        InstructionAccount::readonly(a.state.address()),
        InstructionAccount::writable(a.user.address()),
        InstructionAccount::readonly_signer(a.authority.address()),
        InstructionAccount::readonly(a.spot_market_vault.address()),
    ];
    with_remaining(&metas, &[a.state, a.user, a.authority, a.spot_market_vault], ctx, true, true, &data, signer)
}

/// Maintenance-margin snapshot of the vault's Drift user (quote units, 1e6).
pub struct DriftHealth {
    pub total_collateral: i128,
    pub margin_requirement: u128,
    pub short_base: u64,
    pub oracle_price: i64,
    pub health_x100: u32,
}

#[inline(never)]
pub fn health(user: &UserView, perp: &PerpMarketView, spot: &SpotMarketView) -> Result<DriftHealth, ProgramError> {
    use dlp_math::drift as m;
    if user.has_other_positions || user.quote_is_borrow || user.margin_mode != 0 {
        return Err(VaultError::UnexpectedState.into());
    }
    let deposit = m::deposit_token_amount(user.quote_scaled_balance as u128, spot.cumulative_deposit_interest, spot.decimals).map_err(|_| VaultError::MathOverflow)?;
    // conservative: liabilities at max(oracle, 5-min twap), pnl at min
    let strict_hi = perp.last_oracle_price.max(perp.last_oracle_price_twap_5min);
    let strict_lo = perp.last_oracle_price.min(perp.last_oracle_price_twap_5min);
    let (leg, short_base) = match &user.perp {
        None => (m::PerpLeg::default(), 0u64),
        Some(p) => {
            let inputs = m::PerpInputs {
                base_asset_amount: p.base_asset_amount,
                quote_asset_amount: p.quote_asset_amount,
                last_cumulative_funding_rate: p.last_cumulative_funding_rate,
                cumulative_funding_rate_long: perp.cumulative_funding_rate_long,
                cumulative_funding_rate_short: perp.cumulative_funding_rate_short,
                oracle_price: strict_lo,
                margin_ratio_maintenance: perp.margin_ratio_maintenance,
                imf_factor: perp.imf_factor,
                unrealized_pnl_maintenance_asset_weight: perp.unrealized_pnl_maintenance_asset_weight,
                user_custom_margin_ratio: user.max_margin_ratio,
            };
            let mut leg = m::perp_leg_maintenance(&inputs).map_err(|_| VaultError::MathOverflow)?;
            // liability side at the strict-high price
            let hi_inputs = m::PerpInputs { oracle_price: strict_hi, ..inputs };
            let hi = m::perp_leg_maintenance(&hi_inputs).map_err(|_| VaultError::MathOverflow)?;
            leg.margin_requirement = hi.margin_requirement;
            leg.liability_value = hi.liability_value;
            (leg, p.base_asset_amount.unsigned_abs())
        }
    };
    let (tc, mm) = m::user_maintenance(deposit, &leg).map_err(|_| VaultError::MathOverflow)?;
    let health_x100 = if mm == 0 { u32::MAX } else if tc <= 0 { 0 } else { ((tc as u128).saturating_mul(100) / mm).min(u32::MAX as u128) as u32 };
    Ok(DriftHealth { total_collateral: tc, margin_requirement: mm, short_base, oracle_price: perp.last_oracle_price, health_x100 })
}
