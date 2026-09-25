//! Orca Whirlpool adapter — hand-rolled CPI (Anchor discriminators from the deployed IDL,
//! account orders verified against the whirlpools-sdk 0.22 IDL) and zero-copy readers
//! (offsets verified against live SOL/USDC pools on 2026-09-25).

use crate::error::VaultError;
use pinocchio::{
    cpi::{invoke_signed, Signer},
    error::ProgramError,
    instruction::{InstructionAccount, InstructionView},
    AccountView, Address,
};

pub const ID: Address = Address::from_str_const("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
pub const MEMO_PROGRAM: Address = Address::from_str_const("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
pub const METADATA_UPDATE_AUTH: Address = Address::from_str_const("3axbTs2z5GBy6usVbNVoqEgZMng3vZvMnAoX29BFfwhr");
pub const TOKEN_2022: Address = Address::from_str_const("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const ATA_PROGRAM: Address = Address::from_str_const("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const SYSTEM_PROGRAM: Address = Address::from_str_const("11111111111111111111111111111111");

pub const WHIRLPOOL_DISC: [u8; 8] = [63, 149, 209, 12, 225, 128, 99, 9];
pub const POSITION_DISC: [u8; 8] = [170, 188, 143, 228, 122, 64, 247, 208];

mod disc {
    pub const OPEN_POSITION_WITH_TOKEN_EXTENSIONS: [u8; 8] = [212, 47, 95, 92, 114, 102, 131, 250];
    pub const INCREASE_LIQUIDITY_V2: [u8; 8] = [133, 29, 89, 223, 69, 238, 176, 10];
    pub const DECREASE_LIQUIDITY_V2: [u8; 8] = [58, 127, 188, 62, 79, 82, 196, 96];
    pub const COLLECT_FEES_V2: [u8; 8] = [207, 117, 95, 191, 229, 180, 226, 15];
    pub const SWAP_V2: [u8; 8] = [43, 4, 237, 11, 26, 201, 30, 98];
    pub const RESET_POSITION_RANGE: [u8; 8] = [164, 123, 180, 141, 194, 100, 160, 175];
    pub const UPDATE_FEES_AND_REWARDS: [u8; 8] = [154, 230, 250, 13, 236, 209, 75, 223];
}

// ---------------------------------------------------------------- readers

#[inline(always)]
fn rd_u16(d: &[u8], o: usize) -> u16 { u16::from_le_bytes(d[o..o + 2].try_into().unwrap()) }
#[inline(always)]
fn rd_i32(d: &[u8], o: usize) -> i32 { i32::from_le_bytes(d[o..o + 4].try_into().unwrap()) }
#[inline(always)]
fn rd_u64(d: &[u8], o: usize) -> u64 { u64::from_le_bytes(d[o..o + 8].try_into().unwrap()) }
#[inline(always)]
fn rd_u128(d: &[u8], o: usize) -> u128 { u128::from_le_bytes(d[o..o + 16].try_into().unwrap()) }
#[inline(always)]
fn rd_pk(d: &[u8], o: usize) -> [u8; 32] { d[o..o + 32].try_into().unwrap() }

pub struct WhirlpoolView {
    pub tick_spacing: u16,
    pub fee_rate: u16,
    pub liquidity: u128,
    pub sqrt_price: u128,
    pub tick_current_index: i32,
    pub token_mint_a: [u8; 32],
    pub token_vault_a: [u8; 32],
    pub token_mint_b: [u8; 32],
    pub token_vault_b: [u8; 32],
}

#[inline(never)]
pub fn read_whirlpool(acc: &AccountView) -> Result<WhirlpoolView, ProgramError> {
    if acc.owner() != &ID {
        return Err(VaultError::BadVenueAccount.into());
    }
    let d = acc.try_borrow()?;
    if d.len() < 653 || d[..8] != WHIRLPOOL_DISC {
        return Err(VaultError::BadVenueAccount.into());
    }
    Ok(WhirlpoolView {
        tick_spacing: rd_u16(&d, 41),
        fee_rate: rd_u16(&d, 45),
        liquidity: rd_u128(&d, 49),
        sqrt_price: rd_u128(&d, 65),
        tick_current_index: rd_i32(&d, 81),
        token_mint_a: rd_pk(&d, 101),
        token_vault_a: rd_pk(&d, 133),
        token_mint_b: rd_pk(&d, 181),
        token_vault_b: rd_pk(&d, 213),
    })
}

pub struct PositionView {
    pub whirlpool: [u8; 32],
    pub position_mint: [u8; 32],
    pub liquidity: u128,
    pub tick_lower_index: i32,
    pub tick_upper_index: i32,
    pub fee_owed_a: u64,
    pub fee_owed_b: u64,
}

#[inline(never)]
pub fn read_position(acc: &AccountView) -> Result<PositionView, ProgramError> {
    if acc.owner() != &ID {
        return Err(VaultError::BadVenueAccount.into());
    }
    let d = acc.try_borrow()?;
    if d.len() < 216 || d[..8] != POSITION_DISC {
        return Err(VaultError::BadVenueAccount.into());
    }
    Ok(PositionView {
        whirlpool: rd_pk(&d, 8),
        position_mint: rd_pk(&d, 40),
        liquidity: rd_u128(&d, 72),
        tick_lower_index: rd_i32(&d, 88),
        tick_upper_index: rd_i32(&d, 92),
        fee_owed_a: rd_u64(&d, 112),
        fee_owed_b: rd_u64(&d, 136),
    })
}

// ---------------------------------------------------------------- CPI

/// Accounts shared by increase/decrease/collect: the position + pool + vault token accounts.
pub struct LiquidityAccounts<'a> {
    pub whirlpool: &'a AccountView,
    pub token_program_a: &'a AccountView,
    pub token_program_b: &'a AccountView,
    pub memo_program: &'a AccountView,
    pub position_authority: &'a AccountView, // vault PDA
    pub position: &'a AccountView,
    pub position_token_account: &'a AccountView,
    pub token_mint_a: &'a AccountView,
    pub token_mint_b: &'a AccountView,
    pub token_owner_account_a: &'a AccountView,
    pub token_owner_account_b: &'a AccountView,
    pub token_vault_a: &'a AccountView,
    pub token_vault_b: &'a AccountView,
    pub tick_array_lower: &'a AccountView,
    pub tick_array_upper: &'a AccountView,
    pub whirlpool_program: &'a AccountView,
}

fn check_program(p: &AccountView) -> Result<(), ProgramError> {
    if p.address() != &ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    Ok(())
}

/// `remaining_accounts_info: Option<RemainingAccountsInfo>` = None
const NONE_OPT: [u8; 1] = [0];

#[inline(never)]
fn modify_liquidity(a: &LiquidityAccounts, disc: [u8; 8], liquidity: u128, x: u64, y: u64, signer: &[Signer]) -> Result<(), ProgramError> {
    check_program(a.whirlpool_program)?;
    let mut data = [0u8; 8 + 16 + 8 + 8 + 1];
    data[..8].copy_from_slice(&disc);
    data[8..24].copy_from_slice(&liquidity.to_le_bytes());
    data[24..32].copy_from_slice(&x.to_le_bytes());
    data[32..40].copy_from_slice(&y.to_le_bytes());
    data[40..41].copy_from_slice(&NONE_OPT);
    let metas = [
        InstructionAccount::writable(a.whirlpool.address()),
        InstructionAccount::readonly(a.token_program_a.address()),
        InstructionAccount::readonly(a.token_program_b.address()),
        InstructionAccount::readonly(a.memo_program.address()),
        InstructionAccount::readonly_signer(a.position_authority.address()),
        InstructionAccount::writable(a.position.address()),
        InstructionAccount::readonly(a.position_token_account.address()),
        InstructionAccount::readonly(a.token_mint_a.address()),
        InstructionAccount::readonly(a.token_mint_b.address()),
        InstructionAccount::writable(a.token_owner_account_a.address()),
        InstructionAccount::writable(a.token_owner_account_b.address()),
        InstructionAccount::writable(a.token_vault_a.address()),
        InstructionAccount::writable(a.token_vault_b.address()),
        InstructionAccount::writable(a.tick_array_lower.address()),
        InstructionAccount::writable(a.tick_array_upper.address()),
    ];
    let ix = InstructionView { program_id: &ID, accounts: &metas, data: &data };
    invoke_signed::<15, &AccountView>(
        &ix,
        &[
            a.whirlpool, a.token_program_a, a.token_program_b, a.memo_program, a.position_authority, a.position,
            a.position_token_account, a.token_mint_a, a.token_mint_b, a.token_owner_account_a, a.token_owner_account_b,
            a.token_vault_a, a.token_vault_b, a.tick_array_lower, a.tick_array_upper,
        ],
        signer,
    )
}

/// increase_liquidity_v2(liquidity_amount, token_max_a, token_max_b, None)
#[inline(never)]
pub fn increase_liquidity(a: &LiquidityAccounts, liquidity: u128, max_a: u64, max_b: u64, signer: &[Signer]) -> Result<(), ProgramError> {
    modify_liquidity(a, disc::INCREASE_LIQUIDITY_V2, liquidity, max_a, max_b, signer)
}

/// decrease_liquidity_v2(liquidity_amount, token_min_a, token_min_b, None)
#[inline(never)]
pub fn decrease_liquidity(a: &LiquidityAccounts, liquidity: u128, min_a: u64, min_b: u64, signer: &[Signer]) -> Result<(), ProgramError> {
    modify_liquidity(a, disc::DECREASE_LIQUIDITY_V2, liquidity, min_a, min_b, signer)
}

/// update_fees_and_rewards(whirlpool, position, tick_array_lower, tick_array_upper)
#[inline(never)]
pub fn update_fees_and_rewards(a: &LiquidityAccounts) -> Result<(), ProgramError> {
    check_program(a.whirlpool_program)?;
    let metas = [
        InstructionAccount::writable(a.whirlpool.address()),
        InstructionAccount::writable(a.position.address()),
        InstructionAccount::readonly(a.tick_array_lower.address()),
        InstructionAccount::readonly(a.tick_array_upper.address()),
    ];
    let ix = InstructionView { program_id: &ID, accounts: &metas, data: &disc::UPDATE_FEES_AND_REWARDS };
    invoke_signed::<4, &AccountView>(&ix, &[a.whirlpool, a.position, a.tick_array_lower, a.tick_array_upper], &[])
}

/// collect_fees_v2 — note the different account order vs modify-liquidity.
#[inline(never)]
pub fn collect_fees(a: &LiquidityAccounts, signer: &[Signer]) -> Result<(), ProgramError> {
    check_program(a.whirlpool_program)?;
    let mut data = [0u8; 9];
    data[..8].copy_from_slice(&disc::COLLECT_FEES_V2);
    data[8] = 0;
    let metas = [
        InstructionAccount::readonly(a.whirlpool.address()),
        InstructionAccount::readonly_signer(a.position_authority.address()),
        InstructionAccount::writable(a.position.address()),
        InstructionAccount::readonly(a.position_token_account.address()),
        InstructionAccount::readonly(a.token_mint_a.address()),
        InstructionAccount::readonly(a.token_mint_b.address()),
        InstructionAccount::writable(a.token_owner_account_a.address()),
        InstructionAccount::writable(a.token_vault_a.address()),
        InstructionAccount::writable(a.token_owner_account_b.address()),
        InstructionAccount::writable(a.token_vault_b.address()),
        InstructionAccount::readonly(a.token_program_a.address()),
        InstructionAccount::readonly(a.token_program_b.address()),
        InstructionAccount::readonly(a.memo_program.address()),
    ];
    let ix = InstructionView { program_id: &ID, accounts: &metas, data: &data };
    invoke_signed::<13, &AccountView>(
        &ix,
        &[
            a.whirlpool, a.position_authority, a.position, a.position_token_account, a.token_mint_a, a.token_mint_b,
            a.token_owner_account_a, a.token_vault_a, a.token_owner_account_b, a.token_vault_b, a.token_program_a,
            a.token_program_b, a.memo_program,
        ],
        signer,
    )
}

pub struct OpenPositionAccounts<'a> {
    pub funder: &'a AccountView,   // pays rent (crank)
    pub owner: &'a AccountView,    // vault PDA
    pub position: &'a AccountView, // PDA ["position", position_mint] @ whirlpool
    pub position_mint: &'a AccountView, // signer: our PDA ["pmint", vault, epoch]
    pub position_token_account: &'a AccountView, // ATA(owner, position_mint, token-2022)
    pub whirlpool: &'a AccountView,
    pub token_2022_program: &'a AccountView,
    pub system_program: &'a AccountView,
    pub associated_token_program: &'a AccountView,
    pub metadata_update_auth: &'a AccountView,
    pub whirlpool_program: &'a AccountView,
}

/// open_position_with_token_extensions(tick_lower, tick_upper, with_token_metadata_extension=false)
#[inline(never)]
pub fn open_position(a: &OpenPositionAccounts, tick_lower: i32, tick_upper: i32, signers: &[Signer]) -> Result<(), ProgramError> {
    check_program(a.whirlpool_program)?;
    if a.token_2022_program.address() != &TOKEN_2022
        || a.associated_token_program.address() != &ATA_PROGRAM
        || a.metadata_update_auth.address() != &METADATA_UPDATE_AUTH
        || a.system_program.address() != &SYSTEM_PROGRAM
    {
        return Err(VaultError::BadVenueAccount.into());
    }
    let mut data = [0u8; 8 + 4 + 4 + 1];
    data[..8].copy_from_slice(&disc::OPEN_POSITION_WITH_TOKEN_EXTENSIONS);
    data[8..12].copy_from_slice(&tick_lower.to_le_bytes());
    data[12..16].copy_from_slice(&tick_upper.to_le_bytes());
    data[16] = 0;
    let metas = [
        InstructionAccount::writable_signer(a.funder.address()),
        InstructionAccount::readonly(a.owner.address()),
        InstructionAccount::writable(a.position.address()),
        InstructionAccount::writable_signer(a.position_mint.address()),
        InstructionAccount::writable(a.position_token_account.address()),
        InstructionAccount::readonly(a.whirlpool.address()),
        InstructionAccount::readonly(a.token_2022_program.address()),
        InstructionAccount::readonly(a.system_program.address()),
        InstructionAccount::readonly(a.associated_token_program.address()),
        InstructionAccount::readonly(a.metadata_update_auth.address()),
    ];
    let ix = InstructionView { program_id: &ID, accounts: &metas, data: &data };
    invoke_signed::<10, &AccountView>(
        &ix,
        &[
            a.funder, a.owner, a.position, a.position_mint, a.position_token_account, a.whirlpool, a.token_2022_program,
            a.system_program, a.associated_token_program, a.metadata_update_auth,
        ],
        signers,
    )
}

pub struct ResetRangeAccounts<'a> {
    pub funder: &'a AccountView,
    pub position_authority: &'a AccountView,
    pub whirlpool: &'a AccountView,
    pub position: &'a AccountView,
    pub position_token_account: &'a AccountView,
    pub system_program: &'a AccountView,
    pub whirlpool_program: &'a AccountView,
}

/// reset_position_range(new_tick_lower, new_tick_upper) — position must be empty.
#[inline(never)]
pub fn reset_position_range(a: &ResetRangeAccounts, tick_lower: i32, tick_upper: i32, signer: &[Signer]) -> Result<(), ProgramError> {
    check_program(a.whirlpool_program)?;
    let mut data = [0u8; 16];
    data[..8].copy_from_slice(&disc::RESET_POSITION_RANGE);
    data[8..12].copy_from_slice(&tick_lower.to_le_bytes());
    data[12..16].copy_from_slice(&tick_upper.to_le_bytes());
    let metas = [
        InstructionAccount::writable_signer(a.funder.address()),
        InstructionAccount::readonly_signer(a.position_authority.address()),
        InstructionAccount::readonly(a.whirlpool.address()),
        InstructionAccount::writable(a.position.address()),
        InstructionAccount::readonly(a.position_token_account.address()),
        InstructionAccount::readonly(a.system_program.address()),
    ];
    let ix = InstructionView { program_id: &ID, accounts: &metas, data: &data };
    invoke_signed::<6, &AccountView>(
        &ix,
        &[a.funder, a.position_authority, a.whirlpool, a.position, a.position_token_account, a.system_program],
        signer,
    )
}

pub struct SwapAccounts<'a> {
    pub token_program_a: &'a AccountView,
    pub token_program_b: &'a AccountView,
    pub memo_program: &'a AccountView,
    pub token_authority: &'a AccountView, // vault PDA
    pub whirlpool: &'a AccountView,
    pub token_mint_a: &'a AccountView,
    pub token_mint_b: &'a AccountView,
    pub token_owner_account_a: &'a AccountView,
    pub token_vault_a: &'a AccountView,
    pub token_owner_account_b: &'a AccountView,
    pub token_vault_b: &'a AccountView,
    pub tick_array_0: &'a AccountView,
    pub tick_array_1: &'a AccountView,
    pub tick_array_2: &'a AccountView,
    pub oracle: &'a AccountView,
    pub whirlpool_program: &'a AccountView,
}

/// swap_v2(amount, other_amount_threshold, sqrt_price_limit, amount_specified_is_input, a_to_b, None)
#[inline(never)]
pub fn swap(a: &SwapAccounts, amount: u64, other_threshold: u64, sqrt_price_limit: u128, amount_is_input: bool, a_to_b: bool, signer: &[Signer]) -> Result<(), ProgramError> {
    check_program(a.whirlpool_program)?;
    let mut data = [0u8; 8 + 8 + 8 + 16 + 1 + 1 + 1];
    data[..8].copy_from_slice(&disc::SWAP_V2);
    data[8..16].copy_from_slice(&amount.to_le_bytes());
    data[16..24].copy_from_slice(&other_threshold.to_le_bytes());
    data[24..40].copy_from_slice(&sqrt_price_limit.to_le_bytes());
    data[40] = amount_is_input as u8;
    data[41] = a_to_b as u8;
    data[42] = 0;
    let metas = [
        InstructionAccount::readonly(a.token_program_a.address()),
        InstructionAccount::readonly(a.token_program_b.address()),
        InstructionAccount::readonly(a.memo_program.address()),
        InstructionAccount::readonly_signer(a.token_authority.address()),
        InstructionAccount::writable(a.whirlpool.address()),
        InstructionAccount::readonly(a.token_mint_a.address()),
        InstructionAccount::readonly(a.token_mint_b.address()),
        InstructionAccount::writable(a.token_owner_account_a.address()),
        InstructionAccount::writable(a.token_vault_a.address()),
        InstructionAccount::writable(a.token_owner_account_b.address()),
        InstructionAccount::writable(a.token_vault_b.address()),
        InstructionAccount::writable(a.tick_array_0.address()),
        InstructionAccount::writable(a.tick_array_1.address()),
        InstructionAccount::writable(a.tick_array_2.address()),
        InstructionAccount::writable(a.oracle.address()),
    ];
    let ix = InstructionView { program_id: &ID, accounts: &metas, data: &data };
    invoke_signed::<15, &AccountView>(
        &ix,
        &[
            a.token_program_a, a.token_program_b, a.memo_program, a.token_authority, a.whirlpool, a.token_mint_a,
            a.token_mint_b, a.token_owner_account_a, a.token_vault_a, a.token_owner_account_b, a.token_vault_b,
            a.tick_array_0, a.tick_array_1, a.tick_array_2, a.oracle,
        ],
        signer,
    )
}
