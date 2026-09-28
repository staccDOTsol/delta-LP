//! Kamino Lend (klend v1.25) adapter — hand-rolled CPI into the `_v2` instructions (the v1 ones
//! introspect the transaction and refuse CPI). Discriminators, account orders and byte offsets
//! verified against the on-chain IDL + live mainnet accounts/transactions on 2026-09-25
//! (see abi/klend/DOSSIER.md).
//!
//! Model: the vault PDA owns one obligation (tag 0, id 0) in one lending market, deposits the
//! quote token as collateral and borrows the base token. debt(base) is the hedge.

use crate::error::VaultError;
use pinocchio::{
    cpi::{invoke_signed, Signer},
    error::ProgramError,
    instruction::{InstructionAccount, InstructionView},
    AccountView, Address,
};

pub const ID: Address = Address::from_str_const("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
pub const FARMS_PROGRAM: Address = Address::from_str_const("FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr");
pub const SYSVAR_INSTRUCTIONS: Address = Address::from_str_const("Sysvar1nstructions1111111111111111111111111");
pub const SYSVAR_RENT: Address = Address::from_str_const("SysvarRent111111111111111111111111111111111");
pub const SYSTEM_PROGRAM: Address = Address::from_str_const("11111111111111111111111111111111");
pub const DEFAULT_PUBKEY: [u8; 32] = [0u8; 32];

pub const RESERVE_DISC: [u8; 8] = [43, 242, 204, 202, 26, 247, 59, 127];
pub const OBLIGATION_DISC: [u8; 8] = [168, 206, 141, 106, 88, 76, 172, 167];
pub const RESERVE_LEN: usize = 8624;
pub const OBLIGATION_LEN: usize = 3344;

/// Fraction scale: value = raw / 2^60
pub const SF_SHIFT: u32 = 60;
pub const PRICE_STATUS_ALL_CHECKS: u8 = 0x3F;

mod disc {
    pub const INIT_USER_METADATA: [u8; 8] = [117, 169, 176, 69, 197, 23, 15, 162];
    pub const INIT_OBLIGATION: [u8; 8] = [251, 10, 231, 76, 27, 11, 159, 96];
    pub const INIT_OBLIGATION_FARMS_FOR_RESERVE: [u8; 8] = [136, 63, 15, 186, 211, 152, 168, 164];
    pub const REFRESH_RESERVE: [u8; 8] = [2, 218, 138, 235, 79, 201, 25, 102];
    pub const REFRESH_OBLIGATION: [u8; 8] = [33, 132, 147, 228, 151, 192, 72, 89];
    pub const DEPOSIT_V2: [u8; 8] = [216, 224, 191, 27, 204, 151, 102, 175];
    pub const WITHDRAW_V2: [u8; 8] = [235, 52, 119, 152, 149, 197, 20, 7];
    pub const BORROW_V2: [u8; 8] = [161, 128, 143, 245, 171, 199, 194, 6];
    pub const REPAY_V2: [u8; 8] = [116, 174, 213, 76, 180, 53, 210, 144];
}

// ---------------------------------------------------------------- readers

#[inline(always)]
fn rd_u64(d: &[u8], o: usize) -> u64 { u64::from_le_bytes(d[o..o + 8].try_into().unwrap()) }
#[inline(always)]
fn rd_u128(d: &[u8], o: usize) -> u128 { u128::from_le_bytes(d[o..o + 16].try_into().unwrap()) }
#[inline(always)]
fn rd_pk(d: &[u8], o: usize) -> [u8; 32] { d[o..o + 32].try_into().unwrap() }

/// BigFraction: [u64;4] little-endian limbs, value = limbs / 2^60. We only need the low 128 bits
/// (cumulative borrow rates are ~1.x, far below 2^68).
#[inline(always)]
fn rd_bsf_u128(d: &[u8], o: usize) -> Result<u128, ProgramError> {
    if rd_u64(d, o + 16) != 0 || rd_u64(d, o + 24) != 0 {
        return Err(VaultError::MathOverflow.into());
    }
    Ok(rd_u64(d, o) as u128 | ((rd_u64(d, o + 8) as u128) << 64))
}

pub struct ReserveView {
    pub last_update_slot: u64,
    pub stale: bool,
    pub price_status: u8,
    pub lending_market: [u8; 32],
    pub farm_collateral: [u8; 32],
    pub farm_debt: [u8; 32],
    pub liquidity_mint: [u8; 32],
    pub liquidity_supply: [u8; 32],
    pub fee_vault: [u8; 32],
    pub available_amount: u64,
    pub borrowed_amount_sf: u128,
    pub market_price_sf: u128,
    pub mint_decimals: u64,
    pub cumulative_borrow_rate_sf: u128,
    pub accumulated_protocol_fees_sf: u128,
    pub accumulated_referrer_fees_sf: u128,
    pub pending_referrer_fees_sf: u128,
    pub collateral_mint: [u8; 32],
    pub collateral_mint_total_supply: u64,
    pub collateral_supply: [u8; 32],
    pub loan_to_value_pct: u8,
    pub liquidation_threshold_pct: u8,
    pub borrow_factor_pct: u64,
    pub scope_price_feed: [u8; 32],
    pub pyth_price: [u8; 32],
    pub switchboard_price: [u8; 32],
    pub switchboard_twap: [u8; 32],
}

#[inline(never)]
pub fn read_reserve(acc: &AccountView) -> Result<ReserveView, ProgramError> {
    if acc.owner() != &ID {
        return Err(VaultError::BadVenueAccount.into());
    }
    let d = acc.try_borrow()?;
    if d.len() < RESERVE_LEN || d[..8] != RESERVE_DISC {
        return Err(VaultError::BadVenueAccount.into());
    }
    Ok(ReserveView {
        last_update_slot: rd_u64(&d, 16),
        stale: d[24] != 0,
        price_status: d[25],
        lending_market: rd_pk(&d, 32),
        farm_collateral: rd_pk(&d, 64),
        farm_debt: rd_pk(&d, 96),
        liquidity_mint: rd_pk(&d, 128),
        liquidity_supply: rd_pk(&d, 160),
        fee_vault: rd_pk(&d, 192),
        available_amount: rd_u64(&d, 224),
        borrowed_amount_sf: rd_u128(&d, 232),
        market_price_sf: rd_u128(&d, 248),
        mint_decimals: rd_u64(&d, 272),
        cumulative_borrow_rate_sf: rd_bsf_u128(&d, 296)?,
        accumulated_protocol_fees_sf: rd_u128(&d, 344),
        accumulated_referrer_fees_sf: rd_u128(&d, 360),
        pending_referrer_fees_sf: rd_u128(&d, 376),
        collateral_mint: rd_pk(&d, 2560),
        collateral_mint_total_supply: rd_u64(&d, 2592),
        collateral_supply: rd_pk(&d, 2600),
        loan_to_value_pct: d[4872],
        liquidation_threshold_pct: d[4873],
        borrow_factor_pct: rd_u64(&d, 5008),
        scope_price_feed: rd_pk(&d, 5112),
        switchboard_price: rd_pk(&d, 5160),
        switchboard_twap: rd_pk(&d, 5192),
        pyth_price: rd_pk(&d, 5224),
    })
}

impl ReserveView {
    /// Total liquidity backing the cToken supply (liquidity units).
    pub fn total_supply(&self) -> Result<u128, ProgramError> {
        let borrowed = self.borrowed_amount_sf >> SF_SHIFT;
        let fees = (self.accumulated_protocol_fees_sf >> SF_SHIFT)
            .checked_add(self.accumulated_referrer_fees_sf >> SF_SHIFT)
            .and_then(|x| x.checked_add(self.pending_referrer_fees_sf >> SF_SHIFT))
            .ok_or(VaultError::MathOverflow)?;
        (self.available_amount as u128)
            .checked_add(borrowed)
            .and_then(|x| x.checked_sub(fees))
            .ok_or(VaultError::MathOverflow.into())
    }

    /// cTokens → liquidity units (floor).
    pub fn ctokens_to_liquidity(&self, ctokens: u64) -> Result<u64, ProgramError> {
        if self.collateral_mint_total_supply == 0 {
            return Ok(ctokens);
        }
        let ts = self.total_supply()?;
        let out = dlp_math::u256::mul_div_u128(ctokens as u128, ts, self.collateral_mint_total_supply as u128).ok_or(VaultError::MathOverflow)?;
        u64::try_from(out).map_err(|_| VaultError::MathOverflow.into())
    }

    /// liquidity units → cTokens (ceil), for withdraw amounts.
    pub fn liquidity_to_ctokens_ceil(&self, liquidity: u64) -> Result<u64, ProgramError> {
        let ts = self.total_supply()?;
        if ts == 0 {
            return Ok(liquidity);
        }
        let out = dlp_math::u256::mul_div_ceil_u128(liquidity as u128, self.collateral_mint_total_supply as u128, ts).ok_or(VaultError::MathOverflow)?;
        u64::try_from(out).map_err(|_| VaultError::MathOverflow.into())
    }

    /// Oracle price in USD scaled by 1e12 (u64 fits up to $18M).
    pub fn price_usd_e12(&self) -> Result<u64, ProgramError> {
        let v = dlp_math::u256::mul_div_u128(self.market_price_sf, 1_000_000_000_000, 1u128 << SF_SHIFT).ok_or(VaultError::MathOverflow)?;
        u64::try_from(v).map_err(|_| VaultError::MathOverflow.into())
    }
}

/// Scalar header of an Obligation (kept small: it lives on the stack of every handler).
pub struct ObligationView {
    pub last_update_slot: u64,
    pub stale: bool,
    pub price_status: u8,
    pub lending_market: [u8; 32],
    pub owner: [u8; 32],
    pub deposited_value_sf: u128,
    pub bf_adjusted_debt_value_sf: u128,
    pub borrowed_assets_market_value_sf: u128,
    pub allowed_borrow_value_sf: u128,
    pub unhealthy_borrow_value_sf: u128,
    pub elevation_group: u8,
    pub has_debt: bool,
    pub referrer: [u8; 32],
}

const DEPOSITS_OFF: usize = 96;
const DEPOSIT_STRIDE: usize = 136;
const BORROWS_OFF: usize = 1208;
const BORROW_STRIDE: usize = 200;

fn obligation_bytes(acc: &AccountView) -> Result<pinocchio::account::Ref<'_, [u8]>, ProgramError> {
    if acc.owner() != &ID {
        return Err(VaultError::BadVenueAccount.into());
    }
    let d = acc.try_borrow()?;
    if d.len() < OBLIGATION_LEN || d[..8] != OBLIGATION_DISC {
        return Err(VaultError::BadVenueAccount.into());
    }
    Ok(d)
}

/// klend closes an obligation once it has no deposits and no borrows (rent → owner).
#[inline(always)]
pub fn obligation_is_open(acc: &AccountView) -> bool {
    acc.owner() == &ID && acc.data_len() >= OBLIGATION_LEN
}

#[inline(never)]
pub fn read_obligation(acc: &AccountView) -> Result<ObligationView, ProgramError> {
    let d = obligation_bytes(acc)?;
    Ok(ObligationView {
        last_update_slot: rd_u64(&d, 16),
        stale: d[24] != 0,
        price_status: d[25],
        lending_market: rd_pk(&d, 32),
        owner: rd_pk(&d, 64),
        deposited_value_sf: rd_u128(&d, 1192),
        bf_adjusted_debt_value_sf: rd_u128(&d, 2208),
        borrowed_assets_market_value_sf: rd_u128(&d, 2224),
        allowed_borrow_value_sf: rd_u128(&d, 2240),
        unhealthy_borrow_value_sf: rd_u128(&d, 2256),
        elevation_group: d[2285],
        has_debt: d[2287] != 0,
        referrer: rd_pk(&d, 2288),
    })
}

/// cTokens deposited for `reserve` (0 if absent).
#[inline(never)]
pub fn obligation_deposit_ctokens(acc: &AccountView, reserve: &[u8; 32]) -> Result<u64, ProgramError> {
    let d = obligation_bytes(acc)?;
    for i in 0..8 {
        let o = DEPOSITS_OFF + DEPOSIT_STRIDE * i;
        if &d[o..o + 32] == reserve {
            return Ok(rd_u64(&d, o + 32));
        }
    }
    Ok(0)
}

/// Debt in base units for `reserve`: ceil(borrowed_amount_sf / 2^60). Fresh only after refresh_obligation.
#[inline(never)]
pub fn obligation_debt_amount(acc: &AccountView, reserve: &[u8; 32]) -> Result<u64, ProgramError> {
    let d = obligation_bytes(acc)?;
    for i in 0..5 {
        let o = BORROWS_OFF + BORROW_STRIDE * i;
        if &d[o..o + 32] == reserve {
            let sf = rd_u128(&d, o + 88);
            let v = (sf >> SF_SHIFT) + if sf & ((1u128 << SF_SHIFT) - 1) != 0 { 1 } else { 0 };
            return u64::try_from(v).map_err(|_| VaultError::MathOverflow.into());
        }
    }
    Ok(0)
}

/// Vault invariant: every active deposit is `quote_reserve`, every active borrow is `base_reserve`.
#[inline(never)]
pub fn obligation_only_uses(acc: &AccountView, quote_reserve: &[u8; 32], base_reserve: &[u8; 32]) -> Result<(), ProgramError> {
    let d = obligation_bytes(acc)?;
    for i in 0..8 {
        let o = DEPOSITS_OFF + DEPOSIT_STRIDE * i;
        let r = &d[o..o + 32];
        if r != DEFAULT_PUBKEY && r != quote_reserve {
            return Err(VaultError::UnexpectedState.into());
        }
    }
    for i in 0..5 {
        let o = BORROWS_OFF + BORROW_STRIDE * i;
        let r = &d[o..o + 32];
        if r != DEFAULT_PUBKEY && r != base_reserve {
            return Err(VaultError::UnexpectedState.into());
        }
    }
    Ok(())
}

impl ObligationView {
    /// health ×100 = unhealthy_borrow_value / bf_adjusted_debt_value (u32::MAX when no debt)
    pub fn health_x100(&self) -> u32 {
        if self.bf_adjusted_debt_value_sf == 0 {
            return u32::MAX;
        }
        let h = dlp_math::u256::mul_div_u128(self.unhealthy_borrow_value_sf, 100, self.bf_adjusted_debt_value_sf).unwrap_or(u32::MAX as u128);
        h.min(u32::MAX as u128) as u32
    }
}

// ---------------------------------------------------------------- CPI helpers

#[inline(always)]
fn check_program(p: &AccountView) -> Result<(), ProgramError> {
    if p.address() != &ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    Ok(())
}

pub struct RefreshReserveAccounts<'a> {
    pub reserve: &'a AccountView,
    pub lending_market: &'a AccountView,
    /// klend program id (None) — the main-market reserves are Scope-only
    pub klend_program: &'a AccountView,
    pub scope_prices: &'a AccountView,
}

/// refresh_reserve(reserve, lending_market, pyth=None, sb=None, sb_twap=None, scope)
#[inline(never)]
pub fn refresh_reserve(a: &RefreshReserveAccounts) -> Result<(), ProgramError> {
    check_program(a.klend_program)?;
    let metas = [
        InstructionAccount::writable(a.reserve.address()),
        InstructionAccount::readonly(a.lending_market.address()),
        InstructionAccount::readonly(a.klend_program.address()),
        InstructionAccount::readonly(a.klend_program.address()),
        InstructionAccount::readonly(a.klend_program.address()),
        InstructionAccount::readonly(a.scope_prices.address()),
    ];
    let ix = InstructionView { program_id: &ID, accounts: &metas, data: &disc::REFRESH_RESERVE };
    invoke_signed::<6, &AccountView>(&ix, &[a.reserve, a.lending_market, a.klend_program, a.klend_program, a.klend_program, a.scope_prices], &[])
}

/// Verifies the reserve is Scope-only and that `scope_prices` is its configured feed.
pub fn check_scope_only(r: &ReserveView, scope_prices: &AccountView) -> Result<(), ProgramError> {
    if r.pyth_price != DEFAULT_PUBKEY || r.switchboard_price != DEFAULT_PUBKEY || r.switchboard_twap != DEFAULT_PUBKEY {
        return Err(VaultError::BadVenueAccount.into());
    }
    if scope_prices.address().as_array() != &r.scope_price_feed {
        return Err(VaultError::BadVenueAccount.into());
    }
    Ok(())
}

/// refresh_obligation(lending_market, obligation, ...active deposit reserves, ...active borrow reserves).
/// `reserves` are candidate reserve accounts (any order); the obligation's own slot order decides.
#[inline(never)]
pub fn refresh_obligation(klend_program: &AccountView, lending_market: &AccountView, obligation: &AccountView, reserves: &[&AccountView]) -> Result<(), ProgramError> {
    check_program(klend_program)?;
    // up to 2 + 2 remaining accounts (the vault never holds more)
    let mut metas: [InstructionAccount; 6] = [
        InstructionAccount::readonly(lending_market.address()),
        InstructionAccount::writable(obligation.address()),
        InstructionAccount::readonly(lending_market.address()),
        InstructionAccount::readonly(lending_market.address()),
        InstructionAccount::readonly(lending_market.address()),
        InstructionAccount::readonly(lending_market.address()),
    ];
    let mut views: [&AccountView; 6] = [lending_market, obligation, lending_market, lending_market, lending_market, lending_market];
    let mut n = 2usize;
    {
        let d = obligation_bytes(obligation)?;
        if &d[2288..2320] != DEFAULT_PUBKEY {
            // referrer token states would be required; the vault never sets a referrer
            return Err(VaultError::UnexpectedState.into());
        }
        let mut push = |pk: &[u8]| -> Result<(), ProgramError> {
            let acc = reserves.iter().find(|r| r.address().as_array() == pk).ok_or(VaultError::BadVenueAccount)?;
            if n >= 6 {
                return Err(VaultError::UnexpectedState.into());
            }
            metas[n] = InstructionAccount::writable(acc.address());
            views[n] = acc;
            n += 1;
            Ok(())
        };
        for i in 0..8 {
            let o = DEPOSITS_OFF + DEPOSIT_STRIDE * i;
            if &d[o..o + 32] != DEFAULT_PUBKEY {
                push(&d[o..o + 32])?;
            }
        }
        for i in 0..5 {
            let o = BORROWS_OFF + BORROW_STRIDE * i;
            if &d[o..o + 32] != DEFAULT_PUBKEY {
                push(&d[o..o + 32])?;
            }
        }
    }
    let ix = InstructionView { program_id: &ID, accounts: &metas[..n], data: &disc::REFRESH_OBLIGATION };
    pinocchio::cpi::invoke_signed_with_bounds::<6, &AccountView>(&ix, &views[..n], &[])
}

pub struct InitUserMetadataAccounts<'a> {
    pub owner: &'a AccountView, // vault PDA (signer via seeds)
    pub fee_payer: &'a AccountView,
    pub user_metadata: &'a AccountView, // ["user_meta", owner] @ klend
    pub klend_program: &'a AccountView, // referrer = None
    pub rent: &'a AccountView,
    pub system_program: &'a AccountView,
}

#[inline(never)]
pub fn init_user_metadata(a: &InitUserMetadataAccounts, signer: &[Signer]) -> Result<(), ProgramError> {
    check_program(a.klend_program)?;
    let mut data = [0u8; 40];
    data[..8].copy_from_slice(&disc::INIT_USER_METADATA);
    let metas = [
        InstructionAccount::readonly_signer(a.owner.address()),
        InstructionAccount::writable_signer(a.fee_payer.address()),
        InstructionAccount::writable(a.user_metadata.address()),
        InstructionAccount::readonly(a.klend_program.address()),
        InstructionAccount::readonly(a.rent.address()),
        InstructionAccount::readonly(a.system_program.address()),
    ];
    let ix = InstructionView { program_id: &ID, accounts: &metas, data: &data };
    invoke_signed::<6, &AccountView>(&ix, &[a.owner, a.fee_payer, a.user_metadata, a.klend_program, a.rent, a.system_program], signer)
}

pub struct InitObligationAccounts<'a> {
    pub owner: &'a AccountView,
    pub fee_payer: &'a AccountView,
    pub obligation: &'a AccountView, // [[tag],[id], owner, market, sys, sys] @ klend
    pub lending_market: &'a AccountView,
    pub system_program: &'a AccountView, // doubles as seed1/seed2 (Pubkey::default() == system program id)
    pub user_metadata: &'a AccountView,
    pub rent: &'a AccountView,
    pub klend_program: &'a AccountView,
}

#[inline(never)]
pub fn init_obligation(a: &InitObligationAccounts, tag: u8, id: u8, signer: &[Signer]) -> Result<(), ProgramError> {
    check_program(a.klend_program)?;
    if a.system_program.address() != &SYSTEM_PROGRAM {
        return Err(VaultError::BadVenueAccount.into());
    }
    let mut data = [0u8; 10];
    data[..8].copy_from_slice(&disc::INIT_OBLIGATION);
    data[8] = tag;
    data[9] = id;
    let metas = [
        InstructionAccount::readonly_signer(a.owner.address()),
        InstructionAccount::writable_signer(a.fee_payer.address()),
        InstructionAccount::writable(a.obligation.address()),
        InstructionAccount::readonly(a.lending_market.address()),
        InstructionAccount::readonly(a.system_program.address()),
        InstructionAccount::readonly(a.system_program.address()),
        InstructionAccount::readonly(a.user_metadata.address()),
        InstructionAccount::readonly(a.rent.address()),
        InstructionAccount::readonly(a.system_program.address()),
    ];
    let ix = InstructionView { program_id: &ID, accounts: &metas, data: &data };
    invoke_signed::<9, &AccountView>(
        &ix,
        &[a.owner, a.fee_payer, a.obligation, a.lending_market, a.system_program, a.system_program, a.user_metadata, a.rent, a.system_program],
        signer,
    )
}

pub struct InitObligationFarmsAccounts<'a> {
    pub payer: &'a AccountView,
    pub owner: &'a AccountView,
    pub obligation: &'a AccountView,
    pub lending_market_authority: &'a AccountView,
    pub reserve: &'a AccountView,
    pub reserve_farm_state: &'a AccountView,
    pub obligation_farm: &'a AccountView, // ["user", farm_state, obligation] @ Farms
    pub lending_market: &'a AccountView,
    pub farms_program: &'a AccountView,
    pub rent: &'a AccountView,
    pub system_program: &'a AccountView,
    pub klend_program: &'a AccountView,
}

/// mode 0 = Collateral farm, 1 = Debt farm
#[inline(never)]
pub fn init_obligation_farms_for_reserve(a: &InitObligationFarmsAccounts, mode: u8) -> Result<(), ProgramError> {
    check_program(a.klend_program)?;
    let mut data = [0u8; 9];
    data[..8].copy_from_slice(&disc::INIT_OBLIGATION_FARMS_FOR_RESERVE);
    data[8] = mode;
    let metas = [
        InstructionAccount::writable_signer(a.payer.address()),
        InstructionAccount::readonly(a.owner.address()),
        InstructionAccount::writable(a.obligation.address()),
        InstructionAccount::readonly(a.lending_market_authority.address()),
        InstructionAccount::writable(a.reserve.address()),
        InstructionAccount::writable(a.reserve_farm_state.address()),
        InstructionAccount::writable(a.obligation_farm.address()),
        InstructionAccount::readonly(a.lending_market.address()),
        InstructionAccount::readonly(a.farms_program.address()),
        InstructionAccount::readonly(a.rent.address()),
        InstructionAccount::readonly(a.system_program.address()),
    ];
    let ix = InstructionView { program_id: &ID, accounts: &metas, data: &data };
    invoke_signed::<11, &AccountView>(
        &ix,
        &[a.payer, a.owner, a.obligation, a.lending_market_authority, a.reserve, a.reserve_farm_state, a.obligation_farm, a.lending_market, a.farms_program, a.rent, a.system_program],
        &[],
    )
}

/// Farm slots are writable when they are real accounts and read-only when they are the
/// klend program id (Anchor `None`) — marking the program writable would be a privilege escalation.
#[inline(always)]
fn farm_meta(a: &AccountView) -> InstructionAccount<'_> {
    InstructionAccount::new(a.address(), a.is_writable() && a.address() != &ID, false)
}

/// Farm accounts for one reserve side. When the reserve has no farm of that kind, both are the
/// klend program id (Anchor `None`). klend validates the pair; we only pass through.
pub struct FarmAccounts<'a> {
    pub obligation_farm_user_state: &'a AccountView,
    pub reserve_farm_state: &'a AccountView,
}

pub struct CollateralAccounts<'a> {
    pub owner: &'a AccountView, // vault PDA, writable+signer
    pub obligation: &'a AccountView,
    pub lending_market: &'a AccountView,
    pub lending_market_authority: &'a AccountView,
    pub reserve: &'a AccountView,
    pub reserve_liquidity_mint: &'a AccountView,
    pub reserve_liquidity_supply: &'a AccountView,
    pub reserve_collateral_mint: &'a AccountView,
    pub reserve_collateral_supply: &'a AccountView,
    pub user_liquidity: &'a AccountView, // vault quote ATA
    pub klend_program: &'a AccountView,  // placeholder None
    pub token_program: &'a AccountView,
    pub sysvar_instructions: &'a AccountView,
    pub farms: FarmAccounts<'a>,
    pub farms_program: &'a AccountView,
}

/// deposit_reserve_liquidity_and_obligation_collateral_v2(liquidity_amount)
#[inline(never)]
pub fn deposit_collateral(a: &CollateralAccounts, amount: u64, signer: &[Signer]) -> Result<(), ProgramError> {
    check_program(a.klend_program)?;
    let mut data = [0u8; 16];
    data[..8].copy_from_slice(&disc::DEPOSIT_V2);
    data[8..16].copy_from_slice(&amount.to_le_bytes());
    let metas = [
        InstructionAccount::writable_signer(a.owner.address()),
        InstructionAccount::writable(a.obligation.address()),
        InstructionAccount::readonly(a.lending_market.address()),
        InstructionAccount::readonly(a.lending_market_authority.address()),
        InstructionAccount::writable(a.reserve.address()),
        InstructionAccount::readonly(a.reserve_liquidity_mint.address()),
        InstructionAccount::writable(a.reserve_liquidity_supply.address()),
        InstructionAccount::writable(a.reserve_collateral_mint.address()),
        InstructionAccount::writable(a.reserve_collateral_supply.address()),
        InstructionAccount::writable(a.user_liquidity.address()),
        InstructionAccount::readonly(a.klend_program.address()),
        InstructionAccount::readonly(a.token_program.address()),
        InstructionAccount::readonly(a.token_program.address()),
        InstructionAccount::readonly(a.sysvar_instructions.address()),
        farm_meta(a.farms.obligation_farm_user_state),
        farm_meta(a.farms.reserve_farm_state),
        InstructionAccount::readonly(a.farms_program.address()),
    ];
    let ix = InstructionView { program_id: &ID, accounts: &metas, data: &data };
    invoke_signed::<17, &AccountView>(
        &ix,
        &[
            a.owner, a.obligation, a.lending_market, a.lending_market_authority, a.reserve, a.reserve_liquidity_mint,
            a.reserve_liquidity_supply, a.reserve_collateral_mint, a.reserve_collateral_supply, a.user_liquidity,
            a.klend_program, a.token_program, a.token_program, a.sysvar_instructions,
            a.farms.obligation_farm_user_state, a.farms.reserve_farm_state, a.farms_program,
        ],
        signer,
    )
}

/// withdraw_obligation_collateral_and_redeem_reserve_collateral_v2(collateral_amount in cTokens)
#[inline(never)]
pub fn withdraw_collateral(a: &CollateralAccounts, ctokens: u64, signer: &[Signer]) -> Result<(), ProgramError> {
    check_program(a.klend_program)?;
    let mut data = [0u8; 16];
    data[..8].copy_from_slice(&disc::WITHDRAW_V2);
    data[8..16].copy_from_slice(&ctokens.to_le_bytes());
    let metas = [
        InstructionAccount::writable_signer(a.owner.address()),
        InstructionAccount::writable(a.obligation.address()),
        InstructionAccount::readonly(a.lending_market.address()),
        InstructionAccount::readonly(a.lending_market_authority.address()),
        InstructionAccount::writable(a.reserve.address()),
        InstructionAccount::readonly(a.reserve_liquidity_mint.address()),
        InstructionAccount::writable(a.reserve_collateral_supply.address()),
        InstructionAccount::writable(a.reserve_collateral_mint.address()),
        InstructionAccount::writable(a.reserve_liquidity_supply.address()),
        InstructionAccount::writable(a.user_liquidity.address()),
        InstructionAccount::readonly(a.klend_program.address()),
        InstructionAccount::readonly(a.token_program.address()),
        InstructionAccount::readonly(a.token_program.address()),
        InstructionAccount::readonly(a.sysvar_instructions.address()),
        farm_meta(a.farms.obligation_farm_user_state),
        farm_meta(a.farms.reserve_farm_state),
        InstructionAccount::readonly(a.farms_program.address()),
    ];
    let ix = InstructionView { program_id: &ID, accounts: &metas, data: &data };
    invoke_signed::<17, &AccountView>(
        &ix,
        &[
            a.owner, a.obligation, a.lending_market, a.lending_market_authority, a.reserve, a.reserve_liquidity_mint,
            a.reserve_collateral_supply, a.reserve_collateral_mint, a.reserve_liquidity_supply, a.user_liquidity,
            a.klend_program, a.token_program, a.token_program, a.sysvar_instructions,
            a.farms.obligation_farm_user_state, a.farms.reserve_farm_state, a.farms_program,
        ],
        signer,
    )
}

pub struct DebtAccounts<'a> {
    pub owner: &'a AccountView, // vault PDA, signer
    pub obligation: &'a AccountView,
    pub lending_market: &'a AccountView,
    pub lending_market_authority: &'a AccountView,
    pub reserve: &'a AccountView,
    pub reserve_liquidity_mint: &'a AccountView,
    pub reserve_liquidity_supply: &'a AccountView,
    pub reserve_fee_receiver: &'a AccountView,
    pub user_liquidity: &'a AccountView, // vault base ATA (wSOL)
    pub klend_program: &'a AccountView,  // referrer_token_state None
    pub token_program: &'a AccountView,
    pub sysvar_instructions: &'a AccountView,
    pub farms: FarmAccounts<'a>,
    pub farms_program: &'a AccountView,
}

/// borrow_obligation_liquidity_v2(liquidity_amount)
#[inline(never)]
pub fn borrow(a: &DebtAccounts, amount: u64, signer: &[Signer]) -> Result<(), ProgramError> {
    check_program(a.klend_program)?;
    let mut data = [0u8; 16];
    data[..8].copy_from_slice(&disc::BORROW_V2);
    data[8..16].copy_from_slice(&amount.to_le_bytes());
    let metas = [
        InstructionAccount::readonly_signer(a.owner.address()),
        InstructionAccount::writable(a.obligation.address()),
        InstructionAccount::readonly(a.lending_market.address()),
        InstructionAccount::readonly(a.lending_market_authority.address()),
        InstructionAccount::writable(a.reserve.address()),
        InstructionAccount::readonly(a.reserve_liquidity_mint.address()),
        InstructionAccount::writable(a.reserve_liquidity_supply.address()),
        InstructionAccount::writable(a.reserve_fee_receiver.address()),
        InstructionAccount::writable(a.user_liquidity.address()),
        InstructionAccount::readonly(a.klend_program.address()),
        InstructionAccount::readonly(a.token_program.address()),
        InstructionAccount::readonly(a.sysvar_instructions.address()),
        farm_meta(a.farms.obligation_farm_user_state),
        farm_meta(a.farms.reserve_farm_state),
        InstructionAccount::readonly(a.farms_program.address()),
    ];
    let ix = InstructionView { program_id: &ID, accounts: &metas, data: &data };
    invoke_signed::<15, &AccountView>(
        &ix,
        &[
            a.owner, a.obligation, a.lending_market, a.lending_market_authority, a.reserve, a.reserve_liquidity_mint,
            a.reserve_liquidity_supply, a.reserve_fee_receiver, a.user_liquidity, a.klend_program, a.token_program,
            a.sysvar_instructions, a.farms.obligation_farm_user_state, a.farms.reserve_farm_state, a.farms_program,
        ],
        signer,
    )
}

/// repay_obligation_liquidity_v2(liquidity_amount) — note LMA sits at index 11, after the farm pair.
#[inline(never)]
pub fn repay(a: &DebtAccounts, amount: u64, signer: &[Signer]) -> Result<(), ProgramError> {
    check_program(a.klend_program)?;
    let mut data = [0u8; 16];
    data[..8].copy_from_slice(&disc::REPAY_V2);
    data[8..16].copy_from_slice(&amount.to_le_bytes());
    let metas = [
        InstructionAccount::readonly_signer(a.owner.address()),
        InstructionAccount::writable(a.obligation.address()),
        InstructionAccount::readonly(a.lending_market.address()),
        InstructionAccount::writable(a.reserve.address()),
        InstructionAccount::readonly(a.reserve_liquidity_mint.address()),
        InstructionAccount::writable(a.reserve_liquidity_supply.address()),
        InstructionAccount::writable(a.user_liquidity.address()),
        InstructionAccount::readonly(a.token_program.address()),
        InstructionAccount::readonly(a.sysvar_instructions.address()),
        farm_meta(a.farms.obligation_farm_user_state),
        farm_meta(a.farms.reserve_farm_state),
        InstructionAccount::readonly(a.lending_market_authority.address()),
        InstructionAccount::readonly(a.farms_program.address()),
    ];
    let ix = InstructionView { program_id: &ID, accounts: &metas, data: &data };
    invoke_signed::<13, &AccountView>(
        &ix,
        &[
            a.owner, a.obligation, a.lending_market, a.reserve, a.reserve_liquidity_mint, a.reserve_liquidity_supply,
            a.user_liquidity, a.token_program, a.sysvar_instructions, a.farms.obligation_farm_user_state,
            a.farms.reserve_farm_state, a.lending_market_authority, a.farms_program,
        ],
        signer,
    )
}
