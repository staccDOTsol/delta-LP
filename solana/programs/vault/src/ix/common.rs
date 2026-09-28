//! Shared account plumbing: PDA checks, vault signer seeds, token reads, arg parsing.

use crate::{
    error::VaultError,
    state::{seeds, Vault},
};
use pinocchio::{
    cpi::{Seed, Signer},
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    AccountView, Address,
};

pub const TOKEN_PROGRAM: Address = Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN_2022_PROGRAM: Address = Address::from_str_const("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const ATA_PROGRAM: Address = Address::from_str_const("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const SYSTEM_PROGRAM: Address = Address::from_str_const("11111111111111111111111111111111");

/// Vault PDA seeds: ["vault", whirlpool, hedge_market, [hedge_kind]] (+bump)
pub struct VaultSeeds {
    pub whirlpool: [u8; 32],
    pub hedge_market: [u8; 32],
    pub kind: [u8; 1],
    pub bump: [u8; 1],
}

impl VaultSeeds {
    pub fn from_vault(v: &Vault) -> Self {
        VaultSeeds { whirlpool: v.whirlpool, hedge_market: v.hedge_market, kind: [v.hedge_kind], bump: [v.bump] }
    }
    pub fn seeds(&self) -> [Seed<'_>; 5] {
        [Seed::from(seeds::VAULT), Seed::from(&self.whirlpool), Seed::from(&self.hedge_market), Seed::from(&self.kind), Seed::from(&self.bump)]
    }
}

#[macro_export]
macro_rules! vault_signer {
    ($seeds:ident, $arr:ident, $signer:ident) => {
        let $arr = $seeds.seeds();
        let $signer = [pinocchio::cpi::Signer::from(&$arr)];
    };
}

pub fn derive_vault(program_id: &Address, whirlpool: &[u8; 32], hedge_market: &[u8; 32], kind: u8) -> (Address, u8) {
    Address::find_program_address(&[seeds::VAULT, whirlpool.as_ref(), hedge_market.as_ref(), &[kind]], program_id)
}

pub fn derive_receipt(program_id: &Address, vault: &Address) -> (Address, u8) {
    Address::find_program_address(&[seeds::RECEIPT, vault.as_array().as_ref()], program_id)
}

pub fn derive_pmint(program_id: &Address, vault: &Address, epoch: u64) -> (Address, u8) {
    Address::find_program_address(&[seeds::PMINT, vault.as_array().as_ref(), epoch.to_le_bytes().as_ref()], program_id)
}

pub fn check_vault_pda(program_id: &Address, vault_acc: &AccountView, v: &Vault) -> Result<(), ProgramError> {
    let expected = Address::create_program_address(&[seeds::VAULT, v.whirlpool.as_ref(), v.hedge_market.as_ref(), &[v.hedge_kind], &[v.bump]], program_id)
        .map_err(|_| VaultError::BadPda)?;
    if vault_acc.address() != &expected || vault_acc.owner() != program_id {
        return Err(VaultError::BadPda.into());
    }
    Ok(())
}

#[inline(always)]
pub fn require_signer(a: &AccountView) -> Result<(), ProgramError> {
    if !a.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    Ok(())
}

#[inline(always)]
pub fn require_key(a: &AccountView, k: &[u8; 32]) -> Result<(), ProgramError> {
    if a.address().as_array() != k {
        return Err(VaultError::BadVenueAccount.into());
    }
    Ok(())
}

#[inline(always)]
pub fn require_crank(v: &Vault, a: &AccountView) -> Result<(), ProgramError> {
    require_signer(a)?;
    if a.address().as_array() != &v.crank {
        return Err(VaultError::NotCrank.into());
    }
    Ok(())
}

#[inline(always)]
pub fn require_authority(v: &Vault, a: &AccountView) -> Result<(), ProgramError> {
    require_signer(a)?;
    if a.address().as_array() != &v.authority {
        return Err(VaultError::NotAuthority.into());
    }
    Ok(())
}

/// SPL token account amount (works for Token and Token-2022 base layout).
pub fn token_amount(a: &AccountView) -> Result<u64, ProgramError> {
    let d = a.try_borrow()?;
    if d.len() < 165 {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(u64::from_le_bytes(d[64..72].try_into().unwrap()))
}

pub fn token_owner_and_mint(a: &AccountView) -> Result<([u8; 32], [u8; 32]), ProgramError> {
    let d = a.try_borrow()?;
    if d.len() < 165 {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok((d[32..64].try_into().unwrap(), d[0..32].try_into().unwrap()))
}

pub fn mint_supply(a: &AccountView) -> Result<u64, ProgramError> {
    let d = a.try_borrow()?;
    if d.len() < 82 {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(u64::from_le_bytes(d[36..44].try_into().unwrap()))
}

pub fn mint_decimals(a: &AccountView) -> Result<u8, ProgramError> {
    let d = a.try_borrow()?;
    if d.len() < 82 {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(d[44])
}

#[inline(always)]
pub fn clock() -> Result<Clock, ProgramError> {
    Clock::get()
}

// ---- arg readers
pub struct Args<'a>(pub &'a [u8]);
impl<'a> Args<'a> {
    pub fn u8(&mut self) -> Result<u8, ProgramError> {
        let (&b, rest) = self.0.split_first().ok_or(ProgramError::InvalidInstructionData)?;
        self.0 = rest;
        Ok(b)
    }
    pub fn u16(&mut self) -> Result<u16, ProgramError> { Ok(u16::from_le_bytes(self.take::<2>()?)) }
    pub fn i32(&mut self) -> Result<i32, ProgramError> { Ok(i32::from_le_bytes(self.take::<4>()?)) }
    pub fn u64(&mut self) -> Result<u64, ProgramError> { Ok(u64::from_le_bytes(self.take::<8>()?)) }
    pub fn i64(&mut self) -> Result<i64, ProgramError> { Ok(i64::from_le_bytes(self.take::<8>()?)) }
    pub fn u128(&mut self) -> Result<u128, ProgramError> { Ok(u128::from_le_bytes(self.take::<16>()?)) }
    pub fn pk(&mut self) -> Result<[u8; 32], ProgramError> { self.take::<32>() }
    pub fn take<const N: usize>(&mut self) -> Result<[u8; N], ProgramError> {
        if self.0.len() < N {
            return Err(ProgramError::InvalidInstructionData);
        }
        let (h, rest) = self.0.split_at(N);
        self.0 = rest;
        Ok(h.try_into().unwrap())
    }
}

/// Split a `&mut [AccountView]` into a shared-borrow slice (we never need &mut AccountView;
/// pinocchio mutates account data through interior RefCell-like borrows).
#[inline(always)]
pub fn views(accounts: &mut [AccountView]) -> &[AccountView] {
    accounts
}

/// Fetch N accounts or fail.
#[inline(always)]
pub fn need<'a>(accounts: &'a [AccountView], n: usize) -> Result<&'a [AccountView], ProgramError> {
    if accounts.len() < n {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    Ok(accounts)
}

pub fn signer_from<'s, 'b>(arr: &'s [Seed<'b>; 5]) -> [Signer<'b, 's>; 1] {
    [Signer::from(arr)]
}

/// base amount (raw) × price (quote_raw per base_raw, ×1e12) → quote raw
pub fn base_to_quote(base: u64, price_raw_e12: u64) -> Result<u64, ProgramError> {
    let v = dlp_math::u256::mul_div_u128(base as u128, price_raw_e12 as u128, 1_000_000_000_000).ok_or(VaultError::MathOverflow)?;
    u64::try_from(v).map_err(|_| VaultError::MathOverflow.into())
}
