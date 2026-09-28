//! Authority-only knobs. The authority can rotate the crank and tighten/loosen guard params;
//! it can never move funds, mint, or bypass the phase machine.

use crate::{ix::common::*, state::*};
use pinocchio::{AccountView, Address, ProgramResult};

/// accounts: 0 authority (s) 1 vault (w). data: [new_crank 32]
pub fn set_crank(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let accounts = need(views(accounts), 2)?;
    let new_crank = Args(data).pk()?;
    let v = Vault::load_mut_acc(&accounts[1])?;
    check_vault_pda(program_id, &accounts[1], v)?;
    require_authority(v, &accounts[0])?;
    v.crank = new_crank;
    Ok(())
}

/// accounts: 0 authority (s) 1 vault (w). data: [params 16]
pub fn set_params(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let accounts = need(views(accounts), 2)?;
    let params = Params::from_bytes(data)?;
    let v = Vault::load_mut_acc(&accounts[1])?;
    check_vault_pda(program_id, &accounts[1], v)?;
    require_authority(v, &accounts[0])?;
    v.require_phase(Phase::Idle)?;
    v.params = params;
    Ok(())
}
