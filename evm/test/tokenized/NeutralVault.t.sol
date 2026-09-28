// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {MemberController} from "../../src/tokenized/MemberController.sol";
import {MemberV4Hook} from "../../src/tokenized/MemberV4Hook.sol";
import {NeutralVault} from "../../src/tokenized/NeutralVault.sol";
import {NeutralAllocation, NeutralExit, NeutralEscrowFactory} from "../../src/tokenized/NeutralEscrows.sol";
import {TestUSDG, MockLighterL1} from "./MemberController.t.sol";

/// Real V4 and fee recipient on a local Robinhood fork; Lighter execution is simulated.
contract NeutralVaultTest is Test {
    using PoolIdLibrary for *;
    using StateLibrary for IPoolManager;
    IPoolManager constant MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    bytes32 constant ETH = keccak256("ETH");
    address constant ALICE = address(0xa11ce);
    address constant BOB = address(0xb0b);
    TestUSDG asset;
    MockLighterL1 venue;
    MemberController controller;
    MemberV4Hook hook;
    NeutralVault vault;

    function setUp() public {
        vm.createSelectFork("robinhood", 74587543);
        asset = new TestUSDG();
        venue = new MockLighterL1(asset);
        controller = new MemberController(asset, venue, address(this), address(this), address(this));
        deployCodeTo("MemberV4Hook.sol:MemberV4Hook", abi.encode(MANAGER, controller), address(uint160(0x2540)));
        hook = MemberV4Hook(address(uint160(0x2540)));
        for (uint8 tier = 1; tier <= 2; ++tier) {
            for (uint8 side; side < 2; ++side) {
                uint256 id = controller.createMember(ETH, 0, tier, side == 1, 4, 2, "Test", "MEM");
                controller.setEnabled(id, true);
                venue.assign(address(controller.memberState(id).custody), uint48(1000 + id));
                controller.bindAccount(id, uint48(1000 + id));
                _report(id, 0, 0);
            }
        }
        vault = new NeutralVault(controller, hook, new NeutralEscrowFactory(controller), ETH, 2, 100e6);
        vault.configure(); vault.setEntriesOpen(true);
        for (uint256 i; i < 2; ++i) {
            address owner = i == 0 ? ALICE : BOB;
            asset.mint(owner, 1000e6);
            vm.prank(owner); asset.approve(address(vault), type(uint256).max);
        }
    }
    function _report(uint256 id, int256 equity, int256 position) private {
        venue.executeAll();
        MemberController.Member memory m = controller.memberState(id);
        controller.reconcile(id, MemberController.Report(m.reportSequence + 1, m.requestedAction,
            uint64(block.timestamp), equity, position, 2500e6, equity > 0 ? uint256(equity) : 0,
            true, keccak256("SIMULATED fills; not a mainnet trading test"), 200));
    }
    function _enter(address owner, uint256 amount) private {
        vm.prank(owner); vault.enter(amount, 1, owner, uint64(block.timestamp + 600));
    }
    function _allocate(bool settle) private {
        uint256[] memory minima = new uint256[](vault.memberIds().length);
        for (uint256 i; i < minima.length; ++i) minima[i] = 1;
        vault.startAllocation(minima, uint64(block.timestamp + 600));
        if (settle) controller.settleBatch(vault.allocation().firstRequest());
    }
    function _hedge() private {
        for (uint256 id = 1; id <= controller.memberCount(); ++id) {
            MemberController.Member memory m = controller.memberState(id);
            if (m.cash != 0) {
                controller.fundVenue(id, m.cash);
                _report(id, int256(m.nav), m.position);
            }
            (int256 desired,, bool needed) = controller.target(id);
            if (needed) {
                controller.rebalance(id, 250000);
                _report(id, int256(m.nav), desired);
            }
        }
    }
    function _active() private {
        _enter(ALICE, 100e6); _allocate(true); _hedge(); vault.activate();
    }
    function _settleExit(NeutralExit exit) private {
        while (exit.queuedMembers() < exit.memberCount()) exit.queue(20);
        uint256[] memory requests = exit.requestIds();
        for (uint256 i; i < requests.length; ++i) {
            (,, uint256 id, uint256 shares,,,,,) = controller.requests(requests[i]);
            MemberController.Member memory m = controller.memberState(id);
            uint256 owed = shares * m.nav / m.token.totalSupply();
            (int256 desired,, bool needed) = controller.target(id);
            if (needed) { controller.rebalance(id, 250000); _report(id, int256(m.nav - m.cash), desired); }
            if (owed > m.cash) {
                controller.requestVenueWithdrawal(id, uint64(owed - m.cash));
                venue.executeAll(); controller.collectVenueWithdrawal(id);
                _report(id, int256(m.nav - owed), desired);
            }
            controller.settleRequest(requests[i]);
        }
    }
    function testPendingDepositsHaveNoReceiptAndRefundOriginalPayer() public {
        _enter(ALICE, 20e6);
        assertEq(vault.totalSupply(), 0);
        (uint256 value,,) = vault.portfolio(); assertEq(value, 0);
        vm.prank(BOB); vm.expectRevert("Only depositor can cancel"); vault.refund(ALICE);
        vm.prank(ALICE); vault.refund(ALICE);
        assertEq(asset.balanceOf(ALICE), 1000e6);
        assertEq(asset.balanceOf(BOB), 1000e6);
        assertEq(vault.pendingAssets(), 0);
    }
    function testPooledDepositCreatesEveryTierAndMintsOnlyAfterHedgeAndLiquidity() public {
        _enter(ALICE, 40e6); _enter(BOB, 60e6);
        _allocate(true);
        assertEq(vault.memberIds().length, 4);
        assertEq(controller.batchSize(vault.allocation().firstRequest()), 4);
        vm.expectRevert("Positions not ready"); vault.activate();
        assertEq(vault.totalSupply(), 0);
        _hedge(); vault.activate();
        assertApproxEqAbs(vault.balanceOf(ALICE), 39.2e18, 2e12);
        assertApproxEqAbs(vault.balanceOf(BOB), 58.8e18, 3e12);
        assertEq(asset.balanceOf(controller.FEE_FANOUT()), 2e6);
        (uint256 nav, int256 delta, uint256 gross) = vault.portfolio();
        assertApproxEqAbs(nav, 98e6, 4); assertEq(delta, 0); assertGt(gross, 140e6);
        for (uint256 i; i < 2; ++i) {
            NeutralVault.Pair memory p = vault.pair(i);
            (uint128 liquidity,,) = MANAGER.getPositionInfo(p.key.toId(), address(vault), vault.LOWER(), vault.UPPER(), bytes32(0));
            assertGt(liquidity, 24e18);
        }
        assertEq(vault.epoch(), 2);
    }
    function testSecondEpochDoesNotDiluteExistingSharesOrCountPendingCash() public {
        _active(); uint256 aliceShares = vault.balanceOf(ALICE);
        (uint256 beforeNav,,) = vault.portfolio();
        _enter(BOB, 100e6);
        (uint256 pendingNav,,) = vault.portfolio(); assertEq(pendingNav, beforeNav);
        _allocate(true);
        (uint256 allocatedNav,,) = vault.portfolio(); assertApproxEqAbs(allocatedNav, beforeNav, 4);
        _hedge(); vault.activate();
        (uint256 afterNav,,) = vault.portfolio();
        assertApproxEqAbs(afterNav * aliceShares / vault.totalSupply(), beforeNav, 2);
        assertApproxEqAbs(vault.balanceOf(BOB), aliceShares, 5e12);
        assertEq(vault.balanceOf(ALICE), aliceShares);
    }
    function testCancelUnissuedBatchRefundsEveryParticipantWithoutFees() public {
        _enter(ALICE, 40e6); _enter(BOB, 60e6); _allocate(false);
        vm.prank(ALICE); vault.cancelAllocation();
        vault.refund(ALICE); vault.refund(BOB);
        assertEq(asset.balanceOf(ALICE), 1000e6); assertEq(asset.balanceOf(BOB), 1000e6);
        assertEq(controller.escrowAssets(), 0); assertEq(asset.balanceOf(controller.FEE_FANOUT()), 0);
    }
    function testRecoveryInKindAfterHedgeFailureWithoutOtherUsersClaims() public {
        _enter(ALICE, 40e6); _enter(BOB, 60e6); _allocate(true);
        vm.prank(ALICE); vault.recoverPending(false, 0, 0);
        for (uint256 id = 1; id <= 4; ++id) assertEq(IERC20(controller.memberToken(id)).balanceOf(ALICE), 9.8e18);
        vm.prank(ALICE); vm.expectRevert(); vault.recoverPending(false, 0, 0);
        _hedge(); vault.activate();
        assertEq(vault.balanceOf(ALICE), 0); assertApproxEqAbs(vault.balanceOf(BOB), 58.8e18, 4e12);
    }
    function testRecoveryAsUSDGAfterHedgeFailure() public {
        _enter(ALICE, 100e6); _allocate(true);
        vm.prank(ALICE); NeutralExit exit = NeutralExit(vault.recoverPending(true, 94e6, uint64(block.timestamp + 600)));
        _settleExit(exit); exit.finish();
        assertEq(asset.balanceOf(ALICE), 994.08e6);
        assertEq(vault.pendingAssets(), 0); assertEq(vault.totalSupply(), 0);
    }
    function testReceiptExitRemovesLiquidityClosesExposureAndPaysUSDGWithFee() public {
        _active();
        uint256 shares = vault.balanceOf(ALICE);
        vm.prank(ALICE); NeutralExit exit = NeutralExit(vault.requestExit(shares, 94e6, ALICE, uint64(block.timestamp + 600)));
        assertEq(vault.totalSupply(), 0); assertFalse(exit.ready());
        vm.expectRevert(); exit.finish();
        _settleExit(exit); assertTrue(exit.ready());
        vm.prank(BOB); exit.finish();
        assertApproxEqAbs(asset.balanceOf(ALICE), 994.08e6, 4);
        assertApproxEqAbs(asset.balanceOf(controller.FEE_FANOUT()), 5.92e6, 4);
        assertEq(asset.balanceOf(ALICE) + asset.balanceOf(controller.FEE_FANOUT()) + asset.balanceOf(address(controller)) + asset.balanceOf(address(venue)), 1000e6);
        vm.expectRevert(); exit.finish();
    }
    function testPartialExitPreservesPendingDepositsAndRemainingReceiptBacking() public {
        _active(); _enter(BOB, 100e6);
        uint256 half = vault.balanceOf(ALICE) / 2;
        vm.prank(ALICE); NeutralExit exit = NeutralExit(vault.requestExit(half, 47e6, ALICE, uint64(block.timestamp + 600)));
        assertEq(asset.balanceOf(address(vault)), 100e6); assertEq(vault.reservedCash(), 100e6);
        _settleExit(exit); exit.finish();
        (uint256 remainingNav,,) = vault.portfolio(); assertApproxEqAbs(remainingNav, 49e6, 8);
        vm.prank(BOB); vault.refund(BOB); assertEq(asset.balanceOf(BOB), 1000e6);
        assertApproxEqAbs(asset.balanceOf(ALICE), 947.04e6, 4);
    }
    function testStaleReporterCannotTrapReceiptHolder() public {
        _active(); vm.warp(vm.getBlockTimestamp() + 61);
        vm.expectRevert(NeutralVault.Unready.selector); vault.portfolio();
        uint256 shares = vault.balanceOf(ALICE);
        vm.prank(ALICE); NeutralExit exit = NeutralExit(vault.requestExit(shares, 94e6, ALICE, uint64(block.timestamp + 600)));
        vm.prank(BOB); vm.expectRevert(); exit.recoverInKind();
        vm.prank(ALICE); exit.recoverInKind();
        assertTrue(exit.completed());
        for (uint256 id = 1; id <= 4; ++id) assertGt(IERC20(controller.memberToken(id)).balanceOf(ALICE), 24e18);
    }
    function testActivationMinimumRollsBackEntireReceiptAndLPAndCanBeLowered() public {
        vm.prank(ALICE); vault.enter(100e6, 100e18, ALICE, uint64(block.timestamp + 600));
        _allocate(true); _hedge(); vm.expectRevert("Receipt minimum"); vault.activate();
        assertEq(vault.totalSupply(), 0);
        assertGt(IERC20(controller.memberToken(1)).balanceOf(address(vault.allocation())), 24e18);
        vm.prank(ALICE); vault.lowerMinimum(97e18); vault.activate(); assertGt(vault.balanceOf(ALICE), 97e18);
    }
    function testV4SwapAccruesFeesRequestsCheckAndBlocksMispricedNextActivation() public {
        _active();
        // Independent primary issuance supplies the test arbitrageur's inventory.
        NeutralVault.Pair memory p = vault.pair(0);
        uint256 id = address(controller.memberState(1).token) == Currency.unwrap(p.key.currency0) ? 1 : 2;
        asset.mint(address(this), 10e6); asset.approve(address(controller), 10e6);
        uint256 request = controller.requestDeposit(id, 10e6, 1, address(this), uint64(block.timestamp + 600));
        controller.settleRequest(request);
        PoolSwapTest swapper = new PoolSwapTest(MANAGER);
        IERC20(controller.memberToken(id)).approve(address(swapper), type(uint256).max);
        uint64 before = controller.groupRequested(ETH);
        swapper.swap(p.key, IPoolManager.SwapParams(true, -int256(1e18), TickMath.MIN_SQRT_PRICE + 1), PoolSwapTest.TestSettings(false, false), "");
        assertGt(controller.groupRequested(ETH), before);
        _enter(BOB, 100e6); _allocate(true); _hedge();
        vm.expectRevert("Pool price differs from NAV"); vault.activate();
        assertEq(vault.balanceOf(BOB), 0);
    }
    function testNoArbitraryUnlockOrCoordinatorCalls() public {
        vm.expectRevert(); vault.unlockCallback(abi.encode(uint8(2), 1, 1));
        _enter(ALICE, 100e6);
        uint256[] memory minima = new uint256[](4);
        vm.prank(ALICE); vm.expectRevert(); vault.startAllocation(minima, uint64(block.timestamp + 600));
    }
    function testFiftyTierBasketFitsOperationalGasAndExitsEveryTier() public {
        for (uint8 tier = 3; tier <= 50; ++tier) {
            for (uint8 side; side < 2; ++side) {
                uint256 id = controller.createMember(ETH, 0, tier, side == 1, 4, 2, "All-tier test", "ALL");
                controller.setEnabled(id, true);
                venue.assign(address(controller.memberState(id).custody), uint48(1000 + id));
                controller.bindAccount(id, uint48(1000 + id)); _report(id, 0, 0);
            }
        }
        vault = new NeutralVault(controller, hook, new NeutralEscrowFactory(controller), ETH, 50, 2000e6);
        vault.configure(); vault.setEntriesOpen(true);
        asset.mint(ALICE, 2000e6);
        vm.prank(ALICE); asset.approve(address(vault), type(uint256).max);
        _enter(ALICE, 2000e6);
        for (uint256 i; i < 31; ++i) {
            address participant = address(uint160(0x100000 + i));
            asset.mint(participant, 100e6);
            vm.prank(participant); asset.approve(address(vault), 100e6);
            _enter(participant, 100e6);
        }
        _allocate(true); _hedge();
        uint256 before = gasleft(); vault.activate(); uint256 used = before - gasleft();
        emit log_named_uint("50-tier activation gas", used); assertLt(used, 32_000_000);
        (uint256 nav, int256 delta,) = vault.portfolio(); assertApproxEqAbs(nav, 4998e6, 100); assertEq(delta, 0);
        uint256 shares = vault.balanceOf(ALICE);
        vm.prank(ALICE); before = gasleft();
        NeutralExit exit = NeutralExit(vault.requestExit(shares, 1881e6, ALICE, uint64(block.timestamp + 600)));
        used = before - gasleft(); emit log_named_uint("50-tier exit request gas", used); assertLt(used, 32_000_000);
        assertEq(exit.requestIds().length, 0); assertEq(exit.memberCount(), 100); assertEq(vault.exitAt(ALICE, 0), address(exit));
        while (exit.queuedMembers() < exit.memberCount()) {
            before = gasleft(); exit.queue(20); used = before - gasleft(); assertLt(used, 10_000_000);
        }
        assertEq(exit.requestIds().length, 100);
        _settleExit(exit); exit.finish(); assertApproxEqAbs(asset.balanceOf(ALICE), 2881.6e6, 100);
    }
}
