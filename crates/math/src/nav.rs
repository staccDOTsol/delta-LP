//! Vault-level math: oracle → sqrt price, fair LP value, delta and health guards.

use crate::{clmm, u256::U256};

/// floor(sqrt(n)) for a 256-bit integer (Newton, ~9 iterations of 256-bit division).
pub fn isqrt_u256(n: &U256) -> U256 {
    if n.is_zero() {
        return U256::ZERO;
    }
    let bits = n.bits();
    let mut x = U256::from_u128(1).shl((bits + 1) / 2);
    loop {
        let (q, _) = n.div_rem(&x);
        let y = x.add(&q).shr(1);
        if y.cmp(&x) != core::cmp::Ordering::Less {
            return x;
        }
        x = y;
    }
}

/// sqrt_price in Q64.64 from a raw price (quote_raw per base_raw) scaled by 1e12:
/// sqrt_x64 = sqrt(P · 2^128) = sqrt(p_e12 · 2^128 / 1e12)
pub fn sqrt_price_x64_from_price_e12(p_e12: u64) -> Option<u128> {
    if p_e12 == 0 {
        return None;
    }
    let n = U256::from_u128(p_e12 as u128).shl(128);
    let (q, _) = n.div_rem(&U256::from_u128(1_000_000_000_000));
    let s = isqrt_u256(&q).to_u128()?;
    if !(clmm::MIN_SQRT_PRICE_X64..=clmm::MAX_SQRT_PRICE_X64).contains(&s) {
        return None;
    }
    Some(s)
}

/// |a − b| in bps of b.
pub fn deviation_bps(a: u128, b: u128) -> u128 {
    if b == 0 {
        return u128::MAX;
    }
    let d = if a > b { a - b } else { b - a };
    d.saturating_mul(10_000) / b
}

/// Fair LP amounts (a, b) at the oracle-implied price, independent of the pool's current tick.
pub fn lp_fair_amounts(sqrt_oracle: u128, tick_lower: i32, tick_upper: i32, liquidity: u128) -> Result<(u64, u64), clmm::ClmmError> {
    let tick = clmm::tick_index_from_sqrt_price(&sqrt_oracle);
    clmm::position_amounts(tick, sqrt_oracle, tick_lower, tick_upper, liquidity, false)
}

/// Net base delta check: |lp_base + idle_base − hedge_base| ≤ max(eps_bps/1e4 · max(hedge, long), dust_base)
pub fn delta_within(lp_base: u64, idle_base: u64, hedge_base: u64, eps_bps: u16, dust_base: u64) -> bool {
    let long = lp_base as u128 + idle_base as u128;
    let short = hedge_base as u128;
    let net = if long > short { long - short } else { short - long };
    let gross = long.max(short);
    net <= dust_base as u128 || net.saturating_mul(10_000) <= gross.saturating_mul(eps_bps as u128)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqrt256() {
        assert_eq!(isqrt_u256(&U256::from_u128(0)).to_u128(), Some(0));
        assert_eq!(isqrt_u256(&U256::from_u128(1)).to_u128(), Some(1));
        assert_eq!(isqrt_u256(&U256::from_u128(1 << 100)).to_u128(), Some(1 << 50));
        let big = U256::from_u128(u128::MAX).shl(128); // (2^128-1)·2^128
        let r = isqrt_u256(&big).to_u128().unwrap();
        // sqrt ≈ 2^128 − 1/2 → floor 2^128 − 1
        assert_eq!(r, u128::MAX);
    }

    #[test]
    fn oracle_sqrt_matches_pool_tick() {
        // roundtrip: tick → sqrt → price_e12 → sqrt' → tick'
        for tick in [-21018, -30000, -1, 0, 1000, 100_000] {
            let pool = clmm::sqrt_price_from_tick_index(tick);
            let p_e12 = clmm::price_x64_to_scaled(pool, 1_000_000_000_000).unwrap() as u64;
            let s = sqrt_price_x64_from_price_e12(p_e12).unwrap();
            let t = clmm::tick_index_from_sqrt_price(&s);
            assert!((t - tick).abs() <= 1, "tick {t} vs {tick}");
            assert!(deviation_bps(pool, s) < 2, "{}", deviation_bps(pool, s));
        }
        // $122.2197 SOL/USDC (Scope, 2026-09-25) → P_raw·1e12 = 122_219_700_000 → within a few ticks of the pool's -21018
        let s = sqrt_price_x64_from_price_e12(122_219_700_000).unwrap();
        let t = clmm::tick_index_from_sqrt_price(&s);
        assert!((t - (-21018)).abs() <= 5, "tick {t}");
    }

    #[test]
    fn delta_guard() {
        assert!(delta_within(1_000, 0, 1_000, 1, 0));
        assert!(delta_within(1_000, 10, 1_000, 100, 0)); // 1% eps, 1% off
        assert!(!delta_within(1_000, 11, 1_000, 100, 0));
        assert!(delta_within(0, 0, 0, 1, 0));
        assert!(!delta_within(0, 0, 5, 100, 0));
        assert!(delta_within(0, 0, 5, 100, 5)); // dust
        assert!(!delta_within(0, 0, 6, 100, 5));
    }
}
