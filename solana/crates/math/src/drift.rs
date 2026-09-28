//! Drift / Velocity (protocol-v2 ≥ 2.150) margin math, ported from
//! `math/margin.rs`, `math/position.rs`, `math/funding.rs`, `math/spot_balance.rs`.
//! Only the maintenance-margin path for a user that holds exactly:
//!   • one quote spot deposit (USDC/USDT, weight 100%)
//!   • one perp position (our short), no open orders, no LP shares
//! Anything else is a vault invariant violation and is rejected upstream.

pub const BASE_PRECISION: u128 = 1_000_000_000; // 1e9
pub const PRICE_PRECISION: u128 = 1_000_000; // 1e6
pub const QUOTE_PRECISION: u128 = 1_000_000; // 1e6
pub const MARGIN_PRECISION: u128 = 10_000; // 1e4
pub const SPOT_WEIGHT_PRECISION: u128 = 10_000;
pub const SPOT_IMF_PRECISION: u128 = 1_000_000;
pub const FUNDING_RATE_BUFFER: u128 = 1_000;
pub const AMM_TO_QUOTE_PRECISION_RATIO: i128 = 1_000; // 1e9 / 1e6
pub const SPOT_CUMULATIVE_INTEREST_PRECISION: u128 = 10_000_000_000; // 1e10

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DriftMathError {
    Overflow,
    BadInput,
}

/// Integer sqrt (floor) for u128.
pub fn isqrt_u128(n: u128) -> u128 {
    if n < 2 {
        return n;
    }
    let mut x = 1u128 << ((128 - n.leading_zeros()).div_ceil(2));
    loop {
        let y = (x + n / x) >> 1;
        if y >= x {
            return x;
        }
        x = y;
    }
}

/// `calculate_size_premium_liability_weight(size, imf_factor, liability_weight, MARGIN_PRECISION, bounded=true)`
/// size in BASE_PRECISION (1e9). Returns a margin ratio in MARGIN_PRECISION (1e4).
pub fn size_premium_margin_ratio(size: u128, imf_factor: u32, margin_ratio: u32) -> Result<u32, DriftMathError> {
    if imf_factor == 0 {
        return Ok(margin_ratio);
    }
    let size_sqrt = isqrt_u128(size.checked_mul(10).ok_or(DriftMathError::Overflow)? + 1); // 1e9 -> 1e10 -> 1e5
    let w = margin_ratio as u128;
    let numerator = w - w / 5;
    let premium = numerator
        + size_sqrt
            .checked_mul(imf_factor as u128)
            .ok_or(DriftMathError::Overflow)?
            / (100_000 * SPOT_IMF_PRECISION / MARGIN_PRECISION); // 1e5 * 1e2
    let premium: u32 = premium.try_into().map_err(|_| DriftMathError::Overflow)?;
    Ok(margin_ratio.max(premium))
}

/// Quote token amount (QUOTE_PRECISION) of a spot deposit with `scaled_balance` (SPOT_BALANCE_PRECISION 1e9).
/// `get_token_amount(balance, spot_market, Deposit)` = balance · cumulative_deposit_interest / 10^(19 − decimals)
pub fn deposit_token_amount(scaled_balance: u128, cumulative_deposit_interest: u128, decimals: u32) -> Result<u128, DriftMathError> {
    let precision_decrease = 10u128.pow(19u32.checked_sub(decimals).ok_or(DriftMathError::BadInput)?);
    scaled_balance
        .checked_mul(cumulative_deposit_interest)
        .ok_or(DriftMathError::Overflow)
        .map(|v| v / precision_decrease)
}

/// Unsettled funding for the position (QUOTE_PRECISION, signed). Longs pay shorts when the
/// funding delta is positive. `calculate_funding_payment`.
pub fn funding_payment(amm_cumulative_funding_rate: i128, last_cumulative_funding_rate: i64, base_asset_amount: i64) -> Result<i64, DriftMathError> {
    let delta = amm_cumulative_funding_rate
        .checked_sub(last_cumulative_funding_rate as i128)
        .ok_or(DriftMathError::Overflow)?;
    if delta == 0 || base_asset_amount == 0 {
        return Ok(0);
    }
    let delta_sign: i128 = if delta > 0 { 1 } else { -1 };
    // |delta| · |base| / PRICE_PRECISION / FUNDING_RATE_BUFFER  (U192 in drift; fits u128 comfortably here:
    // |delta| < 2^100 realistic, |base| < 2^63)
    let magnitude = crate::u256::mul_div_u128(delta.unsigned_abs(), base_asset_amount.unsigned_abs() as u128, PRICE_PRECISION)
        .ok_or(DriftMathError::Overflow)?
        / FUNDING_RATE_BUFFER;
    let payment_sign: i128 = if base_asset_amount > 0 { -1 } else { 1 };
    let payment = (magnitude as i128) * payment_sign * delta_sign;
    let out = payment / AMM_TO_QUOTE_PRECISION_RATIO;
    i64::try_from(out).map_err(|_| DriftMathError::Overflow)
}

/// (base_asset_value: u128 QUOTE, unrealized_pnl: i128 QUOTE) — `calculate_base_asset_value_and_pnl_with_oracle_price`.
pub fn base_value_and_pnl(base_asset_amount: i64, quote_asset_amount: i64, oracle_price: i64) -> Result<(u128, i128), DriftMathError> {
    if base_asset_amount == 0 {
        return Ok((0, quote_asset_amount as i128));
    }
    let price = if oracle_price > 0 { oracle_price as i128 } else { 0 };
    let base_value = (base_asset_amount as i128)
        .checked_mul(price)
        .ok_or(DriftMathError::Overflow)?
        / (BASE_PRECISION as i128);
    let pnl = base_value.checked_add(quote_asset_amount as i128).ok_or(DriftMathError::Overflow)?;
    Ok((base_value.unsigned_abs(), pnl))
}

/// Everything the vault needs from the perp leg, valued at `oracle_price` (PRICE_PRECISION).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PerpLeg {
    /// maintenance margin requirement, QUOTE
    pub margin_requirement: u128,
    /// pnl + unsettled funding, weighted for maintenance, QUOTE (signed)
    pub weighted_unrealized_pnl: i128,
    /// |base| · price, QUOTE
    pub liability_value: u128,
    /// raw unsettled funding, QUOTE (signed)
    pub unsettled_funding: i64,
}

pub struct PerpInputs {
    pub base_asset_amount: i64,
    pub quote_asset_amount: i64,
    pub last_cumulative_funding_rate: i64,
    pub cumulative_funding_rate_long: i128,
    pub cumulative_funding_rate_short: i128,
    pub oracle_price: i64,
    pub margin_ratio_maintenance: u32,
    pub imf_factor: u32,
    /// `unrealized_pnl_maintenance_asset_weight` (SPOT_WEIGHT_PRECISION); 0 → treat as 100%
    pub unrealized_pnl_maintenance_asset_weight: u32,
    /// user.max_margin_ratio / position custom margin ratio (0 = none)
    pub user_custom_margin_ratio: u32,
}

/// Maintenance-type valuation of a single perp position with no open orders.
/// Mirrors `calculate_perp_position_value_and_pnl(.., MarginRequirementType::Maintenance, ..)`
/// with strict quote price = 1.0 (quote is a stablecoin spot market; the vault treats
/// the quote at par).
pub fn perp_leg_maintenance(i: &PerpInputs) -> Result<PerpLeg, DriftMathError> {
    let cum = if i.base_asset_amount > 0 { i.cumulative_funding_rate_long } else { i.cumulative_funding_rate_short };
    let unsettled_funding = funding_payment(cum, i.last_cumulative_funding_rate, i.base_asset_amount)?;
    let (_base_value, unrealized_pnl) = base_value_and_pnl(i.base_asset_amount, i.quote_asset_amount, i.oracle_price)?;
    let total_unrealized_pnl = unrealized_pnl.checked_add(unsettled_funding as i128).ok_or(DriftMathError::Overflow)?;

    // worst case with no open orders = the position itself
    let worst_case_base = i.base_asset_amount as i128;
    let liability_value = (worst_case_base.unsigned_abs())
        .checked_mul(i.oracle_price.max(0) as u128)
        .ok_or(DriftMathError::Overflow)?
        / BASE_PRECISION;

    let margin_ratio = i
        .user_custom_margin_ratio
        .max(size_premium_margin_ratio(worst_case_base.unsigned_abs(), i.imf_factor, i.margin_ratio_maintenance)?);
    let margin_requirement = liability_value
        .checked_mul(margin_ratio as u128)
        .ok_or(DriftMathError::Overflow)?
        / MARGIN_PRECISION;

    // get_unrealized_asset_weight(maintenance): negative pnl at 100%; positive pnl at
    // unrealized_pnl_maintenance_asset_weight (no imf scaling on the maintenance path when
    // unrealized_pnl_imf_factor is 0 — the vault treats any configured weight as given).
    let weight = if total_unrealized_pnl < 0 {
        SPOT_WEIGHT_PRECISION
    } else if i.unrealized_pnl_maintenance_asset_weight == 0 {
        SPOT_WEIGHT_PRECISION
    } else {
        i.unrealized_pnl_maintenance_asset_weight as u128
    };
    let weighted = if weight == SPOT_WEIGHT_PRECISION {
        total_unrealized_pnl
    } else {
        total_unrealized_pnl
            .checked_mul(weight as i128)
            .ok_or(DriftMathError::Overflow)?
            / (SPOT_WEIGHT_PRECISION as i128)
    };
    Ok(PerpLeg {
        margin_requirement,
        weighted_unrealized_pnl: weighted,
        liability_value,
        unsettled_funding,
    })
}

/// total_collateral (signed QUOTE) and maintenance margin requirement for the vault's Drift user:
/// quote deposit (weight 100%) + weighted perp pnl. Returns (total_collateral, margin_requirement).
pub fn user_maintenance(quote_deposit_tokens: u128, leg: &PerpLeg) -> Result<(i128, u128), DriftMathError> {
    let total = (quote_deposit_tokens as i128)
        .checked_add(leg.weighted_unrealized_pnl)
        .ok_or(DriftMathError::Overflow)?;
    Ok((total, leg.margin_requirement))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqrt() {
        assert_eq!(isqrt_u128(0), 0);
        assert_eq!(isqrt_u128(1), 1);
        assert_eq!(isqrt_u128(15), 3);
        assert_eq!(isqrt_u128(16), 4);
        assert_eq!(isqrt_u128(10_000_000_001), 100_000);
        assert_eq!(isqrt_u128(u128::MAX), (1u128 << 64) - 1);
    }

    #[test]
    fn size_premium_matches_drift_shape() {
        // SOL-PERP live: imf 50, mmr 300. Small size → unchanged.
        assert_eq!(size_premium_margin_ratio(10 * BASE_PRECISION, 50, 300).unwrap(), 300);
        // huge size → premium kicks in above base ratio
        let big = size_premium_margin_ratio(10_000_000 * BASE_PRECISION, 50, 300).unwrap();
        assert!(big > 300, "{big}");
        assert_eq!(size_premium_margin_ratio(1 << 100, 0, 300).unwrap(), 300);
    }

    #[test]
    fn token_amount_usdc() {
        // cumulative_deposit_interest live ≈ 1.2024851424e10 (i.e. 1.2024851424 × 1e10)
        let bal = 1_000 * 1_000_000_000u128; // 1000 USDC scaled (1e9)
        let amt = deposit_token_amount(bal, 12_024_851_424, 6).unwrap();
        assert_eq!(amt, 1_202_485_142); // ≈ 1202.485142 USDC
    }

    #[test]
    fn funding_sign_conventions() {
        // short (base<0), cumulative rate rose → shorts receive (positive)
        let p = funding_payment(1_000_000_000_000, 0, -10 * BASE_PRECISION as i64).unwrap();
        // |delta|=1e12, base 1e10 → 1e12*1e10/1e6/1e3 = 1e13 /1e3 = 1e10 quote = $10,000?  check units:
        // delta is in FUNDING_RATE_PRECISION (1e9) quote-per-base: 1e12/1e9 = $1000 per base unit… ×10 base = $10,000 = 1e10 quote
        assert_eq!(p, 10_000_000_000);
        let p2 = funding_payment(1_000_000_000_000, 0, 10 * BASE_PRECISION as i64).unwrap();
        assert_eq!(p2, -10_000_000_000);
        assert_eq!(funding_payment(5, 5, -1).unwrap(), 0);
    }

    #[test]
    fn short_leg_valuation() {
        // short 10 SOL entered at $100 (quote_asset_amount = +1000e6), oracle now $120
        let i = PerpInputs {
            base_asset_amount: -10 * BASE_PRECISION as i64,
            quote_asset_amount: 1_000_000_000,
            last_cumulative_funding_rate: 0,
            cumulative_funding_rate_long: 0,
            cumulative_funding_rate_short: 0,
            oracle_price: 120_000_000,
            margin_ratio_maintenance: 300,
            imf_factor: 50,
            unrealized_pnl_maintenance_asset_weight: 10_000,
            user_custom_margin_ratio: 0,
        };
        let leg = perp_leg_maintenance(&i).unwrap();
        assert_eq!(leg.liability_value, 1_200_000_000); // $1200
        assert_eq!(leg.margin_requirement, 36_000_000); // 3% → $36
        assert_eq!(leg.weighted_unrealized_pnl, -200_000_000); // -$200
        let (tc, mm) = user_maintenance(500_000_000, &leg).unwrap();
        assert_eq!(tc, 300_000_000);
        assert_eq!(mm, 36_000_000);
    }
}
