//! Deposit / Withdraw at NAV. Requires phase Idle and a Sync in the current slot.

use crate::{error::VaultError, ix::common::*, state::*};
use pinocchio::{error::ProgramError, AccountView, Address, ProgramResult};
use pinocchio_token::instructions::{Burn, MintTo, Transfer};

/// accounts: 0 user (s) 1 vault (w) 2 user_quote_ata (w) 3 vault_quote_ata (w) 4 receipt_mint (w)
///           5 user_receipt_ata (w) 6 token_program
/// data: [amount_q u64][min_receipt_out u64]
pub fn deposit(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let accounts = need(views(accounts), 7)?;
    let mut args = Args(data);
    let amount = args.u64()?;
    let min_out = args.u64()?;
    if amount == 0 {
        return Err(VaultError::ZeroAmount.into());
    }
    let user = &accounts[0];
    let vault_acc = &accounts[1];
    let user_quote = &accounts[2];
    let vault_quote = &accounts[3];
    let receipt_mint = &accounts[4];
    let user_receipt = &accounts[5];
    let token_program = &accounts[6];
    require_signer(user)?;
    if token_program.address() != &TOKEN_PROGRAM {
        return Err(ProgramError::IncorrectProgramId);
    }
    let clock = clock()?;

    let (out, seeds) = {
        let d = vault_acc.try_borrow()?;
        let v = Vault::load(&d)?;
        check_vault_pda(program_id, vault_acc, v)?;
        v.require_phase(Phase::Idle)?;
        require_key(vault_quote, &v.quote_ata)?;
        require_key(receipt_mint, &v.receipt_mint)?;
        if v.sync_slot() != clock.slot {
            return Err(VaultError::StaleSync.into());
        }
        if v.flags != 0 {
            return Err(if v.flags & FLAG_UNDER_HEALTH != 0 { VaultError::UnderHealth } else { VaultError::PriceDeviation }.into());
        }
        let supply = mint_supply(receipt_mint)?;
        if supply != v.receipt_supply() {
            return Err(VaultError::ReceiptMintMismatch.into());
        }
        let out: u64 = if supply == 0 || v.equity_q() == 0 {
            // bootstrap: 1 receipt (6dp) per quote unit (6dp assumed; other decimals rescale)
            rescale(amount, v.quote_decimals, RECEIPT_DECIMALS)?
        } else {
            let o = dlp_math::u256::mul_div_u128(amount as u128, supply as u128, v.equity_q() as u128).ok_or(VaultError::MathOverflow)?;
            u64::try_from(o).map_err(|_| VaultError::MathOverflow)?
        };
        if out < min_out || out == 0 {
            return Err(VaultError::SlippageExceeded.into());
        }
        let cap = v.params.max_mint_bps();
        if cap != 0 && supply != 0 {
            let allowed = (v.epoch_supply_start() as u128).saturating_mul(cap as u128) / 10_000;
            if (v.epoch_minted() as u128).saturating_add(out as u128) > allowed {
                return Err(VaultError::EpochMintCap.into());
            }
        }
        (out, VaultSeeds::from_vault(v))
    };

    // quote: user → vault (user signs)
    Transfer::new(user_quote, vault_quote, user, amount).invoke()?;
    // receipt: mint to user (vault PDA signs)
    let arr = seeds.seeds();
    let signer = signer_from(&arr);
    MintTo::new(receipt_mint, user_receipt, vault_acc, out).invoke_signed(&signer)?;

    let v = Vault::load_mut_acc(&vault_acc)?;
    v.set_equity_q(v.equity_q().checked_add(amount).ok_or(VaultError::MathOverflow)?);
    v.set_receipt_supply(v.receipt_supply().checked_add(out).ok_or(VaultError::MathOverflow)?);
    v.set_epoch_minted(v.epoch_minted().saturating_add(out));
    Ok(())
}

/// accounts: same as deposit. data: [receipt_amount u64][min_quote_out u64]
pub fn withdraw(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let accounts = need(views(accounts), 7)?;
    let mut args = Args(data);
    let receipt_amount = args.u64()?;
    let min_out = args.u64()?;
    if receipt_amount == 0 {
        return Err(VaultError::ZeroAmount.into());
    }
    let user = &accounts[0];
    let vault_acc = &accounts[1];
    let user_quote = &accounts[2];
    let vault_quote = &accounts[3];
    let receipt_mint = &accounts[4];
    let user_receipt = &accounts[5];
    let token_program = &accounts[6];
    require_signer(user)?;
    if token_program.address() != &TOKEN_PROGRAM {
        return Err(ProgramError::IncorrectProgramId);
    }
    let clock = clock()?;

    let (out, seeds) = {
        let d = vault_acc.try_borrow()?;
        let v = Vault::load(&d)?;
        check_vault_pda(program_id, vault_acc, v)?;
        v.require_phase(Phase::Idle)?;
        require_key(vault_quote, &v.quote_ata)?;
        require_key(receipt_mint, &v.receipt_mint)?;
        if v.sync_slot() != clock.slot {
            return Err(VaultError::StaleSync.into());
        }
        // price deviation makes NAV unreliable; under-health is still a valid exit
        if v.flags & FLAG_PRICE_DEVIATION != 0 {
            return Err(VaultError::PriceDeviation.into());
        }
        let supply = mint_supply(receipt_mint)?;
        if supply != v.receipt_supply() || supply == 0 {
            return Err(VaultError::ReceiptMintMismatch.into());
        }
        let o = dlp_math::u256::mul_div_u128(receipt_amount as u128, v.equity_q() as u128, supply as u128).ok_or(VaultError::MathOverflow)?;
        let out = u64::try_from(o).map_err(|_| VaultError::MathOverflow)?;
        if out < min_out || out == 0 {
            return Err(VaultError::SlippageExceeded.into());
        }
        if token_amount(vault_quote)? < out {
            return Err(VaultError::InsufficientIdleQuote.into());
        }
        let cap = v.params.max_burn_bps();
        if cap != 0 {
            let allowed = (v.epoch_supply_start() as u128).saturating_mul(cap as u128) / 10_000;
            if (v.epoch_burned() as u128).saturating_add(receipt_amount as u128) > allowed {
                return Err(VaultError::EpochBurnCap.into());
            }
        }
        (out, VaultSeeds::from_vault(v))
    };

    Burn::new(user_receipt, receipt_mint, user, receipt_amount).invoke()?;
    let arr = seeds.seeds();
    let signer = signer_from(&arr);
    Transfer::new(vault_quote, user_quote, vault_acc, out).invoke_signed(&signer)?;

    let v = Vault::load_mut_acc(&vault_acc)?;
    v.set_equity_q(v.equity_q().checked_sub(out).ok_or(VaultError::MathOverflow)?);
    v.set_receipt_supply(v.receipt_supply().checked_sub(receipt_amount).ok_or(VaultError::MathOverflow)?);
    v.set_epoch_burned(v.epoch_burned().saturating_add(receipt_amount));
    Ok(())
}

fn rescale(amount: u64, from_dec: u8, to_dec: u8) -> Result<u64, ProgramError> {
    if from_dec == to_dec {
        Ok(amount)
    } else if from_dec > to_dec {
        Ok(amount / 10u64.pow((from_dec - to_dec) as u32))
    } else {
        amount.checked_mul(10u64.pow((to_dec - from_dec) as u32)).ok_or(VaultError::MathOverflow.into())
    }
}
