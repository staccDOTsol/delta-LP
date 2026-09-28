// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {MemberController} from "../../src/tokenized/MemberController.sol";
import {MemberV4Hook} from "../../src/tokenized/MemberV4Hook.sol";
import {IFeeFanout} from "../../src/tokenized/HouseFeeRouter.sol";
import {TestUSDG, MockLighterL1} from "./MemberController.t.sol";

/// Real Robinhood V4 + Wizards fanout on a local fork. The venue queue and fills
/// are explicitly simulated; this is not a funded Lighter matching-engine test.
contract TokenizedLifecycleTest is Test {
    IPoolManager constant MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    bytes32 constant ETH = keccak256("ETH");
    TestUSDG asset;
    MockLighterL1 venue;
    MemberController controller;
    MemberV4Hook hook;
    uint256 longId;
    uint256 shortId;

    function setUp() public {
        vm.createSelectFork("robinhood");
        asset = new TestUSDG();
        venue = new MockLighterL1(asset);
        controller = new MemberController(asset, venue, address(this), address(this), address(this));
        deployCodeTo("MemberV4Hook.sol:MemberV4Hook", abi.encode(MANAGER, controller), address(uint160(0x2540)));
        hook = MemberV4Hook(address(uint160(0x2540)));
        longId = _member(false);
        shortId = _member(true);
        asset.mint(address(this), 100e6);
        asset.approve(address(controller), 100e6);
    }

    function _member(bool short) private returns (uint256 id) {
        id = controller.createMember(ETH, 0, 3, short, 4, 2, "Lifecycle member", "MEM");
        controller.setEnabled(id, true);
        venue.assign(address(controller.memberState(id).custody), uint48(1000 + id));
        controller.bindAccount(id, uint48(1000 + id));
        _report(id, 0, 0, 2500e6);
    }

    function _report(uint256 id, int256 equity, int256 position, uint256 mark) private {
        venue.executeAll();
        MemberController.Member memory m = controller.memberState(id);
        controller.reconcile(
            id,
            MemberController.Report(
                m.reportSequence + 1,
                m.requestedAction,
                uint64(block.timestamp),
                equity,
                position,
                mark,
                equity > 0 ? uint256(equity) : 0,
                true,
                keccak256("SIMULATED venue execution"),
                200
            )
        );
    }

    function testNeutralMintV4TradeRebalanceAndRedeemWithSimulatedVenueFills() public {
        uint256[] memory minima = new uint256[](2);
        minima[0] = 49e18;
        minima[1] = 49e18;
        (uint256 first,,) = controller.requestNeutral(ETH, 100e6, minima, address(this), uint64(block.timestamp + 600));
        controller.settleBatch(first);
        assertEq(asset.balanceOf(controller.FEE_FANOUT()), 2e6);
        for (uint256 id = 1; id <= 2; ++id) {
            controller.fundVenue(id, 49e6);
            _report(id, 49e6, 0, 2500e6);
            controller.rebalance(id, 250000);
            _report(id, 49e6, id == longId ? int256(588) : -int256(588), 2500e6);
        }

        address a = controller.memberToken(longId);
        address b = controller.memberToken(shortId);
        PoolKey memory key =
            PoolKey(Currency.wrap(a < b ? a : b), Currency.wrap(a < b ? b : a), 3000, 60, IHooks(address(hook)));
        hook.registerPool(key);
        MANAGER.initialize(key, uint160(1 << 96));
        PoolModifyLiquidityTest lp = new PoolModifyLiquidityTest(MANAGER);
        PoolSwapTest swapper = new PoolSwapTest(MANAGER);
        for (uint256 id = 1; id <= 2; ++id) {
            IERC20 token = IERC20(controller.memberToken(id));
            token.approve(address(lp), type(uint256).max);
            token.approve(address(swapper), type(uint256).max);
        }
        IPoolManager.ModifyLiquidityParams memory liquidity =
            IPoolManager.ModifyLiquidityParams(-887220, 887220, 10e18, bytes32(0));
        lp.modifyLiquidity(key, liquidity, "");
        uint64 beforeSwap = controller.groupRequested(ETH);
        swapper.swap(
            key,
            IPoolManager.SwapParams(true, -int256(1e18), TickMath.MIN_SQRT_PRICE + 1),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
        assertGt(controller.groupRequested(ETH), beforeSwap);
        assertEq(asset.balanceOf(controller.FEE_FANOUT()), 2e6, "AMM arbitrage is untaxed by the house");

        // +1% underlying move on equal 3x notionals: +1.47 / -1.47 USDG.
        _report(longId, 50.47e6, 588, 2525e6);
        _report(shortId, 47.53e6, -588, 2525e6);
        for (uint256 id = 1; id <= 2; ++id) {
            (int256 desired,, bool needed) = controller.target(id);
            assertTrue(needed);
            controller.rebalance(id, 252500);
            _report(id, id == longId ? int256(50.47e6) : int256(47.53e6), desired, 2525e6);
        }
        controller.markGroupChecked(ETH, controller.groupRequested(ETH));
        liquidity.liquidityDelta = -10e18;
        lp.modifyLiquidity(key, liquidity, "");

        for (uint256 id = 1; id <= 2; ++id) {
            IERC20 token = IERC20(controller.memberToken(id));
            uint256 shares = token.balanceOf(address(this));
            // V4 rounds liquidity transfers and fee growth. Track outstanding
            // pool dust as real shares rather than pretending it was redeemed.
            uint256 outstanding = 49e18 - shares;
            assertLe(outstanding, 4);
            token.approve(address(controller), shares);
            uint256 request = controller.requestRedeem(id, shares, 1, address(this), uint64(block.timestamp + 600));
            (int256 desired,,) = controller.target(id);
            assertEq(desired, 0);
            controller.rebalance(id, 252500);
            uint64 equity = id == longId ? uint64(50.47e6) : uint64(47.53e6);
            _report(id, int256(uint256(equity)), 0, 2525e6);
            controller.requestVenueWithdrawal(id, equity);
            venue.executeAll();
            controller.collectVenueWithdrawal(id);
            _report(id, 0, 0, 2525e6);
            controller.settleRequest(request);
            assertEq(token.totalSupply(), outstanding);
            assertLe(controller.memberState(id).nav, 1);
        }
        assertApproxEqAbs(asset.balanceOf(address(this)), 94.08e6, 2);
        assertEq(
            asset.balanceOf(address(this)) + asset.balanceOf(controller.FEE_FANOUT())
                + asset.balanceOf(address(controller)),
            100e6,
            "user, fees and outstanding claims conserve every USDG micro-unit"
        );
        assertEq(
            asset.balanceOf(address(controller)),
            controller.memberState(longId).cash + controller.memberState(shortId).cash
        );
        assertLe(asset.balanceOf(address(controller)), 2);
        assertEq(asset.balanceOf(address(venue)), 0);
        IFeeFanout(controller.FEE_FANOUT()).harvest(address(asset));
    }
}
