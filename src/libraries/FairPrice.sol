// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {FullMath} from "@uniswap/v3-core/contracts/libraries/FullMath.sol";
import {TickMath} from "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import {IUniswapV3Pool} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import {AggregatorV3Interface} from "../interfaces/AggregatorV3Interface.sol";

/// @notice Fair price for the vault's NAV: Chainlink (quote-adjusted) while the equity feed is
/// fresh (market hours), else the pool's own TWAP (weekends / overnight — the AMM is the only
/// 24/7 stock mark on Robinhood Chain). Returned as a Uniswap sqrtPriceX96 of token1/token0 so the
/// LP math is exact and manipulation-resistant (never the pool's current tick).
library FairPrice {
    uint256 internal constant Q96 = 2 ** 96;

    enum Mode {
        Chainlink,
        Twap
    }

    struct Feeds {
        AggregatorV3Interface base; // base/USD (Chainlink "Robinhood X / USD", 8 dp)
        AggregatorV3Interface quote; // quote/USD (USDG/USD, 8 dp)
        uint32 maxAge; // seconds a feed may be stale before we fall back to TWAP
        uint32 twapWindow; // seconds
    }

    /// @return sqrtPriceX96 fair sqrt(token1/token0) in Q64.96; mode which source was used
    function fairSqrtPriceX96(
        IUniswapV3Pool pool,
        Feeds memory f,
        bool baseIsToken0,
        uint8 baseDecimals,
        uint8 quoteDecimals
    ) internal view returns (uint160 sqrtPriceX96, Mode mode) {
        (bool ok, uint256 baseUsd, uint256 quoteUsd) = _readFeeds(f);
        if (ok) {
            // raw price of token1 per token0
            // quote per base (raw) = baseUsd/quoteUsd · 10^qd / 10^bd
            uint256 num;
            uint256 den;
            if (baseIsToken0) {
                // token1/token0 = quote/base
                num = baseUsd * 10 ** quoteDecimals;
                den = quoteUsd * 10 ** baseDecimals;
            } else {
                // token1/token0 = base/quote
                num = quoteUsd * 10 ** baseDecimals;
                den = baseUsd * 10 ** quoteDecimals;
            }
            // sqrtPriceX96 = sqrt(num/den · 2^192) = sqrt(num · 2^192 / den)
            uint256 ratioX192 = FullMath.mulDiv(num, 2 ** 192, den);
            uint256 s = _sqrt(ratioX192);
            require(s >= TickMath.MIN_SQRT_RATIO && s < TickMath.MAX_SQRT_RATIO, "fair: oob");
            return (uint160(s), Mode.Chainlink);
        }
        return (twapSqrtPriceX96(pool, f.twapWindow), Mode.Twap);
    }

    function twapSqrtPriceX96(IUniswapV3Pool pool, uint32 window) internal view returns (uint160) {
        require(window > 0, "fair: window");
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = window;
        secondsAgos[1] = 0;
        (int56[] memory tickCumulatives,) = pool.observe(secondsAgos);
        int56 delta = tickCumulatives[1] - tickCumulatives[0];
        int24 meanTick = int24(delta / int56(uint56(window)));
        // round toward negative infinity (Uniswap OracleLibrary convention)
        if (delta < 0 && (delta % int56(uint56(window)) != 0)) meanTick--;
        return TickMath.getSqrtRatioAtTick(meanTick);
    }

    function _readFeeds(Feeds memory f) private view returns (bool ok, uint256 baseUsd, uint256 quoteUsd) {
        (, int256 a, , uint256 ta, ) = f.base.latestRoundData();
        (, int256 b, , uint256 tb, ) = f.quote.latestRoundData();
        if (a <= 0 || b <= 0) return (false, 0, 0);
        if (ta + f.maxAge < block.timestamp || tb + f.maxAge < block.timestamp) return (false, 0, 0);
        uint8 da = f.base.decimals();
        uint8 db = f.quote.decimals();
        // normalise both to 18 dp so the ratio is decimal-free
        baseUsd = uint256(a) * 10 ** (18 - da);
        quoteUsd = uint256(b) * 10 ** (18 - db);
        ok = true;
    }

    /// @dev |a − b| in bps of b, for sqrt prices (≈ half the price deviation)
    function deviationBps(uint256 a, uint256 b) internal pure returns (uint256) {
        uint256 d = a > b ? a - b : b - a;
        return FullMath.mulDiv(d, 10_000, b);
    }

    /// base amount → quote amount at sqrtPriceX96 (token1/token0)
    function baseToQuote(uint256 baseAmount, uint160 sqrtPriceX96, bool baseIsToken0) internal pure returns (uint256) {
        if (baseIsToken0) {
            // quote = base · P, P = sqrt²/2^192
            return FullMath.mulDiv(FullMath.mulDiv(baseAmount, sqrtPriceX96, Q96), sqrtPriceX96, Q96);
        } else {
            // quote = base / P
            return FullMath.mulDiv(FullMath.mulDiv(baseAmount, Q96, sqrtPriceX96), Q96, sqrtPriceX96);
        }
    }

    function _sqrt(uint256 y) private pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }
}
