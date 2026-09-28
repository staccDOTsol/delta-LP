use pinocchio::error::ProgramError;

#[repr(u32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VaultError {
    WrongPhase = 1000,
    NotCrank,
    NotAuthority,
    StaleSync,
    UnderHealth,
    PriceDeviation,
    DeltaTooLarge,
    InsufficientIdleQuote,
    EpochMintCap,
    EpochBurnCap,
    SlippageExceeded,
    BadVenueAccount,
    BadPda,
    ZeroAmount,
    MathOverflow,
    SwapTooLarge,
    LeftoverLiquidity,
    ReceiptMintMismatch,
    HedgeKindMismatch,
    UnexpectedState,
    PositionMissing,
}

impl From<VaultError> for ProgramError {
    fn from(e: VaultError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

#[inline(always)]
pub fn overflow() -> ProgramError {
    VaultError::MathOverflow.into()
}
