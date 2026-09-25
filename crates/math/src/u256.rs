//! Minimal 256-bit unsigned integer for mul/div of Q64.64 fixed-point values.
//! Only what the CLMM token math needs: u128*u128 -> U256, shift, div by u128/U256.

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct U256 {
    /// little-endian 64-bit limbs
    pub w: [u64; 4],
}

impl U256 {
    pub const ZERO: U256 = U256 { w: [0; 4] };

    #[inline]
    pub const fn from_u128(v: u128) -> U256 {
        U256 { w: [v as u64, (v >> 64) as u64, 0, 0] }
    }

    #[inline]
    pub fn is_zero(&self) -> bool {
        self.w == [0; 4]
    }

    /// Full-width product of two u128.
    pub fn mul_u128(a: u128, b: u128) -> U256 {
        let a0 = a as u64 as u128;
        let a1 = (a >> 64) as u64 as u128;
        let b0 = b as u64 as u128;
        let b1 = (b >> 64) as u64 as u128;
        let p00 = a0 * b0;
        let p01 = a0 * b1;
        let p10 = a1 * b0;
        let p11 = a1 * b1;
        let mid = (p00 >> 64) + (p01 as u64 as u128) + (p10 as u64 as u128);
        let w0 = p00 as u64;
        let w1 = mid as u64;
        let hi = p11 + (p01 >> 64) + (p10 >> 64) + (mid >> 64);
        U256 { w: [w0, w1, hi as u64, (hi >> 64) as u64] }
    }

    #[inline]
    pub fn shl_64(&self) -> Option<U256> {
        if self.w[3] != 0 {
            return None;
        }
        Some(U256 { w: [0, self.w[0], self.w[1], self.w[2]] })
    }

    pub fn shr(&self, n: u32) -> U256 {
        if n >= 256 {
            return U256::ZERO;
        }
        let words = (n / 64) as usize;
        let bits = n % 64;
        let mut out = [0u64; 4];
        for i in 0..4 {
            let src = i + words;
            if src < 4 {
                let mut v = self.w[src] >> bits;
                if bits != 0 && src + 1 < 4 {
                    v |= self.w[src + 1] << (64 - bits);
                }
                out[i] = v;
            }
        }
        U256 { w: out }
    }

    pub fn shl(&self, n: u32) -> U256 {
        if n >= 256 {
            return U256::ZERO;
        }
        let words = (n / 64) as usize;
        let bits = n % 64;
        let mut out = [0u64; 4];
        for i in (0..4).rev() {
            if i < words {
                continue;
            }
            let src = i - words;
            let mut v = self.w[src] << bits;
            if bits != 0 && src >= 1 {
                v |= self.w[src - 1] >> (64 - bits);
            }
            out[i] = v;
        }
        U256 { w: out }
    }

    pub fn bits(&self) -> u32 {
        for i in (0..4).rev() {
            if self.w[i] != 0 {
                return (i as u32) * 64 + (64 - self.w[i].leading_zeros());
            }
        }
        0
    }

    pub fn cmp(&self, o: &U256) -> core::cmp::Ordering {
        for i in (0..4).rev() {
            if self.w[i] != o.w[i] {
                return self.w[i].cmp(&o.w[i]);
            }
        }
        core::cmp::Ordering::Equal
    }

    pub fn add(&self, o: &U256) -> U256 {
        let mut out = [0u64; 4];
        let mut carry = 0u128;
        for i in 0..4 {
            let s = self.w[i] as u128 + o.w[i] as u128 + carry;
            out[i] = s as u64;
            carry = s >> 64;
        }
        U256 { w: out }
    }

    pub fn sub(&self, o: &U256) -> U256 {
        let mut out = [0u64; 4];
        let mut borrow = 0i128;
        for i in 0..4 {
            let d = self.w[i] as i128 - o.w[i] as i128 - borrow;
            if d < 0 {
                out[i] = (d + (1i128 << 64)) as u64;
                borrow = 1;
            } else {
                out[i] = d as u64;
                borrow = 0;
            }
        }
        U256 { w: out }
    }

    /// (quotient, remainder). Simple restoring long division — fine for
    /// the handful of calls per instruction.
    pub fn div_rem(&self, d: &U256) -> (U256, U256) {
        debug_assert!(!d.is_zero());
        if self.cmp(d) == core::cmp::Ordering::Less {
            return (U256::ZERO, *self);
        }
        let shift = self.bits() - d.bits();
        let mut divisor = d.shl(shift);
        let mut rem = *self;
        let mut q = U256::ZERO;
        for i in (0..=shift).rev() {
            if rem.cmp(&divisor) != core::cmp::Ordering::Less {
                rem = rem.sub(&divisor);
                q.w[(i / 64) as usize] |= 1u64 << (i % 64);
            }
            divisor = divisor.shr(1);
        }
        (q, rem)
    }

    #[inline]
    pub fn to_u128(&self) -> Option<u128> {
        if self.w[2] != 0 || self.w[3] != 0 {
            return None;
        }
        Some(self.w[0] as u128 | ((self.w[1] as u128) << 64))
    }
}

/// floor(a * b / d) with a 256-bit intermediate.
pub fn mul_div_u128(a: u128, b: u128, d: u128) -> Option<u128> {
    if d == 0 {
        return None;
    }
    let (q, _) = U256::mul_u128(a, b).div_rem(&U256::from_u128(d));
    q.to_u128()
}

/// ceil(a * b / d)
pub fn mul_div_ceil_u128(a: u128, b: u128, d: u128) -> Option<u128> {
    if d == 0 {
        return None;
    }
    let (q, r) = U256::mul_u128(a, b).div_rem(&U256::from_u128(d));
    let q = q.to_u128()?;
    if r.is_zero() {
        Some(q)
    } else {
        q.checked_add(1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mul_div_roundtrip() {
        let a = u128::MAX / 3;
        let b = 7u128;
        assert_eq!(mul_div_u128(a, b, 7).unwrap(), a);
        assert_eq!(mul_div_u128(1 << 100, 1 << 100, 1 << 100).unwrap(), 1 << 100);
        assert_eq!(mul_div_ceil_u128(10, 10, 3).unwrap(), 34);
        assert_eq!(mul_div_u128(10, 10, 3).unwrap(), 33);
    }

    #[test]
    fn shifts() {
        let x = U256::from_u128(1);
        assert_eq!(x.shl(200).shr(200), x);
        assert_eq!(x.shl(64), x.shl_64().unwrap());
        assert_eq!(U256::from_u128(u128::MAX).shl_64().unwrap().shr(64).to_u128(), Some(u128::MAX));
    }
}
