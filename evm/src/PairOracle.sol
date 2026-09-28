// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IOracle} from "morpho-blue/interfaces/IOracle.sol";
import {FullMath} from "@uniswap/v3-core/contracts/libraries/FullMath.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";

/// @notice Morpho IOracle for a (loan = stock, collateral = USDG) market from two Chainlink USD
/// feeds: price = collateral value in loan units, scaled 1e36 · 10^(loanDec − collDec).
/// Mirrors MorphoChainlinkOracleV2 semantics (no staleness revert — Morpho's liquidation path
/// must never brick; staleness is the vault's concern, not the market's).
contract PairOracle is IOracle {
    AggregatorV3Interface public immutable loanFeed; // stock / USD
    AggregatorV3Interface public immutable collFeed; // USDG / USD
    uint256 public immutable scale; // 1e36 · 10^(loanDec − collDec) · 10^(collFeedDec − loanFeedDec)

    constructor(AggregatorV3Interface loanFeed_, AggregatorV3Interface collFeed_, uint8 loanDecimals, uint8 collDecimals) {
        loanFeed = loanFeed_;
        collFeed = collFeed_;
        uint256 s = 1e36 * 10 ** loanDecimals / 10 ** collDecimals;
        s = s * 10 ** loanFeed_.decimals() / 10 ** collFeed_.decimals();
        scale = s;
    }

    function price() external view returns (uint256) {
        (, int256 l,,,) = loanFeed.latestRoundData();
        (, int256 c,,,) = collFeed.latestRoundData();
        require(l > 0 && c > 0, "oracle: bad answer");
        return FullMath.mulDiv(uint256(c), scale, uint256(l));
    }
}
