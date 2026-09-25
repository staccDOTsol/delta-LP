//! HedgeKlend — resize the borrow leg: deposit/withdraw quote collateral, borrow/repay base.
//! Pulled → Hedged (or Hedged → Hedged for a second adjustment). Every klend op is preceded by
//! the refreshes it needs, all as CPIs in this instruction (v2 ixs, no introspection).

use crate::{error::VaultError, ix::common::*, state::*, venue::klend};
use pinocchio::{error::ProgramError, AccountView, Address, ProgramResult};

/// data: [collateral_delta i64 (quote units, +deposit/−withdraw)][debt_delta i64 (base units, +borrow/−repay)]
///
/// accounts:
///  0 crank (s)            1 vault (w)             2 quote_ata (w)         3 base_ata (w)
///  4 klend_program        5 lending_market        6 lending_market_authority
///  7 obligation (w)       8 quote_reserve (w)     9 base_reserve (w)      10 scope_prices
///  11 quote_liq_mint      12 quote_liq_supply (w) 13 quote_coll_mint (w)  14 quote_coll_supply (w)
///  15 quote_farm_user (w|klend) 16 quote_farm_state (w|klend)
///  17 base_liq_mint       18 base_liq_supply (w)  19 base_fee_vault (w)
///  20 base_farm_user (w|klend)  21 base_farm_state (w|klend)
///  22 farms_program       23 token_program        24 sysvar_instructions
pub fn hedge(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let accounts = need(views(accounts), 25)?;
    let mut args = Args(data);
    let collateral_delta = args.i64()?;
    let debt_delta = args.i64()?;
    let crank = &accounts[0];
    let vault_acc = &accounts[1];
    let quote_ata = &accounts[2];
    let base_ata = &accounts[3];
    let klend_program = &accounts[4];
    let lending_market = &accounts[5];
    let lma = &accounts[6];
    let obligation = &accounts[7];
    let quote_reserve = &accounts[8];
    let base_reserve = &accounts[9];
    let scope_prices = &accounts[10];
    let farms_program = &accounts[22];
    let token_program = &accounts[23];
    let sysvar_ix = &accounts[24];

    let seeds = {
        let d = vault_acc.try_borrow()?;
        let v = Vault::load(&d)?;
        check_vault_pda(program_id, vault_acc, v)?;
        require_crank(v, crank)?;
        if v.hedge_kind()? != HedgeKind::Klend {
            return Err(VaultError::HedgeKindMismatch.into());
        }
        let ph = v.phase()?;
        if ph != Phase::Pulled && ph != Phase::Hedged {
            return Err(VaultError::WrongPhase.into());
        }
        require_key(quote_ata, &v.quote_ata)?;
        require_key(base_ata, &v.base_ata)?;
        require_key(lending_market, &v.hedge_market)?;
        require_key(obligation, &v.hedge_account)?;
        require_key(quote_reserve, &v.hedge_quote)?;
        require_key(base_reserve, &v.hedge_base)?;
        VaultSeeds::from_vault(v)
    };
    if farms_program.address() != &klend::FARMS_PROGRAM || sysvar_ix.address() != &klend::SYSVAR_INSTRUCTIONS || token_program.address() != &TOKEN_PROGRAM {
        return Err(VaultError::BadVenueAccount.into());
    }
    let (lma_pda, _) = Address::find_program_address(&[b"lma".as_ref(), lending_market.address().as_array().as_ref()], &klend::ID);
    if lma.address() != &lma_pda {
        return Err(VaultError::BadPda.into());
    }
    let rq = klend::read_reserve(quote_reserve)?;
    let rb = klend::read_reserve(base_reserve)?;
    klend::check_scope_only(&rq, scope_prices)?;
    klend::check_scope_only(&rb, scope_prices)?;
    require_key(&accounts[11], &rq.liquidity_mint)?;
    require_key(&accounts[12], &rq.liquidity_supply)?;
    require_key(&accounts[13], &rq.collateral_mint)?;
    require_key(&accounts[14], &rq.collateral_supply)?;
    require_key(&accounts[17], &rb.liquidity_mint)?;
    require_key(&accounts[18], &rb.liquidity_supply)?;
    require_key(&accounts[19], &rb.fee_vault)?;

    let arr = seeds.seeds();
    let signer = signer_from(&arr);
    let refresh_all = || -> Result<(), ProgramError> {
        klend::refresh_reserve(&klend::RefreshReserveAccounts { reserve: quote_reserve, lending_market, klend_program, scope_prices })?;
        klend::refresh_reserve(&klend::RefreshReserveAccounts { reserve: base_reserve, lending_market, klend_program, scope_prices })?;
        klend::refresh_obligation(klend_program, lending_market, obligation, &[quote_reserve, base_reserve])
    };
    let coll = klend::CollateralAccounts {
        owner: vault_acc,
        obligation,
        lending_market,
        lending_market_authority: lma,
        reserve: quote_reserve,
        reserve_liquidity_mint: &accounts[11],
        reserve_liquidity_supply: &accounts[12],
        reserve_collateral_mint: &accounts[13],
        reserve_collateral_supply: &accounts[14],
        user_liquidity: quote_ata,
        klend_program,
        token_program,
        sysvar_instructions: sysvar_ix,
        farms: klend::FarmAccounts { obligation_farm_user_state: &accounts[15], reserve_farm_state: &accounts[16] },
        farms_program,
    };
    let debt = klend::DebtAccounts {
        owner: vault_acc,
        obligation,
        lending_market,
        lending_market_authority: lma,
        reserve: base_reserve,
        reserve_liquidity_mint: &accounts[17],
        reserve_liquidity_supply: &accounts[18],
        reserve_fee_receiver: &accounts[19],
        user_liquidity: base_ata,
        klend_program,
        token_program,
        sysvar_instructions: sysvar_ix,
        farms: klend::FarmAccounts { obligation_farm_user_state: &accounts[20], reserve_farm_state: &accounts[21] },
        farms_program,
    };

    // order: add collateral → repay → borrow → remove collateral (never lets health dip mid-way)
    if collateral_delta > 0 {
        refresh_all()?;
        klend::deposit_collateral(&coll, collateral_delta as u64, &signer)?;
    }
    if debt_delta < 0 {
        refresh_all()?;
        klend::repay(&debt, debt_delta.unsigned_abs(), &signer)?;
    }
    if debt_delta > 0 {
        refresh_all()?;
        klend::borrow(&debt, debt_delta as u64, &signer)?;
    }
    if collateral_delta < 0 {
        refresh_all()?;
        // withdraw takes cTokens; convert at the freshly refreshed exchange rate
        let rq = klend::read_reserve(quote_reserve)?;
        let ctokens = rq.liquidity_to_ctokens_ceil(collateral_delta.unsigned_abs())?;
        klend::withdraw_collateral(&coll, ctokens, &signer)?;
    }

    // post-state: obligation health vs params (klend's own LTV check already passed).
    // A full unwind closes the obligation (klend returns its rent to the vault PDA).
    let (health, hedge_base) = if klend::obligation_is_open(obligation) {
        refresh_all()?;
        (klend::read_obligation(obligation)?.health_x100(), klend::obligation_debt_amount(obligation, base_reserve.address().as_array())?)
    } else {
        (u32::MAX, 0)
    };
    let v = Vault::load_mut_acc(&vault_acc)?;
    if health < v.params.min_health_x100() as u32 {
        return Err(VaultError::UnderHealth.into());
    }
    v.set_hedge_base_amount(hedge_base);
    v.set_health_x100(health);
    v.phase = Phase::Hedged as u8;
    Ok(())
}
