//! dlp-vault — one receipt over (tight-range CLMM LP) + (base hedge), rebalanced as one object.
//!
//! Legs:  CLMM = Orca Whirlpool.  Hedge = Kamino Lend borrow (live) | Drift/Velocity perp short.
//! Receipt = plain SPL mint (LP-able / routable anywhere, no hook gating).
//!
//! Phase machine (crank-driven, atomic across transactions through the phase guard):
//!   Idle ─Begin→ Pulled ─Hedge→ Hedged ─Place→ Placed ─End→ Idle
//! Deposit / Withdraw only in Idle and only in a slot where Sync ran (NAV is never stale).
#![no_std]
#![allow(clippy::too_many_arguments)]

pub mod error;
pub mod ix;
pub mod state;
pub mod venue;

use pinocchio::{error::ProgramError, AccountView, Address, ProgramResult};

#[cfg(not(feature = "no-entrypoint"))]
mod entrypoint {
    pinocchio::program_entrypoint!(super::process_instruction);
    pinocchio::default_allocator!();
    pinocchio::nostd_panic_handler!();
}

pub mod instruction {
    pub const INIT_VAULT: u8 = 0;
    pub const DEPOSIT: u8 = 1;
    pub const WITHDRAW: u8 = 2;
    pub const SYNC: u8 = 3;
    pub const BEGIN_REBALANCE: u8 = 4;
    pub const SWAP: u8 = 5;
    pub const HEDGE_KLEND: u8 = 6;
    pub const PLACE: u8 = 7;
    pub const END_REBALANCE: u8 = 8;
    pub const SET_CRANK: u8 = 9;
    pub const SET_PARAMS: u8 = 10;
    pub const INIT_FARMS: u8 = 11;
    pub const HEDGE_DRIFT: u8 = 12;
    pub const REOPEN_OBLIGATION: u8 = 13;
}

pub fn process_instruction(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let (&tag, rest) = data.split_first().ok_or(ProgramError::InvalidInstructionData)?;
    match tag {
        instruction::INIT_VAULT => ix::init::init_vault(program_id, accounts, rest),
        instruction::DEPOSIT => ix::user::deposit(program_id, accounts, rest),
        instruction::WITHDRAW => ix::user::withdraw(program_id, accounts, rest),
        instruction::SYNC => ix::sync::sync(program_id, accounts, rest),
        instruction::BEGIN_REBALANCE => ix::rebalance::begin(program_id, accounts, rest),
        instruction::SWAP => ix::rebalance::swap(program_id, accounts, rest),
        instruction::HEDGE_KLEND => ix::hedge_klend::hedge(program_id, accounts, rest),
        instruction::PLACE => ix::rebalance::place(program_id, accounts, rest),
        instruction::END_REBALANCE => ix::sync::end_rebalance(program_id, accounts, rest),
        instruction::SET_CRANK => ix::admin::set_crank(program_id, accounts, rest),
        instruction::SET_PARAMS => ix::admin::set_params(program_id, accounts, rest),
        instruction::INIT_FARMS => ix::init::init_farms(program_id, accounts, rest),
        instruction::HEDGE_DRIFT => ix::hedge_drift::hedge(program_id, accounts, rest),
        instruction::REOPEN_OBLIGATION => ix::init::reopen_obligation(program_id, accounts, rest),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}
