//! HedgeDrift — resize the perp short on Drift/Velocity: deposit/withdraw quote collateral,
//! place_and_take a market order for the base delta. Pulled → Hedged.
//! ABI-verified; not exercised against a live venue (see venue/drift.rs).

use crate::{
    error::VaultError,
    ix::common::*,
    state::*,
    venue::drift,
};
use pinocchio::{error::ProgramError, AccountView, Address, ProgramResult};

/// data: [collateral_delta i64 (quote units)][base_delta i64 (base units, + = increase short, − = reduce)]
///       [limit_price u64 (PRICE_PRECISION, 0 = none)]
///
/// accounts:
///  0 crank (s)        1 vault (w)          2 quote_ata (w)     3 drift_program
///  4 state            5 user (w)           6 user_stats (w)    7 spot_market_vault (w)
///  8 drift_signer     9 token_program      10 perp_market (w)  11 quote_spot_market (w)
///  12 perp_oracle     13 quote_oracle
pub fn hedge(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let accounts = need(views(accounts), 14)?;
    let mut args = Args(data);
    let collateral_delta = args.i64()?;
    let base_delta = args.i64()?;
    let limit_price = args.u64()?;
    let crank = &accounts[0];
    let vault_acc = &accounts[1];
    let quote_ata = &accounts[2];
    let drift_program = &accounts[3];
    let state = &accounts[4];
    let user = &accounts[5];
    let user_stats = &accounts[6];
    let spot_market_vault = &accounts[7];
    let drift_signer = &accounts[8];
    let token_program = &accounts[9];
    let perp_market = &accounts[10];
    let quote_spot_market = &accounts[11];
    let perp_oracle = &accounts[12];
    let quote_oracle = &accounts[13];

    let (seeds, min_health, base_dec) = {
        let d = vault_acc.try_borrow()?;
        let v = Vault::load(&d)?;
        check_vault_pda(program_id, vault_acc, v)?;
        require_crank(v, crank)?;
        if v.hedge_kind()? != HedgeKind::Drift {
            return Err(VaultError::HedgeKindMismatch.into());
        }
        let ph = v.phase()?;
        if ph != Phase::Pulled && ph != Phase::Hedged {
            return Err(VaultError::WrongPhase.into());
        }
        require_key(quote_ata, &v.quote_ata)?;
        require_key(user, &v.hedge_account)?;
        require_key(perp_market, &v.hedge_market)?;
        require_key(quote_spot_market, &v.hedge_quote)?;
        (VaultSeeds::from_vault(v), v.params.min_health_x100(), v.base_decimals)
    };
    if drift_program.address() != &drift::ID || token_program.address() != &TOKEN_PROGRAM {
        return Err(ProgramError::IncorrectProgramId);
    }
    let pm = drift::read_perp_market(perp_market)?;
    let sm = drift::read_spot_market(quote_spot_market)?;
    require_key(perp_oracle, &pm.oracle)?;
    require_key(quote_oracle, &sm.oracle)?;
    require_key(spot_market_vault, &sm.vault)?;
    let (state_pda, _) = Address::find_program_address(&[b"drift_state".as_ref()], &drift::ID);
    let (signer_pda, _) = Address::find_program_address(&[b"drift_signer".as_ref()], &drift::ID);
    if state.address() != &state_pda || drift_signer.address() != &signer_pda {
        return Err(VaultError::BadPda.into());
    }
    let (us, _) = Address::find_program_address(&[b"user_stats".as_ref(), vault_acc.address().as_array().as_ref()], &drift::ID);
    if user_stats.address() != &us {
        return Err(VaultError::BadPda.into());
    }

    let arr = seeds.seeds();
    let signer = signer_from(&arr);
    let oracles: [&AccountView; 2] = [perp_oracle, quote_oracle];
    let spots: [&AccountView; 1] = [quote_spot_market];
    let perps: [&AccountView; 1] = [perp_market];
    let ctx = drift::MarketContext { oracles: &oracles, spot_markets: &spots, perp_markets: &perps };
    let coll = drift::CollateralAccounts { state, user, user_stats, authority: vault_acc, spot_market_vault, drift_signer, user_token_account: quote_ata, token_program, drift_program };

    if collateral_delta > 0 {
        drift::deposit(&coll, &ctx, sm.market_index, collateral_delta as u64, &signer)?;
    }
    if base_delta != 0 {
        // base delta is in mint units; drift base is 1e9-scaled
        let amt = to_drift_base(base_delta.unsigned_abs(), base_dec)?;
        let amt = amt - amt % pm.order_step_size.max(1);
        if amt > 0 {
            let short = base_delta > 0; // increase short = sell; reduce short = buy
            drift::place_and_take_market(&drift::OrderAccounts { state, user, user_stats, authority: vault_acc, drift_program }, &ctx, pm.market_index, short, amt, limit_price, !short, &signer)?;
        }
    }
    if collateral_delta < 0 {
        drift::withdraw(&coll, &ctx, sm.market_index, collateral_delta.unsigned_abs(), &signer)?;
    }

    let uv = drift::read_user(user, sm.market_index, pm.market_index)?;
    let pm2 = drift::read_perp_market(perp_market)?;
    let h = drift::health(&uv, &pm2, &sm)?;
    if uv.open_orders != 0 {
        return Err(VaultError::UnexpectedState.into());
    }
    if let Some(p) = &uv.perp {
        if p.base_asset_amount > 0 {
            return Err(VaultError::UnexpectedState.into()); // never net long on the hedge leg
        }
    }
    if h.health_x100 < min_health as u32 {
        return Err(VaultError::UnderHealth.into());
    }
    let v = Vault::load_mut_acc(&vault_acc)?;
    v.set_hedge_base_amount(from_drift_base(h.short_base, base_dec)?);
    v.set_health_x100(h.health_x100);
    v.phase = Phase::Hedged as u8;
    Ok(())
}

fn to_drift_base(amount: u64, decimals: u8) -> Result<u64, ProgramError> {
    if decimals == 9 {
        Ok(amount)
    } else if decimals < 9 {
        amount.checked_mul(10u64.pow((9 - decimals) as u32)).ok_or(VaultError::MathOverflow.into())
    } else {
        Ok(amount / 10u64.pow((decimals - 9) as u32))
    }
}

fn from_drift_base(amount: u64, decimals: u8) -> Result<u64, ProgramError> {
    if decimals == 9 {
        Ok(amount)
    } else if decimals < 9 {
        Ok(amount / 10u64.pow((9 - decimals) as u32))
    } else {
        amount.checked_mul(10u64.pow((decimals - 9) as u32)).ok_or(VaultError::MathOverflow.into())
    }
}
