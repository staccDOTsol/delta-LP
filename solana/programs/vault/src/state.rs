//! Vault state. One account per receipt: (whirlpool, hedge market, k) ⇒ one PDA, one receipt mint.
//! All multi-byte fields are little-endian byte arrays so the layout is identical on host and SBF.

use pinocchio::{error::ProgramError, Address};

pub const VAULT_DISC: [u8; 8] = *b"dlpvault";
pub const VAULT_VERSION: u8 = 1;
pub const VAULT_LEN: usize = core::mem::size_of::<Vault>();
pub const RECEIPT_DECIMALS: u8 = 6;

pub mod seeds {
    pub const VAULT: &[u8] = b"vault";
    pub const RECEIPT: &[u8] = b"receipt";
    pub const PMINT: &[u8] = b"pmint";
}

#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Phase {
    /// deposits/withdrawals allowed, legs consistent
    Idle = 0,
    /// liquidity pulled + fees collected; inventory idle in vault ATAs
    Pulled = 1,
    /// hedge resized to the target for the next range
    Hedged = 2,
    /// liquidity placed in the new range; waiting for End guards
    Placed = 3,
}

impl Phase {
    pub fn from_u8(v: u8) -> Result<Self, ProgramError> {
        Ok(match v {
            0 => Phase::Idle,
            1 => Phase::Pulled,
            2 => Phase::Hedged,
            3 => Phase::Placed,
            _ => return Err(ProgramError::InvalidAccountData),
        })
    }
}

#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum HedgeKind {
    /// Kamino Lend: borrow base against quote collateral
    Klend = 1,
    /// Drift / Velocity perp short
    Drift = 2,
}

impl HedgeKind {
    pub fn from_u8(v: u8) -> Result<Self, ProgramError> {
        Ok(match v {
            1 => HedgeKind::Klend,
            2 => HedgeKind::Drift,
            _ => return Err(ProgramError::InvalidAccountData),
        })
    }
}

/// flags bits
pub const FLAG_UNDER_HEALTH: u8 = 1 << 0; // last sync saw health below min: deposits blocked
pub const FLAG_PRICE_DEVIATION: u8 = 1 << 1; // last sync saw pool/oracle price disagreement

#[repr(C)]
#[derive(Clone, Copy)]
pub struct Params {
    /// rebalance-epoch cap on receipt minted, bps of supply at epoch start (0 = no cap)
    pub max_mint_bps_per_epoch: [u8; 2],
    /// rebalance-epoch cap on receipt burned, bps of supply at epoch start (0 = no cap)
    pub max_burn_bps_per_epoch: [u8; 2],
    /// |net base delta| ≤ eps_bps/1e4 · max(hedge, lp_base)
    pub eps_bps: [u8; 2],
    /// klend: unhealthy_borrow_value / bf_adjusted_debt ≥ min_health_x100/100
    /// drift: total_collateral / maintenance_margin ≥ min_health_x100/100
    pub min_health_x100: [u8; 2],
    /// max allowed |pool price − oracle price| in bps at sync
    pub max_price_dev_bps: [u8; 2],
    /// max single-swap notional as bps of equity (guards the recenter tax)
    pub max_swap_bps: [u8; 2],
    pub _pad: [u8; 4],
}

impl Params {
    pub const LEN: usize = core::mem::size_of::<Params>();
    pub fn max_mint_bps(&self) -> u16 { u16::from_le_bytes(self.max_mint_bps_per_epoch) }
    pub fn max_burn_bps(&self) -> u16 { u16::from_le_bytes(self.max_burn_bps_per_epoch) }
    pub fn eps_bps(&self) -> u16 { u16::from_le_bytes(self.eps_bps) }
    pub fn min_health_x100(&self) -> u16 { u16::from_le_bytes(self.min_health_x100) }
    pub fn max_price_dev_bps(&self) -> u16 { u16::from_le_bytes(self.max_price_dev_bps) }
    pub fn max_swap_bps(&self) -> u16 { u16::from_le_bytes(self.max_swap_bps) }

    pub fn from_bytes(b: &[u8]) -> Result<Params, ProgramError> {
        if b.len() < Self::LEN {
            return Err(ProgramError::InvalidInstructionData);
        }
        let mut p = Params::zeroed();
        // SAFETY: Params is plain bytes.
        unsafe { core::ptr::copy_nonoverlapping(b.as_ptr(), &mut p as *mut Params as *mut u8, Self::LEN) };
        p.validate()?;
        Ok(p)
    }
    pub const fn zeroed() -> Params {
        Params { max_mint_bps_per_epoch: [0; 2], max_burn_bps_per_epoch: [0; 2], eps_bps: [0; 2], min_health_x100: [0; 2], max_price_dev_bps: [0; 2], max_swap_bps: [0; 2], _pad: [0; 4] }
    }
    pub fn validate(&self) -> Result<(), ProgramError> {
        if self.max_mint_bps() > 10_000 || self.max_burn_bps() > 10_000 || self.eps_bps() > 10_000 || self.max_price_dev_bps() > 10_000 || self.max_swap_bps() > 10_000 {
            return Err(ProgramError::InvalidInstructionData);
        }
        if self.min_health_x100() < 110 || self.eps_bps() == 0 || self.max_price_dev_bps() == 0 {
            return Err(ProgramError::InvalidInstructionData);
        }
        Ok(())
    }
}

#[repr(C)]
pub struct Vault {
    pub disc: [u8; 8],
    pub version: u8,
    pub bump: u8,
    pub receipt_bump: u8,
    pub phase: u8,
    pub hedge_kind: u8,
    pub flags: u8,
    pub quote_decimals: u8,
    pub base_decimals: u8,

    /// whoever may run the rebalance phases + rotate itself
    pub crank: [u8; 32],
    /// may rotate crank + params; never touches funds
    pub authority: [u8; 32],
    pub quote_mint: [u8; 32],
    pub base_mint: [u8; 32],
    pub receipt_mint: [u8; 32],
    pub quote_ata: [u8; 32],
    pub base_ata: [u8; 32],
    /// Orca whirlpool (token_mint_a = base, token_mint_b = quote)
    pub whirlpool: [u8; 32],
    /// current position account (all-zero = none yet)
    pub position: [u8; 32],
    pub position_mint: [u8; 32],
    /// hedge venue "market": klend → obligation; drift → User account
    pub hedge_account: [u8; 32],
    /// klend → lending_market; drift → perp market
    pub hedge_market: [u8; 32],
    /// klend → quote reserve; drift → quote spot market
    pub hedge_quote: [u8; 32],
    /// klend → base reserve; drift → (unused)
    pub hedge_base: [u8; 32],

    pub params: Params,

    // ---- live mirror (written by Sync / End) ----
    /// equity in quote units at last sync
    pub equity_q: [u8; 8],
    /// receipt supply at last sync
    pub receipt_supply: [u8; 8],
    /// slot of last sync
    pub sync_slot: [u8; 8],
    /// oracle price used at last sync, quote units per 1 base unit scaled by 1e12 (P_raw·1e12)
    pub oracle_price_raw_e12: [u8; 8],
    /// hedge base size (klend: debt in base units; drift: |short| in base units)
    pub hedge_base_amount: [u8; 8],
    /// LP fair-value base amount at last sync
    pub lp_base_amount: [u8; 8],
    /// health ×100 at last sync
    pub health_x100: [u8; 4],
    pub _pad2: [u8; 4],

    // ---- position ----
    pub tick_lower: [u8; 4],
    pub tick_upper: [u8; 4],
    pub liquidity: [u8; 16],

    // ---- epoch accounting ----
    pub epoch: [u8; 8],
    pub epoch_supply_start: [u8; 8],
    pub epoch_minted: [u8; 8],
    pub epoch_burned: [u8; 8],
    pub phase_started_slot: [u8; 8],
    pub _reserved: [u8; 64],
}

macro_rules! le_field {
    ($get:ident, $set:ident, $field:ident, u64) => {
        #[inline(always)]
        pub fn $get(&self) -> u64 { u64::from_le_bytes(self.$field) }
        #[inline(always)]
        pub fn $set(&mut self, v: u64) { self.$field = v.to_le_bytes(); }
    };
    ($get:ident, $set:ident, $field:ident, i32) => {
        #[inline(always)]
        pub fn $get(&self) -> i32 { i32::from_le_bytes(self.$field) }
        #[inline(always)]
        pub fn $set(&mut self, v: i32) { self.$field = v.to_le_bytes(); }
    };
    ($get:ident, $set:ident, $field:ident, u32) => {
        #[inline(always)]
        pub fn $get(&self) -> u32 { u32::from_le_bytes(self.$field) }
        #[inline(always)]
        pub fn $set(&mut self, v: u32) { self.$field = v.to_le_bytes(); }
    };
    ($get:ident, $set:ident, $field:ident, u128) => {
        #[inline(always)]
        pub fn $get(&self) -> u128 { u128::from_le_bytes(self.$field) }
        #[inline(always)]
        pub fn $set(&mut self, v: u128) { self.$field = v.to_le_bytes(); }
    };
}

impl Vault {
    le_field!(equity_q, set_equity_q, equity_q, u64);
    le_field!(receipt_supply, set_receipt_supply, receipt_supply, u64);
    le_field!(sync_slot, set_sync_slot, sync_slot, u64);
    le_field!(oracle_price_raw_e12, set_oracle_price_raw_e12, oracle_price_raw_e12, u64);
    le_field!(hedge_base_amount, set_hedge_base_amount, hedge_base_amount, u64);
    le_field!(lp_base_amount, set_lp_base_amount, lp_base_amount, u64);
    le_field!(health_x100, set_health_x100, health_x100, u32);
    le_field!(tick_lower, set_tick_lower, tick_lower, i32);
    le_field!(tick_upper, set_tick_upper, tick_upper, i32);
    le_field!(liquidity, set_liquidity, liquidity, u128);
    le_field!(epoch, set_epoch, epoch, u64);
    le_field!(epoch_supply_start, set_epoch_supply_start, epoch_supply_start, u64);
    le_field!(epoch_minted, set_epoch_minted, epoch_minted, u64);
    le_field!(epoch_burned, set_epoch_burned, epoch_burned, u64);
    le_field!(phase_started_slot, set_phase_started_slot, phase_started_slot, u64);

    #[inline(always)]
    pub fn phase(&self) -> Result<Phase, ProgramError> { Phase::from_u8(self.phase) }
    #[inline(always)]
    pub fn hedge_kind(&self) -> Result<HedgeKind, ProgramError> { HedgeKind::from_u8(self.hedge_kind) }
    #[inline(always)]
    pub fn has_position(&self) -> bool { self.position != [0u8; 32] }

    /// Borrow the vault from raw account data (checks discriminator + version + length).
    pub fn load(data: &[u8]) -> Result<&Vault, ProgramError> {
        if data.len() < VAULT_LEN {
            return Err(ProgramError::AccountDataTooSmall);
        }
        // SAFETY: repr(C), only u8 arrays ⇒ alignment 1, any bytes valid.
        let v = unsafe { &*(data.as_ptr() as *const Vault) };
        if v.disc != VAULT_DISC || v.version != VAULT_VERSION {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(v)
    }

    /// Mutable view through a shared `AccountView`. The runtime account buffer is writable and
    /// pinocchio's borrow flag is checked first, so this is sound as long as the caller holds no
    /// `Ref`/`RefMut` of the same account and performs no CPI while the `&mut Vault` is alive.
    pub fn load_mut_acc(acc: &pinocchio::AccountView) -> Result<&mut Vault, ProgramError> {
        acc.check_borrow_mut()?;
        let len = acc.data_len();
        // SAFETY: see above; data_ptr points at the runtime-owned, writable account data.
        let data = unsafe { core::slice::from_raw_parts_mut(acc.data_ptr() as *mut u8, len) };
        Self::load_mut(data)
    }

    pub fn load_uninit_acc(acc: &pinocchio::AccountView) -> Result<&mut Vault, ProgramError> {
        acc.check_borrow_mut()?;
        let len = acc.data_len();
        let data = unsafe { core::slice::from_raw_parts_mut(acc.data_ptr() as *mut u8, len) };
        Self::load_uninit(data)
    }

    pub fn load_mut(data: &mut [u8]) -> Result<&mut Vault, ProgramError> {
        if data.len() < VAULT_LEN {
            return Err(ProgramError::AccountDataTooSmall);
        }
        let v = unsafe { &mut *(data.as_mut_ptr() as *mut Vault) };
        if v.disc != VAULT_DISC || v.version != VAULT_VERSION {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(v)
    }

    /// For init: view uninitialized bytes as a Vault (no discriminator check).
    pub fn load_uninit(data: &mut [u8]) -> Result<&mut Vault, ProgramError> {
        if data.len() < VAULT_LEN {
            return Err(ProgramError::AccountDataTooSmall);
        }
        let v = unsafe { &mut *(data.as_mut_ptr() as *mut Vault) };
        if v.disc != [0u8; 8] {
            return Err(ProgramError::AccountAlreadyInitialized);
        }
        Ok(v)
    }

    #[inline(always)]
    pub fn pk(bytes: &[u8; 32]) -> &Address {
        // SAFETY: Address is a transparent [u8; 32]
        unsafe { &*(bytes.as_ptr() as *const Address) }
    }

    pub fn require_phase(&self, p: Phase) -> Result<(), ProgramError> {
        if self.phase()? != p {
            return Err(crate::error::VaultError::WrongPhase.into());
        }
        Ok(())
    }
}

const _: () = assert!(core::mem::align_of::<Vault>() == 1);
const _: () = assert!(core::mem::align_of::<Params>() == 1);
