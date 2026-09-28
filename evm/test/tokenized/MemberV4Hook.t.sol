// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {MemberController} from "../../src/tokenized/MemberController.sol";
import {MemberV4Hook} from "../../src/tokenized/MemberV4Hook.sol";
import {IWrappedEther} from "../../src/tokenized/HouseFeeRouter.sol";
import {ILighterL1} from "../../src/tokenized/LighterSeriesAccount.sol";

contract MemberV4HookTest is Test {
    using PoolIdLibrary for PoolKey;
    IPoolManager constant MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    IERC20 constant USDG = IERC20(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);
    IWrappedEther constant WETH = IWrappedEther(0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73);
    ILighterL1 constant LIGHTER = ILighterL1(0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d);
    bytes32 constant ETH = keccak256("ETH");
    MemberController controller;
    MemberV4Hook hook;
    PoolSwapTest swapper;
    PoolModifyLiquidityTest lp;
    PoolKey pair;
    uint256 long3;
    uint256 short3;

    function setUp() public {
        // Real Robinhood PoolManager and fee pot, fork-local tokens/capital only.
        vm.createSelectFork("robinhood");
        controller = new MemberController(USDG, LIGHTER, address(this), address(this), address(this));
        address hookAddress = address(uint160(0x2540));
        deployCodeTo("MemberV4Hook.sol:MemberV4Hook", abi.encode(MANAGER, controller), hookAddress);
        hook = MemberV4Hook(hookAddress);
        swapper = new PoolSwapTest(MANAGER);
        lp = new PoolModifyLiquidityTest(MANAGER);
        vm.prank(address(LIGHTER));
        USDG.transfer(address(this), 2_000e6);
        USDG.approve(address(controller), type(uint256).max);
        long3 = _member(ETH, 0, 3, false);
        short3 = _member(ETH, 0, 3, true);
        _seed(long3);
        _seed(short3);
        pair = _key(controller.memberToken(long3), controller.memberToken(short3), 3000);
        hook.registerPool(pair);
        MANAGER.initialize(pair, uint160(1 << 96));
        _approve(pair);
        lp.modifyLiquidity(pair, IPoolManager.ModifyLiquidityParams(-600, 600, 100e18, bytes32(0)), "");
    }

    function _member(bytes32 group, uint16 market, uint8 leverage, bool short) private returns (uint256 id) {
        id = controller.createMember(group, market, leverage, short, 4, 2, "Member", "MEM");
        controller.setEnabled(id, true);
        controller.reconcile(
            id,
            MemberController.Report(1, 0, uint64(block.timestamp), 0, 0, 2_500e6, 0, true, keccak256("fork fixture"))
        );
    }

    function _seed(uint256 member) private {
        uint256 request = controller.requestDeposit(member, 100e6, 98e18, address(this), uint64(block.timestamp + 600));
        controller.settleRequest(request);
    }

    function _key(address a, address b, uint24 fee) private view returns (PoolKey memory) {
        (address c0, address c1) = a < b ? (a, b) : (b, a);
        return PoolKey(Currency.wrap(c0), Currency.wrap(c1), fee, 60, IHooks(address(hook)));
    }

    function _approve(PoolKey memory key) private {
        IERC20(Currency.unwrap(key.currency0)).approve(address(lp), type(uint256).max);
        IERC20(Currency.unwrap(key.currency1)).approve(address(lp), type(uint256).max);
        IERC20(Currency.unwrap(key.currency0)).approve(address(swapper), type(uint256).max);
        IERC20(Currency.unwrap(key.currency1)).approve(address(swapper), type(uint256).max);
    }

    function _swap(PoolKey memory key, bool zeroForOne, uint256 amount, bool claims, bool burn)
        private
        returns (BalanceDelta)
    {
        return swapper.swap(
            key,
            IPoolManager.SwapParams(
                zeroForOne, -int256(amount), zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            ),
            PoolSwapTest.TestSettings(claims, burn),
            ""
        );
    }

    function testRealV4SwapAndLiquidityRemovalNotifyWithoutHouseTransferTax() public {
        uint256 feeBefore = USDG.balanceOf(controller.FEE_FANOUT());
        uint64 sequence = controller.groupRequested(ETH);
        IERC20 token0 = IERC20(Currency.unwrap(pair.currency0));
        IERC20 token1 = IERC20(Currency.unwrap(pair.currency1));
        uint256 before0 = token0.balanceOf(address(this));
        uint256 before1 = token1.balanceOf(address(this));
        BalanceDelta delta = _swap(pair, true, 1e18, false, false);
        assertEq(before0 - token0.balanceOf(address(this)), uint256(uint128(-delta.amount0())));
        assertEq(token1.balanceOf(address(this)) - before1, uint256(uint128(delta.amount1())));
        assertEq(controller.groupRequested(ETH), sequence + 3); // hook + two transfers
        assertEq(hook.poolActivity(pair.toId()), 2); // initial liquidity + swap
        assertEq(USDG.balanceOf(controller.FEE_FANOUT()), feeBefore);
        assertEq(token0.balanceOf(address(hook)), 0);
        assertEq(token1.balanceOf(address(hook)), 0);
        lp.modifyLiquidity(pair, IPoolManager.ModifyLiquidityParams(-600, 600, -100e18, bytes32(0)), "");
        assertEq(hook.poolActivity(pair.toId()), 3);
        assertEq(USDG.balanceOf(controller.FEE_FANOUT()), feeBefore);
        assertLe(address(controller).code.length, 24_576, "controller must be deployable");
    }

    function testERC6909OnlySwapStillTriggersCheckWithoutAnyERC20Transfer() public {
        // First swap takes output as an ERC-6909 claim inside the singleton.
        _swap(pair, true, 1e18, true, false);
        uint256 claim1 = MANAGER.balanceOf(address(this), uint160(Currency.unwrap(pair.currency1)));
        assertGt(claim1, 0);
        MANAGER.setOperator(address(swapper), true);
        uint256 before0 = IERC20(Currency.unwrap(pair.currency0)).balanceOf(address(MANAGER));
        uint256 before1 = IERC20(Currency.unwrap(pair.currency1)).balanceOf(address(MANAGER));
        uint64 sequence = controller.groupRequested(ETH);
        _swap(pair, false, claim1 / 2, true, true); // burn claim1, receive claim0
        assertEq(IERC20(Currency.unwrap(pair.currency0)).balanceOf(address(MANAGER)), before0);
        assertEq(IERC20(Currency.unwrap(pair.currency1)).balanceOf(address(MANAGER)), before1);
        assertEq(controller.groupRequested(ETH), sequence + 1, "hook catches transfer-free swap");
        assertGt(MANAGER.balanceOf(address(this), uint160(Currency.unwrap(pair.currency0))), 0);
    }

    function testMajorQuoteWETHTradesAndPoolCreatorChoosesSwapFee() public {
        vm.deal(address(this), 10 ether);
        WETH.deposit{value: 1 ether}();
        PoolKey memory degen = _key(controller.memberToken(long3), address(WETH), 500);
        PoolId id = hook.registerPool(degen);
        assertEq(hook.poolGroups(id), ETH);
        MANAGER.initialize(degen, uint160(1 << 96)); // mechanical fixture price, not a market quote
        _approve(degen);
        lp.modifyLiquidity(degen, IPoolManager.ModifyLiquidityParams(-600, 600, 10e18, bytes32(0)), "");
        uint64 sequence = controller.groupRequested(ETH);
        uint256 feeBefore = USDG.balanceOf(controller.FEE_FANOUT());
        BalanceDelta delta =
            _swap(degen, Currency.unwrap(degen.currency0) == controller.memberToken(long3), 0.01e18, false, false);
        assertTrue(delta.amount0() != 0 && delta.amount1() != 0);
        assertEq(controller.groupRequested(ETH), sequence + 2); // hook + member transfer
        assertEq(USDG.balanceOf(controller.FEE_FANOUT()), feeBefore);
        assertEq(hook.poolActivity(id), 2);
        PoolKey memory otherFee = _key(controller.memberToken(long3), address(WETH), 3000);
        assertTrue(PoolId.unwrap(hook.registerPool(otherFee)) != PoolId.unwrap(id));
    }

    function testInvalidMemberPairsAndUnregisteredPoolsCannotUseHook() public {
        uint256 wrongLeverage = _member(ETH, 0, 5, true);
        PoolKey memory key = _key(controller.memberToken(long3), controller.memberToken(wrongLeverage), 3000);
        vm.expectRevert(MemberV4Hook.InvalidPool.selector);
        hook.registerPool(key);
        uint256 wrongGroup = _member(keccak256("BTC"), 1, 3, true);
        key = _key(controller.memberToken(long3), controller.memberToken(wrongGroup), 3000);
        vm.expectRevert(MemberV4Hook.InvalidPool.selector);
        hook.registerPool(key);
        key = _key(address(USDG), address(WETH), 3000);
        vm.expectRevert(MemberV4Hook.InvalidPool.selector);
        hook.registerPool(key);
        key = _key(controller.memberToken(long3), address(WETH), 100);
        vm.expectRevert();
        MANAGER.initialize(key, uint160(1 << 96));
        key.fee = 0x800000; // observer has no dynamic-fee policy
        vm.expectRevert(MemberV4Hook.InvalidPool.selector);
        hook.registerPool(key);
    }

    function testOnlyManagerCanReportPoolActivity() public {
        uint64 sequence = controller.groupRequested(ETH);
        vm.expectRevert(MemberV4Hook.OnlyPoolManager.selector);
        hook.afterSwap(
            address(this),
            pair,
            IPoolManager.SwapParams(true, -1, TickMath.MIN_SQRT_PRICE + 1),
            BalanceDelta.wrap(0),
            ""
        );
        assertEq(controller.groupRequested(ETH), sequence);
    }
}
