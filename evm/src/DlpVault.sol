// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IMorpho, MarketParams, Id, Position, Market} from "morpho-blue/interfaces/IMorpho.sol";
import {IOracle} from "morpho-blue/interfaces/IOracle.sol";
import {MarketParamsLib} from "morpho-blue/libraries/MarketParamsLib.sol";
import {MorphoBalancesLib} from "morpho-blue/libraries/periphery/MorphoBalancesLib.sol";

import {IUniswapV3Pool} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import {IUniswapV3SwapCallback} from "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3SwapCallback.sol";
import {TickMath} from "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v3-core/contracts/libraries/FullMath.sol";
import {LiquidityAmounts} from "@uniswap/v3-periphery/contracts/libraries/LiquidityAmounts.sol";
import {INonfungiblePositionManager} from "@uniswap/v3-periphery/contracts/interfaces/INonfungiblePositionManager.sol";

import {FairPrice} from "./libraries/FairPrice.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";

/// @title dlp — one receipt over (tight-range Uniswap v3 LP) + (Morpho Blue borrow hedge)
/// @notice The vault borrows the base asset (a Robinhood stock token) against quote (USDG)
/// collateral on Morpho and puts it into a tight range with LP quote. For an in-range CLMM
/// position V(P) = a·P + b and dV/dP = a(P), so debt = a(P) ⇒ net delta 0. The receipt is a plain
/// ERC-20 minted/burned at NAV. A crank recenters the range and resizes the debt as one object
/// behind a phase machine; users can only enter or exit when the object is whole (Idle) and the
/// NAV was recomputed in the same block.
contract DlpVault is ERC20, ReentrancyGuard, IUniswapV3SwapCallback {
    using SafeERC20 for IERC20;
    using MarketParamsLib for MarketParams;
    using MorphoBalancesLib for IMorpho;

    // ------------------------------------------------------------------ types

    enum Phase {
        Idle, // deposits/withdrawals allowed
        Pulled, // liquidity pulled + fees collected
        Hedged, // debt/collateral resized for the next range
        Placed // liquidity placed; waiting for End guards
    }

    struct Params {
        uint16 epsBps; // |lpBase + idleBase − debt| ≤ eps · max(...)
        uint16 minHealthX100; // Morpho: (collateral·price·lltv) / debt ≥ minHealth/100
        uint16 maxPriceDevBps; // pool sqrt vs fair sqrt (≈ half the price deviation)
        uint16 maxSwapBps; // single swap notional ≤ bps of equity
        uint16 maxMintBpsPerEpoch; // 0 = uncapped
        uint16 maxBurnBpsPerEpoch; // 0 = uncapped
        uint32 chainlinkMaxAge; // seconds
        uint32 twapWindow; // seconds
    }

    // ------------------------------------------------------------------ immutables

    IUniswapV3Pool public immutable pool;
    INonfungiblePositionManager public immutable npm;
    IMorpho public immutable morpho;
    IERC20 public immutable base; // stock token (18 dp on Robinhood)
    IERC20 public immutable quote; // USDG (6 dp)
    bool public immutable baseIsToken0;
    uint8 public immutable baseDecimals;
    uint8 public immutable quoteDecimals;
    uint24 public immutable poolFee;
    int24 public immutable tickSpacing;
    AggregatorV3Interface public immutable feedBase;
    AggregatorV3Interface public immutable feedQuote;

    // ------------------------------------------------------------------ storage

    MarketParams public market; // Morpho market: loan = base, collateral = quote
    Id public marketId;

    address public authority; // rotates crank/params; never touches funds
    address public crank;
    Params public params;
    bool public depositsEnabled; // closed at deployment until the pilot is ready

    Phase public phase;
    uint64 public epoch;
    uint256 public tokenId; // Uniswap v3 position NFT (0 = none)
    int24 public tickLower;
    int24 public tickUpper;
    uint128 public liquidity;

    // last Sync mirror
    uint256 public syncBlock;
    uint256 public equity; // quote units
    uint160 public fairSqrtPriceX96;
    uint256 public hedgeBase; // Morpho debt in base units
    uint256 public lpBase; // LP base at fair price (incl. fees owed)
    uint32 public healthX100;
    uint8 public flags;
    FairPrice.Mode public priceMode;

    // epoch caps
    uint256 public epochSupplyStart;
    uint256 public epochMinted;
    uint256 public epochBurned;

    uint8 public constant FLAG_UNDER_HEALTH = 1;
    uint8 public constant FLAG_PRICE_DEVIATION = 2;
    uint256 private constant Q96 = 2 ** 96;
    uint256 private constant ORACLE_PRICE_SCALE = 1e36;
    uint256 private constant WAD = 1e18;

    // ------------------------------------------------------------------ events / errors

    event Synced(uint256 equity, uint256 supply, uint160 fairSqrtPriceX96, uint256 hedgeBase, uint256 lpBase, uint32 healthX100, uint8 flags, FairPrice.Mode mode);
    event Deposited(address indexed user, uint256 quoteIn, uint256 sharesOut);
    event Withdrawn(address indexed user, uint256 sharesIn, uint256 quoteOut);
    event PhaseChanged(Phase phase, uint64 epoch);
    event DepositsEnabled(bool enabled);
    event AuthorityChanged(address indexed authority);
    event CrankChanged(address indexed crank);
    event Hedged(int256 collateralDelta, int256 debtDelta, uint256 debtAfter, uint32 healthX100);
    event Placed(uint256 tokenId, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 amount0, uint256 amount1);

    error WrongPhase();
    error NotCrank();
    error NotAuthority();
    error StaleSync();
    error UnderHealth();
    error PriceDeviation();
    error DeltaTooLarge();
    error InsufficientIdleQuote();
    error EpochMintCap();
    error EpochBurnCap();
    error Slippage();
    error SwapTooLarge();
    error ZeroAmount();
    error BadParams();
    error LeftoverLiquidity();
    error DepositsClosed();
    error NoEquity();

    // ------------------------------------------------------------------ constructor

    constructor(
        string memory name_,
        string memory symbol_,
        IUniswapV3Pool pool_,
        INonfungiblePositionManager npm_,
        IMorpho morpho_,
        MarketParams memory market_,
        AggregatorV3Interface feedBase_,
        AggregatorV3Interface feedQuote_,
        address authority_,
        address crank_,
        Params memory params_
    ) ERC20(name_, symbol_) {
        if (authority_ == address(0) || crank_ == address(0)) revert BadParams();
        pool = pool_;
        npm = npm_;
        morpho = morpho_;
        market = market_;
        marketId = market_.id();
        base = IERC20(market_.loanToken);
        quote = IERC20(market_.collateralToken);
        address t0 = pool_.token0();
        address t1 = pool_.token1();
        require((t0 == market_.loanToken && t1 == market_.collateralToken) || (t1 == market_.loanToken && t0 == market_.collateralToken), "pool/market mismatch");
        baseIsToken0 = (t0 == market_.loanToken);
        baseDecimals = ERC20(market_.loanToken).decimals();
        quoteDecimals = ERC20(market_.collateralToken).decimals();
        if (quoteDecimals > 18) revert BadParams();
        poolFee = pool_.fee();
        tickSpacing = pool_.tickSpacing();
        feedBase = feedBase_;
        feedQuote = feedQuote_;
        authority = authority_;
        crank = crank_;
        _setParams(params_);
        // standing approvals: NPM (mint/increase), Morpho (supplyCollateral quote, repay base)
        IERC20(t0).forceApprove(address(npm_), type(uint256).max);
        IERC20(t1).forceApprove(address(npm_), type(uint256).max);
        quote.forceApprove(address(morpho_), type(uint256).max);
        base.forceApprove(address(morpho_), type(uint256).max);
    }

    function decimals() public pure override returns (uint8) {
        return 18;
    }

    // ------------------------------------------------------------------ modifiers

    modifier onlyCrank() {
        if (msg.sender != crank) revert NotCrank();
        _;
    }

    modifier onlyAuthority() {
        if (msg.sender != authority) revert NotAuthority();
        _;
    }

    modifier inPhase(Phase p) {
        if (phase != p) revert WrongPhase();
        _;
    }

    // ------------------------------------------------------------------ admin (no fund control)

    function setCrank(address c) external onlyAuthority {
        if (c == address(0)) revert BadParams();
        crank = c;
        emit CrankChanged(c);
    }

    function setAuthority(address a) external onlyAuthority {
        if (a == address(0)) revert BadParams();
        authority = a;
        emit AuthorityChanged(a);
    }

    function setDepositsEnabled(bool enabled) external onlyAuthority inPhase(Phase.Idle) {
        depositsEnabled = enabled;
        emit DepositsEnabled(enabled);
    }

    function setParams(Params calldata p) external onlyAuthority inPhase(Phase.Idle) {
        _setParams(p);
    }

    function _setParams(Params memory p) internal {
        if (p.epsBps == 0 || p.epsBps > 10_000 || p.maxPriceDevBps == 0 || p.maxPriceDevBps > 10_000) revert BadParams();
        if (p.minHealthX100 < 110 || p.maxSwapBps > 10_000 || p.maxMintBpsPerEpoch > 10_000 || p.maxBurnBpsPerEpoch > 10_000) revert BadParams();
        if (p.twapWindow == 0 || p.chainlinkMaxAge == 0) revert BadParams();
        params = p;
    }

    // ------------------------------------------------------------------ valuation

    struct Snapshot {
        uint256 equity;
        uint160 fairSqrt;
        uint256 idleBase;
        uint256 idleQuote;
        uint256 lpBase;
        uint256 lpQuote;
        uint256 collateral;
        uint256 debt;
        uint32 healthX100;
        uint256 poolDevBps;
        FairPrice.Mode mode;
    }

    function _fairSqrt() internal view returns (uint160 s, FairPrice.Mode mode) {
        FairPrice.Feeds memory f = FairPrice.Feeds({base: feedBase, quote: feedQuote, maxAge: params.chainlinkMaxAge, twapWindow: params.twapWindow});
        return FairPrice.fairSqrtPriceX96(pool, f, baseIsToken0, baseDecimals, quoteDecimals);
    }

    /// @dev LP amounts at the fair sqrt price (never at the pool's current tick) plus fees owed.
    function _lpAmounts(uint160 fairSqrt) internal view returns (uint256 amt0, uint256 amt1) {
        if (tokenId == 0) return (0, 0);
        (,,,,,,, uint128 liq,,, uint128 owed0, uint128 owed1) = npm.positions(tokenId);
        if (liq > 0) {
            (amt0, amt1) = LiquidityAmounts.getAmountsForLiquidity(fairSqrt, TickMath.getSqrtRatioAtTick(tickLower), TickMath.getSqrtRatioAtTick(tickUpper), liq);
        }
        amt0 += owed0;
        amt1 += owed1;
    }

    function _morphoState() internal view returns (uint256 collateral, uint256 debt, uint32 health) {
        Position memory p = morpho.position(marketId, address(this));
        collateral = p.collateral;
        debt = morpho.expectedBorrowAssets(market, address(this));
        if (debt == 0) return (collateral, 0, type(uint32).max);
        uint256 price = IOracle(market.oracle).price();
        uint256 maxBorrow = FullMath.mulDiv(FullMath.mulDiv(collateral, price, ORACLE_PRICE_SCALE), market.lltv, WAD);
        uint256 h = FullMath.mulDiv(maxBorrow, 100, debt);
        health = h > type(uint32).max ? type(uint32).max : uint32(h);
    }

    function snapshot() public view returns (Snapshot memory s) {
        (s.fairSqrt, s.mode) = _fairSqrt();
        (uint256 a0, uint256 a1) = _lpAmounts(s.fairSqrt);
        (s.lpBase, s.lpQuote) = baseIsToken0 ? (a0, a1) : (a1, a0);
        s.idleBase = base.balanceOf(address(this));
        s.idleQuote = quote.balanceOf(address(this));
        (s.collateral, s.debt, s.healthX100) = _morphoState();
        uint256 longQ = FairPrice.baseToQuote(s.lpBase + s.idleBase, s.fairSqrt, baseIsToken0);
        uint256 debtQ = FairPrice.baseToQuote(s.debt, s.fairSqrt, baseIsToken0);
        uint256 assets = longQ + s.lpQuote + s.idleQuote + s.collateral;
        s.equity = assets > debtQ ? assets - debtQ : 0;
        (uint160 spot,,,,,,) = pool.slot0();
        s.poolDevBps = FairPrice.deviationBps(spot, s.fairSqrt) * 2;
    }

    /// @notice Recompute NAV/health/delta from on-chain state. Permissionless and pure.
    function sync() public returns (Snapshot memory s) {
        s = snapshot();
        syncBlock = block.number;
        equity = s.equity;
        fairSqrtPriceX96 = s.fairSqrt;
        hedgeBase = s.debt;
        lpBase = s.lpBase;
        healthX100 = s.healthX100;
        priceMode = s.mode;
        uint8 f;
        if (s.healthX100 < params.minHealthX100) f |= FLAG_UNDER_HEALTH;
        if (s.poolDevBps > params.maxPriceDevBps) f |= FLAG_PRICE_DEVIATION;
        flags = f;
        emit Synced(s.equity, totalSupply(), s.fairSqrt, s.debt, s.lpBase, s.healthX100, f, s.mode);
    }

    // ------------------------------------------------------------------ users

    function deposit(uint256 quoteIn, uint256 minShares, address to) external nonReentrant inPhase(Phase.Idle) returns (uint256 shares) {
        return _deposit(quoteIn, minShares, to);
    }

    /// @notice Refresh NAV and deposit atomically in one wallet transaction.
    function depositWithSync(uint256 quoteIn, uint256 minShares, address to) external nonReentrant inPhase(Phase.Idle) returns (uint256 shares) {
        if (!depositsEnabled) revert DepositsClosed();
        sync();
        return _deposit(quoteIn, minShares, to);
    }

    function _deposit(uint256 quoteIn, uint256 minShares, address to) internal returns (uint256 shares) {
        if (!depositsEnabled) revert DepositsClosed();
        if (quoteIn == 0) revert ZeroAmount();
        if (syncBlock != block.number) revert StaleSync();
        if (flags != 0) {
            if (flags & FLAG_UNDER_HEALTH != 0) revert UnderHealth();
            revert PriceDeviation();
        }
        uint256 supply = totalSupply();
        if (supply == 0) {
            shares = quoteIn * 10 ** (18 - quoteDecimals); // bootstrap 1:1
        } else {
            if (equity == 0) revert NoEquity();
            shares = FullMath.mulDiv(quoteIn, supply, equity);
        }
        if (shares < minShares || shares == 0) revert Slippage();
        if (params.maxMintBpsPerEpoch != 0 && supply != 0) {
            uint256 allowed = FullMath.mulDiv(epochSupplyStart, params.maxMintBpsPerEpoch, 10_000);
            if (epochMinted + shares > allowed) revert EpochMintCap();
        }
        quote.safeTransferFrom(msg.sender, address(this), quoteIn);
        _mint(to, shares);
        equity += quoteIn;
        epochMinted += shares;
        emit Deposited(to, quoteIn, shares);
    }

    /// @notice Pays from idle quote only. If the vault is fully deployed, the crank frees quote first.
    function withdraw(uint256 shares, uint256 minQuote, address to) external nonReentrant inPhase(Phase.Idle) returns (uint256 quoteOut) {
        return _withdraw(shares, minQuote, to);
    }

    /// @notice Refresh NAV and withdraw atomically. Closing deposits never closes exits.
    function withdrawWithSync(uint256 shares, uint256 minQuote, address to) external nonReentrant inPhase(Phase.Idle) returns (uint256 quoteOut) {
        sync();
        return _withdraw(shares, minQuote, to);
    }

    function _withdraw(uint256 shares, uint256 minQuote, address to) internal returns (uint256 quoteOut) {
        if (shares == 0) revert ZeroAmount();
        if (syncBlock != block.number) revert StaleSync();
        if (flags & FLAG_PRICE_DEVIATION != 0) revert PriceDeviation(); // NAV unreliable; under-health exits are fine
        uint256 supply = totalSupply();
        quoteOut = FullMath.mulDiv(shares, equity, supply);
        if (quoteOut < minQuote || quoteOut == 0) revert Slippage();
        if (quote.balanceOf(address(this)) < quoteOut) revert InsufficientIdleQuote();
        if (params.maxBurnBpsPerEpoch != 0) {
            uint256 allowed = FullMath.mulDiv(epochSupplyStart, params.maxBurnBpsPerEpoch, 10_000);
            if (epochBurned + shares > allowed) revert EpochBurnCap();
        }
        _burn(msg.sender, shares);
        equity -= quoteOut;
        epochBurned += shares;
        quote.safeTransfer(to, quoteOut);
        emit Withdrawn(msg.sender, shares, quoteOut);
    }

    // ------------------------------------------------------------------ crank: CLMM leg

    /// @notice Idle → Pulled: pull all liquidity, collect fees, burn the position NFT.
    function begin(uint256 amount0Min, uint256 amount1Min) external onlyCrank inPhase(Phase.Idle) {
        if (tokenId != 0) {
            (,,,,,,, uint128 liq,,,,) = npm.positions(tokenId);
            if (liq > 0) {
                npm.decreaseLiquidity(INonfungiblePositionManager.DecreaseLiquidityParams({tokenId: tokenId, liquidity: liq, amount0Min: amount0Min, amount1Min: amount1Min, deadline: block.timestamp}));
            }
            npm.collect(INonfungiblePositionManager.CollectParams({tokenId: tokenId, recipient: address(this), amount0Max: type(uint128).max, amount1Max: type(uint128).max}));
            npm.burn(tokenId);
            tokenId = 0;
            liquidity = 0;
        }
        phase = Phase.Pulled;
        emit PhaseChanged(phase, epoch);
    }

    /// @notice Recenter inventory with a swap against the pool (Pulled or Hedged).
    /// @param amountSpecified >0 exact input, <0 exact output (Uniswap convention)
    function swap(bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, uint256 otherAmountThreshold) external onlyCrank {
        if (phase != Phase.Pulled && phase != Phase.Hedged) revert WrongPhase();
        uint256 b0 = base.balanceOf(address(this));
        uint256 q0 = quote.balanceOf(address(this));
        (int256 d0, int256 d1) = pool.swap(address(this), zeroForOne, amountSpecified, sqrtPriceLimitX96 == 0 ? (zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1) : sqrtPriceLimitX96, "");
        // slippage: the "other" leg must meet the threshold
        if (amountSpecified > 0) {
            int256 received = zeroForOne ? -d1 : -d0;
            if (uint256(received) < otherAmountThreshold) revert Slippage();
        } else {
            int256 paid = zeroForOne ? d0 : d1;
            if (uint256(paid) > otherAmountThreshold) revert Slippage();
        }
        // notional guard at the last synced fair price
        if (params.maxSwapBps != 0 && fairSqrtPriceX96 != 0) {
            uint256 dBase = _absDiff(base.balanceOf(address(this)), b0);
            uint256 dQuote = _absDiff(quote.balanceOf(address(this)), q0);
            uint256 notional = FairPrice.baseToQuote(dBase, fairSqrtPriceX96, baseIsToken0);
            if (dQuote > notional) notional = dQuote;
            if (notional * 10_000 > equity * params.maxSwapBps) revert SwapTooLarge();
        }
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external override {
        require(msg.sender == address(pool), "cb: pool");
        if (amount0Delta > 0) IERC20(pool.token0()).safeTransfer(msg.sender, uint256(amount0Delta));
        if (amount1Delta > 0) IERC20(pool.token1()).safeTransfer(msg.sender, uint256(amount1Delta));
    }

    /// @notice Hedged → Placed: mint a fresh position in [tickLower, tickUpper].
    function place(int24 tl, int24 tu, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min) external onlyCrank inPhase(Phase.Hedged) {
        if (tl >= tu || tl % tickSpacing != 0 || tu % tickSpacing != 0) revert BadParams();
        if (tokenId != 0) revert LeftoverLiquidity();
        (uint256 id, uint128 liq, uint256 a0, uint256 a1) = npm.mint(
            INonfungiblePositionManager.MintParams({
                token0: pool.token0(),
                token1: pool.token1(),
                fee: poolFee,
                tickLower: tl,
                tickUpper: tu,
                amount0Desired: amount0Desired,
                amount1Desired: amount1Desired,
                amount0Min: amount0Min,
                amount1Min: amount1Min,
                recipient: address(this),
                deadline: block.timestamp
            })
        );
        tokenId = id;
        liquidity = liq;
        tickLower = tl;
        tickUpper = tu;
        phase = Phase.Placed;
        emit Placed(id, tl, tu, liq, a0, a1);
        emit PhaseChanged(phase, epoch);
    }

    // ------------------------------------------------------------------ crank: hedge leg (Morpho)

    /// @notice Pulled/Hedged → Hedged. Order: add collateral → repay → borrow → withdraw collateral,
    /// so health never dips mid-call. debtDelta = type(int256).min repays everything (by shares).
    function hedge(int256 collateralDelta, int256 debtDelta) external onlyCrank {
        if (phase != Phase.Pulled && phase != Phase.Hedged) revert WrongPhase();
        if (collateralDelta > 0) {
            morpho.supplyCollateral(market, uint256(collateralDelta), address(this), "");
        }
        if (debtDelta < 0) {
            Position memory p = morpho.position(marketId, address(this));
            uint256 owed = morpho.expectedBorrowAssets(market, address(this));
            if (debtDelta == type(int256).min || uint256(-debtDelta) >= owed) {
                if (p.borrowShares > 0) morpho.repay(market, 0, p.borrowShares, address(this), "");
            } else {
                morpho.repay(market, uint256(-debtDelta), 0, address(this), "");
            }
        }
        if (debtDelta > 0 && debtDelta != type(int256).min) {
            morpho.borrow(market, uint256(debtDelta), 0, address(this), address(this));
        }
        if (collateralDelta < 0) {
            morpho.withdrawCollateral(market, uint256(-collateralDelta), address(this), address(this));
        }
        (, uint256 debt, uint32 h) = _morphoState();
        if (h < params.minHealthX100) revert UnderHealth();
        hedgeBase = debt;
        healthX100 = h;
        phase = Phase.Hedged;
        emit Hedged(collateralDelta, debtDelta, debt, h);
        emit PhaseChanged(phase, epoch);
    }

    /// @notice Any non-Idle phase → Idle if the guards hold. Sync + guards.
    function end() external onlyCrank {
        if (phase == Phase.Idle) revert WrongPhase();
        Snapshot memory s = sync();
        if (s.poolDevBps > params.maxPriceDevBps) revert PriceDeviation();
        if (s.healthX100 < params.minHealthX100) revert UnderHealth();
        uint256 longB = s.lpBase + s.idleBase;
        uint256 net = _absDiff(longB, s.debt);
        uint256 gross = longB > s.debt ? longB : s.debt;
        uint256 dust = 10 ** baseDecimals / 1000;
        if (net > dust && net * 10_000 > gross * params.epsBps) revert DeltaTooLarge();
        phase = Phase.Idle;
        epoch += 1;
        epochSupplyStart = totalSupply();
        epochMinted = 0;
        epochBurned = 0;
        emit PhaseChanged(phase, epoch);
    }

    // ------------------------------------------------------------------ views for the crank

    /// @notice Amounts a position of `liq` over [tl,tu] needs at the current pool price (for sizing).
    function amountsForLiquidity(int24 tl, int24 tu, uint128 liq) external view returns (uint256 amount0, uint256 amount1) {
        (uint160 spot,,,,,,) = pool.slot0();
        return LiquidityAmounts.getAmountsForLiquidity(spot, TickMath.getSqrtRatioAtTick(tl), TickMath.getSqrtRatioAtTick(tu), liq);
    }

    function liquidityForAmounts(int24 tl, int24 tu, uint256 amount0, uint256 amount1) external view returns (uint128) {
        (uint160 spot,,,,,,) = pool.slot0();
        return LiquidityAmounts.getLiquidityForAmounts(spot, TickMath.getSqrtRatioAtTick(tl), TickMath.getSqrtRatioAtTick(tu), amount0, amount1);
    }

    function fairPrice() external view returns (uint160 sqrtPriceX96, FairPrice.Mode mode) {
        return _fairSqrt();
    }

    function _absDiff(uint256 a, uint256 b) private pure returns (uint256) {
        return a > b ? a - b : b - a;
    }
}
