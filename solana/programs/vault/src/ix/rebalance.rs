//! Crank phases on the CLMM leg: Begin (pull), Swap (recenter inventory), Place (new range).

use crate::{error::VaultError, ix::common::*, state::*, venue::whirlpool};
use pinocchio::{cpi::Seed, error::ProgramError, AccountView, Address, ProgramResult};

/// Parse the 16-account whirlpool liquidity block starting at `accounts[off]`:
/// off+0 whirlpool, +1 token_program_a, +2 token_program_b, +3 memo, +4 position, +5 position_token_account,
/// +6 mint_a, +7 mint_b, +8 base_ata (owner a), +9 quote_ata (owner b), +10 vault_a, +11 vault_b,
/// +12 tick_array_lower, +13 tick_array_upper, +14 whirlpool_program
fn liquidity_block<'a>(accounts: &'a [AccountView], off: usize, vault_acc: &'a AccountView, v: &Vault) -> Result<whirlpool::LiquidityAccounts<'a>, ProgramError> {
    let a = need(accounts, off + 15)?;
    let la = whirlpool::LiquidityAccounts {
        whirlpool: &a[off],
        token_program_a: &a[off + 1],
        token_program_b: &a[off + 2],
        memo_program: &a[off + 3],
        position_authority: vault_acc,
        position: &a[off + 4],
        position_token_account: &a[off + 5],
        token_mint_a: &a[off + 6],
        token_mint_b: &a[off + 7],
        token_owner_account_a: &a[off + 8],
        token_owner_account_b: &a[off + 9],
        token_vault_a: &a[off + 10],
        token_vault_b: &a[off + 11],
        tick_array_lower: &a[off + 12],
        tick_array_upper: &a[off + 13],
        whirlpool_program: &a[off + 14],
    };
    require_key(la.whirlpool, &v.whirlpool)?;
    require_key(la.token_mint_a, &v.base_mint)?;
    require_key(la.token_mint_b, &v.quote_mint)?;
    require_key(la.token_owner_account_a, &v.base_ata)?;
    require_key(la.token_owner_account_b, &v.quote_ata)?;
    if la.memo_program.address() != &whirlpool::MEMO_PROGRAM {
        return Err(VaultError::BadVenueAccount.into());
    }
    let wp = whirlpool::read_whirlpool(la.whirlpool)?;
    require_key(la.token_vault_a, &wp.token_vault_a)?;
    require_key(la.token_vault_b, &wp.token_vault_b)?;
    Ok(la)
}

/// BeginRebalance — data: [min_a u64][min_b u64]
/// accounts: 0 crank (s) 1 vault (w) 2.. liquidity block (15)
pub fn begin(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let accounts = views(accounts);
    let mut args = Args(data);
    let min_a = args.u64()?;
    let min_b = args.u64()?;
    let clock = clock()?;
    let crank = &need(accounts, 2)?[0];
    let vault_acc = &accounts[1];
    let (seeds, has_pos, liquidity) = {
        let d = vault_acc.try_borrow()?;
        let v = Vault::load(&d)?;
        check_vault_pda(program_id, vault_acc, v)?;
        require_crank(v, crank)?;
        v.require_phase(Phase::Idle)?;
        (VaultSeeds::from_vault(v), v.has_position(), v.liquidity())
    };
    if has_pos {
        let (la, position_key) = {
            let d = vault_acc.try_borrow()?;
            let v = Vault::load(&d)?;
            (liquidity_block(accounts, 2, vault_acc, v)?, v.position)
        };
        require_key(la.position, &position_key)?;
        let arr = seeds.seeds();
        let signer = signer_from(&arr);
        if liquidity > 0 {
            whirlpool::decrease_liquidity(&la, liquidity, min_a, min_b, &signer)?;
        } else {
            whirlpool::update_fees_and_rewards(&la)?;
        }
        whirlpool::collect_fees(&la, &signer)?;
        let p = whirlpool::read_position(la.position)?;
        if p.liquidity != 0 || p.fee_owed_a != 0 || p.fee_owed_b != 0 {
            return Err(VaultError::LeftoverLiquidity.into());
        }
    }
    let v = Vault::load_mut_acc(&vault_acc)?;
    v.set_liquidity(0);
    v.phase = Phase::Pulled as u8;
    v.set_phase_started_slot(clock.slot);
    Ok(())
}

/// Swap — data: [amount u64][other_threshold u64][sqrt_price_limit u128][amount_is_input u8][a_to_b u8]
/// accounts: 0 crank (s) 1 vault (w) 2 token_program_a 3 token_program_b 4 memo 5 whirlpool 6 mint_a 7 mint_b
///           8 base_ata (w) 9 vault_a (w) 10 quote_ata (w) 11 vault_b (w) 12 ta0 (w) 13 ta1 (w) 14 ta2 (w)
///           15 oracle (w) 16 whirlpool_program
/// Allowed in Pulled and Hedged. Guard: value moved ≤ max_swap_bps of equity at the last-synced price.
pub fn swap(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let accounts = need(views(accounts), 17)?;
    let mut args = Args(data);
    let amount = args.u64()?;
    let other_threshold = args.u64()?;
    let sqrt_limit = args.u128()?;
    let amount_is_input = args.u8()? != 0;
    let a_to_b = args.u8()? != 0;
    let crank = &accounts[0];
    let vault_acc = &accounts[1];
    let (seeds, price_e12, equity, max_swap_bps) = {
        let d = vault_acc.try_borrow()?;
        let v = Vault::load(&d)?;
        check_vault_pda(program_id, vault_acc, v)?;
        require_crank(v, crank)?;
        let ph = v.phase()?;
        if ph != Phase::Pulled && ph != Phase::Hedged {
            return Err(VaultError::WrongPhase.into());
        }
        require_key(&accounts[5], &v.whirlpool)?;
        require_key(&accounts[6], &v.base_mint)?;
        require_key(&accounts[7], &v.quote_mint)?;
        require_key(&accounts[8], &v.base_ata)?;
        require_key(&accounts[10], &v.quote_ata)?;
        (VaultSeeds::from_vault(v), v.oracle_price_raw_e12(), v.equity_q(), v.params.max_swap_bps())
    };
    let wp = whirlpool::read_whirlpool(&accounts[5])?;
    require_key(&accounts[9], &wp.token_vault_a)?;
    require_key(&accounts[11], &wp.token_vault_b)?;
    if accounts[4].address() != &whirlpool::MEMO_PROGRAM {
        return Err(VaultError::BadVenueAccount.into());
    }
    let base_before = token_amount(&accounts[8])?;
    let quote_before = token_amount(&accounts[10])?;
    let sa = whirlpool::SwapAccounts {
        token_program_a: &accounts[2],
        token_program_b: &accounts[3],
        memo_program: &accounts[4],
        token_authority: vault_acc,
        whirlpool: &accounts[5],
        token_mint_a: &accounts[6],
        token_mint_b: &accounts[7],
        token_owner_account_a: &accounts[8],
        token_vault_a: &accounts[9],
        token_owner_account_b: &accounts[10],
        token_vault_b: &accounts[11],
        tick_array_0: &accounts[12],
        tick_array_1: &accounts[13],
        tick_array_2: &accounts[14],
        oracle: &accounts[15],
        whirlpool_program: &accounts[16],
    };
    let arr = seeds.seeds();
    let signer = signer_from(&arr);
    whirlpool::swap(&sa, amount, other_threshold, sqrt_limit, amount_is_input, a_to_b, &signer)?;
    // notional guard at the last synced oracle price (crank can't churn the book)
    let base_after = token_amount(&accounts[8])?;
    let quote_after = token_amount(&accounts[10])?;
    let d_base = base_before.abs_diff(base_after);
    let d_quote = quote_before.abs_diff(quote_after);
    if max_swap_bps != 0 && price_e12 != 0 {
        let notional = (base_to_quote(d_base, price_e12)? as u128).max(d_quote as u128);
        if notional.saturating_mul(10_000) > (equity as u128).saturating_mul(max_swap_bps as u128) {
            return Err(VaultError::SwapTooLarge.into());
        }
    }
    Ok(())
}

/// Place — data: [tick_lower i32][tick_upper i32][liquidity u128][max_a u64][max_b u64]
/// accounts: 0 crank (w,s) 1 vault (w) 2 position_mint (w) 3 token_2022 4 system_program 5 ata_program
///           6 metadata_update_auth 7.. liquidity block (15)
/// Hedged → Placed. Reuses the existing (empty) position via reset_position_range, else opens one
/// with position_mint = PDA ["pmint", vault, epoch].
pub fn place(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let accounts = need(views(accounts), 22)?;
    let mut args = Args(data);
    let tick_lower = args.i32()?;
    let tick_upper = args.i32()?;
    let liquidity = args.u128()?;
    let max_a = args.u64()?;
    let max_b = args.u64()?;
    if liquidity == 0 || tick_lower >= tick_upper {
        return Err(ProgramError::InvalidInstructionData);
    }
    let crank = &accounts[0];
    let vault_acc = &accounts[1];
    let position_mint = &accounts[2];
    let (seeds, has_pos, position_key, epoch) = {
        let d = vault_acc.try_borrow()?;
        let v = Vault::load(&d)?;
        check_vault_pda(program_id, vault_acc, v)?;
        require_crank(v, crank)?;
        v.require_phase(Phase::Hedged)?;
        (VaultSeeds::from_vault(v), v.has_position(), v.position, v.epoch())
    };
    let la = {
        let d = vault_acc.try_borrow()?;
        let v = Vault::load(&d)?;
        liquidity_block(accounts, 7, vault_acc, v)?
    };
    let wp = whirlpool::read_whirlpool(la.whirlpool)?;
    if tick_lower % wp.tick_spacing as i32 != 0 || tick_upper % wp.tick_spacing as i32 != 0 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let arr = seeds.seeds();
    let signer = signer_from(&arr);

    if has_pos {
        require_key(la.position, &position_key)?;
        let p = whirlpool::read_position(la.position)?;
        if p.liquidity != 0 {
            return Err(VaultError::LeftoverLiquidity.into());
        }
        if p.tick_lower_index != tick_lower || p.tick_upper_index != tick_upper {
            whirlpool::reset_position_range(
                &whirlpool::ResetRangeAccounts { funder: crank, position_authority: vault_acc, whirlpool: la.whirlpool, position: la.position, position_token_account: la.position_token_account, system_program: &accounts[4], whirlpool_program: la.whirlpool_program },
                tick_lower,
                tick_upper,
                &signer,
            )?;
        }
    } else {
        // fresh position: mint is our PDA so no client keypair is needed
        let (pm, pm_bump) = derive_pmint(program_id, vault_acc.address(), epoch);
        if position_mint.address() != &pm {
            return Err(VaultError::BadPda.into());
        }
        let (pos, _) = Address::find_program_address(&[b"position".as_ref(), pm.as_array().as_ref()], &whirlpool::ID);
        if la.position.address() != &pos {
            return Err(VaultError::BadPda.into());
        }
        let epoch_b = epoch.to_le_bytes();
        let pmb = [pm_bump];
        let pm_seeds = [Seed::from(seeds::PMINT), Seed::from(vault_acc.address().as_array()), Seed::from(&epoch_b), Seed::from(&pmb)];
        let signers = [pinocchio::cpi::Signer::from(&arr), pinocchio::cpi::Signer::from(&pm_seeds)];
        whirlpool::open_position(
            &whirlpool::OpenPositionAccounts {
                funder: crank,
                owner: vault_acc,
                position: la.position,
                position_mint,
                position_token_account: la.position_token_account,
                whirlpool: la.whirlpool,
                token_2022_program: &accounts[3],
                system_program: &accounts[4],
                associated_token_program: &accounts[5],
                metadata_update_auth: &accounts[6],
                whirlpool_program: la.whirlpool_program,
            },
            tick_lower,
            tick_upper,
            &signers,
        )?;
    }
    whirlpool::increase_liquidity(&la, liquidity, max_a, max_b, &signer)?;
    let p = whirlpool::read_position(la.position)?;
    if p.liquidity != liquidity || p.tick_lower_index != tick_lower || p.tick_upper_index != tick_upper || p.whirlpool != wp_key(la.whirlpool) {
        return Err(VaultError::UnexpectedState.into());
    }
    let v = Vault::load_mut_acc(&vault_acc)?;
    v.position = *la.position.address().as_array();
    v.position_mint = p.position_mint;
    v.set_tick_lower(tick_lower);
    v.set_tick_upper(tick_upper);
    v.set_liquidity(liquidity);
    v.phase = Phase::Placed as u8;
    Ok(())
}

#[inline(always)]
fn wp_key(a: &AccountView) -> [u8; 32] {
    *a.address().as_array()
}
