//! Concentrated-liquidity math, ported from Orca Whirlpools (`math/tick_math.rs`,
//! `math/token_math.rs`, `manager/liquidity_manager.rs`). Q64.64 sqrt prices.
//!
//! The one fact the vault relies on:  for an in-range CLMM position with value
//! V(P) = a(P)·P + b(P),  dV/dP = a(P).  So the position's delta in *base units*
//! is exactly its current token-A balance.  The hedge is sized off that number.

use crate::u256::U256;

pub const MAX_TICK_INDEX: i32 = 443636;
pub const MIN_TICK_INDEX: i32 = -443636;
pub const MAX_SQRT_PRICE_X64: u128 = 79226673515401279992447579055;
pub const MIN_SQRT_PRICE_X64: u128 = 4295048016;
pub const TICK_ARRAY_SIZE: i32 = 88;
pub const Q64: u128 = 1u128 << 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClmmError {
    Overflow,
    TickOutOfRange,
    ZeroLiquidity,
}

fn mul_shift_96(n0: u128, n1: u128) -> u128 {
    U256::mul_u128(n0, n1).shr(96).to_u128().expect("mul_shift_96 fits")
}

fn get_sqrt_price_positive_tick(tick: i32) -> u128 {
    let mut ratio: u128 = if tick & 1 != 0 {
        79232123823359799118286999567
    } else {
        79228162514264337593543950336
    };
    if tick & 2 != 0 { ratio = mul_shift_96(ratio, 79236085330515764027303304731); }
    if tick & 4 != 0 { ratio = mul_shift_96(ratio, 79244008939048815603706035061); }
    if tick & 8 != 0 { ratio = mul_shift_96(ratio, 79259858533276714757314932305); }
    if tick & 16 != 0 { ratio = mul_shift_96(ratio, 79291567232598584799939703904); }
    if tick & 32 != 0 { ratio = mul_shift_96(ratio, 79355022692464371645785046466); }
    if tick & 64 != 0 { ratio = mul_shift_96(ratio, 79482085999252804386437311141); }
    if tick & 128 != 0 { ratio = mul_shift_96(ratio, 79736823300114093921829183326); }
    if tick & 256 != 0 { ratio = mul_shift_96(ratio, 80248749790819932309965073892); }
    if tick & 512 != 0 { ratio = mul_shift_96(ratio, 81282483887344747381513967011); }
    if tick & 1024 != 0 { ratio = mul_shift_96(ratio, 83390072131320151908154831281); }
    if tick & 2048 != 0 { ratio = mul_shift_96(ratio, 87770609709833776024991924138); }
    if tick & 4096 != 0 { ratio = mul_shift_96(ratio, 97234110755111693312479820773); }
    if tick & 8192 != 0 { ratio = mul_shift_96(ratio, 119332217159966728226237229890); }
    if tick & 16384 != 0 { ratio = mul_shift_96(ratio, 179736315981702064433883588727); }
    if tick & 32768 != 0 { ratio = mul_shift_96(ratio, 407748233172238350107850275304); }
    if tick & 65536 != 0 { ratio = mul_shift_96(ratio, 2098478828474011932436660412517); }
    if tick & 131072 != 0 { ratio = mul_shift_96(ratio, 55581415166113811149459800483533); }
    if tick & 262144 != 0 { ratio = mul_shift_96(ratio, 38992368544603139932233054999993551); }
    ratio >> 32
}

fn get_sqrt_price_negative_tick(tick: i32) -> u128 {
    let abs_tick = tick.abs();
    let mut ratio: u128 = if abs_tick & 1 != 0 {
        18445821805675392311
    } else {
        18446744073709551616
    };
    if abs_tick & 2 != 0 { ratio = (ratio * 18444899583751176498) >> 64 }
    if abs_tick & 4 != 0 { ratio = (ratio * 18443055278223354162) >> 64 }
    if abs_tick & 8 != 0 { ratio = (ratio * 18439367220385604838) >> 64 }
    if abs_tick & 16 != 0 { ratio = (ratio * 18431993317065449817) >> 64 }
    if abs_tick & 32 != 0 { ratio = (ratio * 18417254355718160513) >> 64 }
    if abs_tick & 64 != 0 { ratio = (ratio * 18387811781193591352) >> 64 }
    if abs_tick & 128 != 0 { ratio = (ratio * 18329067761203520168) >> 64 }
    if abs_tick & 256 != 0 { ratio = (ratio * 18212142134806087854) >> 64 }
    if abs_tick & 512 != 0 { ratio = (ratio * 17980523815641551639) >> 64 }
    if abs_tick & 1024 != 0 { ratio = (ratio * 17526086738831147013) >> 64 }
    if abs_tick & 2048 != 0 { ratio = (ratio * 16651378430235024244) >> 64 }
    if abs_tick & 4096 != 0 { ratio = (ratio * 15030750278693429944) >> 64 }
    if abs_tick & 8192 != 0 { ratio = (ratio * 12247334978882834399) >> 64 }
    if abs_tick & 16384 != 0 { ratio = (ratio * 8131365268884726200) >> 64 }
    if abs_tick & 32768 != 0 { ratio = (ratio * 3584323654723342297) >> 64 }
    if abs_tick & 65536 != 0 { ratio = (ratio * 696457651847595233) >> 64 }
    if abs_tick & 131072 != 0 { ratio = (ratio * 26294789957452057) >> 64 }
    if abs_tick & 262144 != 0 { ratio = (ratio * 37481735321082) >> 64 }
    ratio
}

/// sqrt(1.0001^tick) in Q64.64
pub fn sqrt_price_from_tick_index(tick: i32) -> u128 {
    if tick >= 0 {
        get_sqrt_price_positive_tick(tick)
    } else {
        get_sqrt_price_negative_tick(tick)
    }
}

/// Orca's `tick_index_from_sqrt_price`.
pub fn tick_index_from_sqrt_price(sqrt_price_x64: &u128) -> i32 {
    const LOG_B_2_X32: i128 = 59543866431248i128;
    const BIT_PRECISION: u32 = 14;
    const LOG_B_P_ERR_MARGIN_LOWER_X64: i128 = 184467440737095516i128;
    const LOG_B_P_ERR_MARGIN_UPPER_X64: i128 = 15793534762490258745i128;

    let msb: u32 = 128 - sqrt_price_x64.leading_zeros() - 1;
    let log2p_integer_x32 = (msb as i128 - 64) << 32;
    let mut bit: i128 = 0x8000_0000_0000_0000i128;
    let mut precision = 0;
    let mut log2p_fraction_x64 = 0;
    let mut r = if msb >= 64 {
        sqrt_price_x64 >> (msb - 63)
    } else {
        sqrt_price_x64 << (63 - msb)
    };
    while bit > 0 && precision < BIT_PRECISION {
        r *= r;
        let is_r_more_than_two = r >> 127_u32;
        r >>= 63 + is_r_more_than_two;
        log2p_fraction_x64 += bit * is_r_more_than_two as i128;
        bit >>= 1;
        precision += 1;
    }
    let log2p_fraction_x32 = log2p_fraction_x64 >> 32;
    let log2p_x32 = log2p_integer_x32 + log2p_fraction_x32;
    let logbp_x64 = log2p_x32 * LOG_B_2_X32;
    let tick_low: i32 = ((logbp_x64 - LOG_B_P_ERR_MARGIN_LOWER_X64) >> 64) as i32;
    let tick_high: i32 = ((logbp_x64 + LOG_B_P_ERR_MARGIN_UPPER_X64) >> 64) as i32;
    if tick_low == tick_high {
        tick_low
    } else {
        let actual_tick_high_sqrt_price_x64: u128 = sqrt_price_from_tick_index(tick_high);
        if actual_tick_high_sqrt_price_x64 <= *sqrt_price_x64 {
            tick_high
        } else {
            tick_low
        }
    }
}

#[inline]
fn increasing(a: u128, b: u128) -> (u128, u128) {
    if a > b { (b, a) } else { (a, b) }
}

/// Δa = L · (√Pu − √Pl) / (√Pu · √Pl)
pub fn amount_delta_a(sqrt_price_0: u128, sqrt_price_1: u128, liquidity: u128, round_up: bool) -> Result<u64, ClmmError> {
    let (lo, hi) = increasing(sqrt_price_0, sqrt_price_1);
    let diff = hi - lo;
    let numerator = U256::mul_u128(liquidity, diff).shl_64().ok_or(ClmmError::Overflow)?;
    let denominator = U256::mul_u128(hi, lo);
    let (q, r) = numerator.div_rem(&denominator);
    let q = q.to_u128().ok_or(ClmmError::Overflow)?;
    let q = if round_up && !r.is_zero() { q.checked_add(1).ok_or(ClmmError::Overflow)? } else { q };
    if q > u64::MAX as u128 {
        return Err(ClmmError::Overflow);
    }
    Ok(q as u64)
}

/// Δb = L · (√Pu − √Pl)
pub fn amount_delta_b(sqrt_price_0: u128, sqrt_price_1: u128, liquidity: u128, round_up: bool) -> Result<u64, ClmmError> {
    let (lo, hi) = increasing(sqrt_price_0, sqrt_price_1);
    let n1 = hi - lo;
    if liquidity == 0 || n1 == 0 {
        return Ok(0);
    }
    let p = liquidity.checked_mul(n1).ok_or(ClmmError::Overflow)?;
    let result = (p >> 64) as u64;
    let should_round = round_up && (p & (Q64 - 1) > 0);
    if should_round && result == u64::MAX {
        return Err(ClmmError::Overflow);
    }
    Ok(if should_round { result + 1 } else { result })
}

/// Token amounts (a, b) held by `liquidity` over [tick_lower, tick_upper] at the pool's
/// current tick/sqrt price. `round_up` = true when quoting a deposit, false for a withdrawal
/// (matches Orca's `calculate_liquidity_token_deltas`).
pub fn position_amounts(
    current_tick_index: i32,
    sqrt_price: u128,
    tick_lower: i32,
    tick_upper: i32,
    liquidity: u128,
    round_up: bool,
) -> Result<(u64, u64), ClmmError> {
    if liquidity == 0 {
        return Ok((0, 0));
    }
    let lower = sqrt_price_from_tick_index(tick_lower);
    let upper = sqrt_price_from_tick_index(tick_upper);
    if current_tick_index < tick_lower {
        Ok((amount_delta_a(lower, upper, liquidity, round_up)?, 0))
    } else if current_tick_index < tick_upper {
        Ok((
            amount_delta_a(sqrt_price, upper, liquidity, round_up)?,
            amount_delta_b(lower, sqrt_price, liquidity, round_up)?,
        ))
    } else {
        Ok((0, amount_delta_b(lower, upper, liquidity, round_up)?))
    }
}

/// Largest liquidity that fits both `amount_a` and `amount_b` over the range at the current price
/// (Orca `estimate_max_liquidity_from_token_amounts`, simplified).
pub fn max_liquidity_for_amounts(
    current_tick_index: i32,
    sqrt_price: u128,
    tick_lower: i32,
    tick_upper: i32,
    amount_a: u64,
    amount_b: u64,
) -> Result<u128, ClmmError> {
    let lower = sqrt_price_from_tick_index(tick_lower);
    let upper = sqrt_price_from_tick_index(tick_upper);
    if current_tick_index < tick_lower {
        liquidity_from_a(lower, upper, amount_a)
    } else if current_tick_index < tick_upper {
        let la = liquidity_from_a(sqrt_price, upper, amount_a)?;
        let lb = liquidity_from_b(lower, sqrt_price, amount_b)?;
        Ok(la.min(lb))
    } else {
        liquidity_from_b(lower, upper, amount_b)
    }
}

/// L = a · √Pl · √Pu / (√Pu − √Pl)
pub fn liquidity_from_a(sqrt_price_0: u128, sqrt_price_1: u128, amount_a: u64) -> Result<u128, ClmmError> {
    let (lo, hi) = increasing(sqrt_price_0, sqrt_price_1);
    let diff = hi - lo;
    if diff == 0 {
        return Err(ClmmError::ZeroLiquidity);
    }
    // a * lo * hi / diff / 2^64
    let n = U256::mul_u128(lo, hi); // Q128.128
    let (q, _) = n.div_rem(&U256::from_u128(diff)); // Q64.64
    let q = q.to_u128().ok_or(ClmmError::Overflow)?;
    let out = U256::mul_u128(q, amount_a as u128).shr(64).to_u128().ok_or(ClmmError::Overflow)?;
    Ok(out)
}

/// L = b · 2^64 / (√Pu − √Pl)
pub fn liquidity_from_b(sqrt_price_0: u128, sqrt_price_1: u128, amount_b: u64) -> Result<u128, ClmmError> {
    let (lo, hi) = increasing(sqrt_price_0, sqrt_price_1);
    let diff = hi - lo;
    if diff == 0 {
        return Err(ClmmError::ZeroLiquidity);
    }
    let n = U256::from_u128(amount_b as u128).shl_64().ok_or(ClmmError::Overflow)?;
    let (q, _) = n.div_rem(&U256::from_u128(diff));
    q.to_u128().ok_or(ClmmError::Overflow)
}

/// Price of token A in token B as a fixed-point integer with `scale` (e.g. 1e6 for a 6-decimal
/// quote of a 9-decimal base needs scale·10^(dec_a−dec_b)); this returns P·scale where
/// P = (sqrt_price/2^64)^2 in *raw* units (b_raw per a_raw). Callers apply the decimal shift.
pub fn price_x64_to_scaled(sqrt_price: u128, scale: u128) -> Option<u128> {
    // P·scale = sqrt² · scale / 2^128, computed as ((sqrt² >> 64) · scale) >> 64
    let sq = U256::mul_u128(sqrt_price, sqrt_price); // Q128.128
    let p_x64 = sq.shr(64).to_u128()?; // P·2^64 (fits: price < 2^64)
    U256::mul_u128(p_x64, scale).shr(64).to_u128()
}

/// Start tick of the tick array containing `tick` for `tick_spacing`.
pub fn tick_array_start_index(tick: i32, tick_spacing: u16) -> i32 {
    let ticks_in_array = TICK_ARRAY_SIZE * tick_spacing as i32;
    let real_index = tick.div_euclid(ticks_in_array);
    real_index * ticks_in_array
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tick_sqrt_roundtrip() {
        for t in [-443636, -21018, -1000, -1, 0, 1, 64, 21018, 443636] {
            let s = sqrt_price_from_tick_index(t);
            assert!(s >= MIN_SQRT_PRICE_X64 && s <= MAX_SQRT_PRICE_X64);
            let back = tick_index_from_sqrt_price(&s);
            assert_eq!(back, t, "tick {t}");
        }
        assert_eq!(sqrt_price_from_tick_index(0), Q64);
        assert_eq!(sqrt_price_from_tick_index(MAX_TICK_INDEX), MAX_SQRT_PRICE_X64);
        assert_eq!(sqrt_price_from_tick_index(MIN_TICK_INDEX), MIN_SQRT_PRICE_X64);
    }

    #[test]
    fn sol_usdc_price_from_live_pool() {
        // live Czfq… pool read on 2026-09-25: tick -21018 ≈ $122.25 (9-dec SOL, 6-dec USDC)
        let s = sqrt_price_from_tick_index(-21018);
        // P_raw = 1.0001^-21018 ≈ 1.2225e-7 usdc_raw per sol_raw → ×1e9/1e6 → $122.25
        let p_scaled = price_x64_to_scaled(s, 1_000_000_000_000).unwrap(); // P_raw · 1e12
        // $ = P_raw·1e3 → p_scaled / 1e9
        let dollars = p_scaled as f64 / 1e9;
        assert!((dollars - 122.25).abs() < 0.05, "{dollars}");
    }

    #[test]
    fn delta_equals_amount_a_in_range() {
        // V(P) = a·P + b ; numeric derivative should match a.
        let (tl, tu) = (-21200, -20800);
        let liq: u128 = 5_000_000_000_000;
        let t = -21018;
        let sp = sqrt_price_from_tick_index(t);
        let (a, b) = position_amounts(t, sp, tl, tu, liq, false).unwrap();
        let p = |s: u128| (s as f64 / Q64 as f64).powi(2);
        let value = |s: u128| {
            let tt = tick_index_from_sqrt_price(&s);
            let (aa, bb) = position_amounts(tt, s, tl, tu, liq, false).unwrap();
            aa as f64 * p(s) + bb as f64
        };
        let s1 = sp + sp / 100_000;
        let s0 = sp - sp / 100_000;
        let dv = (value(s1) - value(s0)) / (p(s1) - p(s0));
        assert!((dv - a as f64).abs() / (a as f64) < 1e-3, "dV/dP={dv} a={a} b={b}");
    }

    #[test]
    fn liquidity_roundtrip() {
        let (tl, tu) = (-21200, -20800);
        let t = -21018;
        let sp = sqrt_price_from_tick_index(t);
        let liq: u128 = 123_456_789_000_000;
        let (a, b) = position_amounts(t, sp, tl, tu, liq, true).unwrap();
        let l2 = max_liquidity_for_amounts(t, sp, tl, tu, a, b).unwrap();
        let rel = if l2 > liq { l2 - liq } else { liq - l2 };
        assert!(rel < liq / 1_000_000_000, "{l2} vs {liq}");
        // the amounts needed for l2 (rounded up) never exceed what we started with by more than 1 unit
        let (a2, b2) = position_amounts(t, sp, tl, tu, l2, true).unwrap();
        assert!(a2 <= a + 1 && b2 <= b + 1, "{a2}/{a} {b2}/{b}");
    }

    #[test]
    fn tick_array_start() {
        assert_eq!(tick_array_start_index(-21018, 4), -21120);
        assert_eq!(tick_array_start_index(0, 64), 0);
        assert_eq!(tick_array_start_index(-1, 64), -5632);
    }
}
