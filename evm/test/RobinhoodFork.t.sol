// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {DlpVault} from "../src/DlpVault.sol";
import {PairOracle} from "../src/PairOracle.sol";
import {FairPrice} from "../src/libraries/FairPrice.sol";
import {AggregatorV3Interface} from "../src/interfaces/AggregatorV3Interface.sol";
import {IMorpho, MarketParams, Id, Position} from "morpho-blue/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/libraries/MarketParamsLib.sol";
import {IUniswapV3Pool} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import {TickMath} from "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v3-core/contracts/libraries/FullMath.sol";
import {INonfungiblePositionManager} from "@uniswap/v3-periphery/contracts/interfaces/INonfungiblePositionManager.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Robinhood Chain (4663) mainnet fork: real NVDA stock token, real USDG, real Uniswap v3 NVDA/USDG
/// 0.05% pool, real Morpho Blue + AdaptiveCurveIRM, real Chainlink feeds. The public RPC keeps
/// ~2k blocks of state, so the fork pins to `latest` and everything runs in one go.
contract RobinhoodForkTest is Test {
    using MarketParamsLib for MarketParams;

    // ---- Robinhood Chain mainnet (recon dossier §1, §3, §4)
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    IUniswapV3Pool constant POOL = IUniswapV3Pool(0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3); // USDG/NVDA 0.05%, ts 10
    INonfungiblePositionManager constant NPM = INonfungiblePositionManager(0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3);
    IMorpho constant MORPHO = IMorpho(0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010);
    address constant IRM = 0x2BD3d5965B26B51814AC95127B2b80dD6CcC0fa1;
    AggregatorV3Interface constant FEED_NVDA = AggregatorV3Interface(0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15);
    AggregatorV3Interface constant FEED_USDG = AggregatorV3Interface(0x61B7e5650328764B076A108EFF5fa7282a1B9aD2);
    address constant USDG_WHALE = 0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d; // Lighter RH custody, ~95M USDG
    address constant NVDA_WHALE = 0x8366a39CC670B4001A1121B8F6A443A643e40951; // Uniswap v4 PoolManager

    DlpVault vault;
    PairOracle oracle;
    MarketParams mp;
    address authority = makeAddr("authority");
    address crank = makeAddr("crank");
    address user = makeAddr("user");
    address lender = makeAddr("lender");

    int24 constant TS = 10;

    function setUp() public {
        vm.createSelectFork("robinhood");
        assertEq(block.chainid, 4663);

        // Morpho market: loan = NVDA, collateral = USDG, our own Chainlink pair oracle, 62.5% LLTV
        oracle = new PairOracle(FEED_NVDA, FEED_USDG, 18, 6);
        mp = MarketParams({loanToken: NVDA, collateralToken: USDG, oracle: address(oracle), irm: IRM, lltv: 0.625e18});
        MORPHO.createMarket(mp);

        // Chainlink equity feeds are frozen outside US market hours; mark them "fresh at the pool price"
        // for the market-hours path (the weekend/TWAP path is tested separately).
        _mockFeedsAtPoolPrice();

        // lender supplies NVDA to the market (the securities-lending side of the product)
        vm.prank(NVDA_WHALE);
        IERC20(NVDA).transfer(lender, 200e18);
        vm.startPrank(lender);
        IERC20(NVDA).approve(address(MORPHO), type(uint256).max);
        MORPHO.supply(mp, 200e18, 0, lender, "");
        vm.stopPrank();

        // user has 100k USDG
        vm.prank(USDG_WHALE);
        IERC20(USDG).transfer(user, 100_000e6);

        vault = new DlpVault(
            "dlp NVDA/USDG",
            "dlpNVDA",
            POOL,
            NPM,
            MORPHO,
            mp,
            FEED_NVDA,
            FEED_USDG,
            authority,
            crank,
            DlpVault.Params({
                epsBps: 500, // ±60-tick range: a 3-tick pool/oracle gap moves a(P) ~2.5% (gamma)
                minHealthX100: 150,
                maxPriceDevBps: 100,
                maxSwapBps: 5000,
                maxMintBpsPerEpoch: 0,
                maxBurnBpsPerEpoch: 0,
                chainlinkMaxAge: 3600,
                twapWindow: 600
            })
        );
        assertFalse(vault.depositsEnabled(), "new deployments must start closed");
        vm.prank(authority);
        vault.setDepositsEnabled(true);
        vm.prank(user);
        IERC20(USDG).approve(address(vault), type(uint256).max);
        emit log_named_address("vault", address(vault));
        emit log_named_uint("fork block", block.number);
    }

    // ------------------------------------------------------------------ helpers

    function _poolPriceUsdgPerNvda8() internal view returns (int256) {
        (uint160 s,,,,,,) = POOL.slot0();
        // token1/token0 = NVDA_raw per USDG_raw = sqrt²/2^192 ; USDG per NVDA (human) = 2^192/sqrt² · 1e12
        uint256 p = FullMath.mulDiv(FullMath.mulDiv(1e12 * 1e8, 2 ** 96, s), 2 ** 96, s);
        return int256(p);
    }

    function _mockFeedsAtPoolPrice() internal {
        int256 px = _poolPriceUsdgPerNvda8();
        vm.mockCall(address(FEED_NVDA), abi.encodeWithSelector(AggregatorV3Interface.latestRoundData.selector), abi.encode(uint80(1), px, block.timestamp, block.timestamp, uint80(1)));
        vm.mockCall(address(FEED_USDG), abi.encodeWithSelector(AggregatorV3Interface.latestRoundData.selector), abi.encode(uint80(1), int256(1e8), block.timestamp, block.timestamp, uint80(1)));
    }

    function _bal(address t, address a) internal view returns (uint256) {
        return IERC20(t).balanceOf(a);
    }

    function _log(string memory label) internal {
        DlpVault.Snapshot memory s = vault.snapshot();
        emit log_string(string.concat("[", label, "]"));
        emit log_named_decimal_uint("  equity USDG", s.equity, 6);
        emit log_named_decimal_uint("  supply", vault.totalSupply(), 18);
        emit log_named_decimal_uint("  idle USDG", s.idleQuote, 6);
        emit log_named_decimal_uint("  idle NVDA", s.idleBase, 18);
        emit log_named_decimal_uint("  lp NVDA @fair", s.lpBase, 18);
        emit log_named_decimal_uint("  lp USDG @fair", s.lpQuote, 6);
        emit log_named_decimal_uint("  morpho collateral USDG", s.collateral, 6);
        emit log_named_decimal_uint("  morpho debt NVDA", s.debt, 18);
        emit log_named_uint("  health x100", s.healthX100);
        emit log_named_uint("  pool dev bps", s.poolDevBps);
        emit log_named_uint("  price mode (0=chainlink,1=twap)", uint256(s.mode));
    }

    // ------------------------------------------------------------------ the cycle

    function test_cycle() public {
        // ---- deposit 10,000 USDG at NAV 1
        vault.sync();
        vm.prank(user);
        vault.deposit(10_000e6, 0, user);
        assertEq(vault.totalSupply(), 10_000e18);
        _log("after deposit");

        // stale-sync guard: a new block without sync
        vm.roll(block.number + 1);
        vm.prank(user);
        vm.expectRevert(DlpVault.StaleSync.selector);
        vault.deposit(1e6, 0, user);

        // non-crank cannot begin
        vm.prank(user);
        vm.expectRevert(DlpVault.NotCrank.selector);
        vault.begin(0, 0);

        // ---- rebalance #1: range ±60 ticks around spot, 2,000 USDG in the LP, 6,000 USDG collateral
        (, int24 cur,,,,,) = POOL.slot0();
        int24 tl = ((cur - 60) / TS) * TS;
        int24 tu = ((cur + 60) / TS) * TS;
        // token0 = USDG, token1 = NVDA
        uint128 L = vault.liquidityForAmounts(tl, tu, 2_000e6, type(uint128).max);
        (uint256 need0, uint256 need1) = vault.amountsForLiquidity(tl, tu, L);
        emit log_named_int("range lower", tl);
        emit log_named_int("range upper", tu);
        emit log_named_decimal_uint("LP needs USDG", need0, 6);
        emit log_named_decimal_uint("LP needs NVDA", need1, 18);

        vm.startPrank(crank);
        vault.begin(0, 0);
        assertEq(uint256(vault.phase()), uint256(DlpVault.Phase.Pulled));
        vm.stopPrank();

        // deposits blocked mid-rebalance
        vault.sync();
        vm.prank(user);
        vm.expectRevert(DlpVault.WrongPhase.selector);
        vault.deposit(1e6, 0, user);

        vm.startPrank(crank);
        vault.hedge(int256(6_000e6), int256(need1 + need1 / 1000));
        assertEq(uint256(vault.phase()), uint256(DlpVault.Phase.Hedged));
        _log("after hedge (borrowed NVDA against USDG)");
        assertGe(_bal(NVDA, address(vault)), need1);

        // selling the borrowed NVDA breaks delta → End must reject (then buy it back)
        uint256 nvdaHeld = _bal(NVDA, address(vault));
        vault.swap(false, int256(nvdaHeld), 0, 0); // oneForZero: sell NVDA (token1) for USDG
        assertEq(_bal(NVDA, address(vault)), 0);
        vm.expectRevert(DlpVault.DeltaTooLarge.selector);
        vault.end();
        vault.swap(true, -int256(nvdaHeld), 0, type(uint256).max); // buy exact NVDA back with USDG
        assertGe(_bal(NVDA, address(vault)), nvdaHeld);
        emit log_named_decimal_uint("USDG after sell/buy-back round trip", _bal(USDG, address(vault)), 6);

        // desired amounts must both be ≤ balances: NPM sizes liquidity from the binding side (USDG)
        vault.place(tl, tu, need0, _bal(NVDA, address(vault)), need0 - need0 / 100, need1 - need1 / 100);
        assertEq(uint256(vault.phase()), uint256(DlpVault.Phase.Placed));
        vault.end();
        vm.stopPrank();
        assertEq(uint256(vault.phase()), uint256(DlpVault.Phase.Idle));
        _log("after end #1 (deployed)");
        uint256 eq1 = vault.equity();
        assertGt(eq1, 9_950e6);
        assertLe(eq1, 10_000e6);

        // ---- withdraw 1,000 shares at NAV (idle quote covers it)
        vault.sync();
        uint256 before = _bal(USDG, user);
        vm.prank(user);
        uint256 out = vault.withdraw(1_000e18, 990e6, user);
        emit log_named_decimal_uint("withdrew USDG for 1000 shares", out, 6);
        assertEq(_bal(USDG, user) - before, out);

        // over-withdraw beyond idle quote
        vault.sync();
        vm.prank(user);
        vm.expectRevert(DlpVault.InsufficientIdleQuote.selector);
        vault.withdraw(8_000e18, 0, user);

        // ---- weekend mode: real (stale) Chainlink → TWAP fallback still values the vault
        vm.clearMockedCalls();
        DlpVault.Snapshot memory w = vault.snapshot();
        emit log_named_uint("weekend price mode", uint256(w.mode));
        assertEq(uint256(w.mode), uint256(FairPrice.Mode.Twap));
        emit log_named_uint("weekend pool dev bps (twap vs spot)", w.poolDevBps);
        _mockFeedsAtPoolPrice();

        // ---- rebalance #2: full unwind
        vm.startPrank(crank);
        vault.begin(0, 0);
        _log("after begin #2 (pulled)");
        uint256 debt = vault.hedgeBase();
        assertGe(_bal(NVDA, address(vault)) + 1e12, debt); // LP returns ≈ debt (rounding dust)
        // buy a hair of NVDA so repay-all is fully covered
        vault.swap(true, -int256(1e15), 0, type(uint256).max);
        vault.hedge(-int256(6_000e6), type(int256).min);
        _log("after unwind hedge");
        assertEq(vault.hedgeBase(), 0);
        vault.end();
        vm.stopPrank();
        _log("after end #2 (flat)");

        // ---- withdraw everything but dust (equity counts the NVDA dust that is not idle USDG)
        DlpVault.Snapshot memory fin = vault.sync();
        // equity also counts the NVDA dust that is not idle USDG: withdraw the idle-covered part
        uint256 shares = FullMath.mulDiv(vault.balanceOf(user), fin.idleQuote, fin.equity) - 1e15;
        vm.prank(user);
        uint256 out2 = vault.withdraw(shares, 0, user);
        emit log_named_decimal_uint("final withdraw USDG", out2, 6);
        uint256 endBal = _bal(USDG, user);
        emit log_named_decimal_uint("user USDG end (start 100000)", endBal, 6);
        assertGt(endBal, 99_900e6, "round trip lost more than 0.1%");
    }

    function test_unauthorized_admin() public {
        vm.expectRevert(DlpVault.NotAuthority.selector);
        vault.setCrank(address(1));
        vm.prank(authority);
        vault.setCrank(address(1));
        assertEq(vault.crank(), address(1));
    }

    function test_launch_gate_and_atomic_wallet_flow() public {
        vm.prank(authority);
        vault.setDepositsEnabled(false);
        vm.prank(user);
        vm.expectRevert(DlpVault.DepositsClosed.selector);
        vault.depositWithSync(100e6, 100e18, user);
        vm.prank(user);
        vm.expectRevert(DlpVault.NotAuthority.selector);
        vault.setDepositsEnabled(true);
        vm.prank(authority);
        vault.setDepositsEnabled(true);
        vm.roll(block.number + 1);
        vm.prank(user);
        uint256 shares = vault.depositWithSync(100e6, 100e18, user);
        assertEq(shares, 100e18);
        vm.prank(authority);
        vault.setDepositsEnabled(false);
        vm.roll(block.number + 1);
        vm.prank(user);
        uint256 quoteOut = vault.withdrawWithSync(shares, 100e6, user);
        assertEq(quoteOut, 100e6);
        assertEq(vault.totalSupply(), 0);
    }

    function test_atomic_deposit_enforces_minimum_shares() public {
        vm.prank(user);
        vm.expectRevert(DlpVault.Slippage.selector);
        vault.depositWithSync(100e6, 101e18, user);
        assertEq(vault.totalSupply(), 0);
        assertEq(IERC20(USDG).balanceOf(address(vault)), 0);
    }

    function test_admin_addresses_cannot_be_zero() public {
        vm.startPrank(authority);
        vm.expectRevert(DlpVault.BadParams.selector);
        vault.setCrank(address(0));
        vm.expectRevert(DlpVault.BadParams.selector);
        vault.setAuthority(address(0));
        vm.stopPrank();
    }
}
