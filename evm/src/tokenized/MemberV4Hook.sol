// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {MemberController} from "./MemberController.sol";

/// V4 activity observer for member/member and member/quote pools. Pool creators
/// choose swap fees. This hook takes no fee and cannot move principal or mint tokens.
/// A matched pair describes membership, not a guarantee that its inventory is neutral.
contract MemberV4Hook {
    using PoolIdLibrary for PoolKey;

    IPoolManager public immutable manager;
    MemberController public immutable controller;
    mapping(PoolId => bytes32) public poolGroups;
    mapping(PoolId => uint64) public poolActivity;

    event MemberPoolRegistered(PoolId indexed pool, bytes32 indexed group, uint256 member0, uint256 member1);
    event MemberPoolActivity(PoolId indexed pool, bytes32 indexed group, uint64 sequence, uint8 kind);

    error OnlyPoolManager();
    error InvalidPool();

    modifier onlyManager() {
        if (msg.sender != address(manager)) revert OnlyPoolManager();
        _;
    }

    constructor(IPoolManager manager_, MemberController controller_) {
        require(address(manager_).code.length != 0 && address(controller_).code.length != 0);
        manager = manager_;
        controller = controller_;
        Hooks.validateHookPermissions(IHooks(address(this)), getHookPermissions());
    }

    function getHookPermissions() public pure returns (Hooks.Permissions memory p) {
        p.beforeInitialize = true;
        p.afterAddLiquidity = true;
        p.afterRemoveLiquidity = true;
        p.afterSwap = true;
    }

    /// Permissionless registration before initialization. No liquidity or approvals
    /// are accepted. Matched pairs must share underlying, market and leverage.
    /// A single member may instead trade against any ordinary ERC20 or native ETH.
    function registerPool(PoolKey calldata key) external returns (PoolId id) {
        address a = Currency.unwrap(key.currency0);
        address b = Currency.unwrap(key.currency1);
        if (
            address(key.hooks) != address(this) || a >= b || key.tickSpacing <= 0 || key.tickSpacing > type(int16).max
                || key.fee >= 1_000_000
        ) revert InvalidPool();
        // Static fees only: no hidden dynamic fee policy or 100% input-fee pools.
        id = key.toId();
        if (poolGroups[id] != bytes32(0)) revert InvalidPool();
        uint256 member0 = controller.memberIds(a);
        uint256 member1 = controller.memberIds(b);
        if (member0 == 0 && member1 == 0) revert InvalidPool();
        MemberController.Member memory first = controller.memberState(member0 != 0 ? member0 : member1);
        if (member0 != 0 && member1 != 0) {
            MemberController.Member memory second = controller.memberState(member1);
            if (
                first.group != second.group || first.market != second.market || first.leverage != second.leverage
                    || first.short == second.short
            ) revert InvalidPool();
        } else {
            address quote = member0 == 0 ? a : b;
            if (quote != address(0) && quote.code.length == 0) revert InvalidPool();
        }
        poolGroups[id] = first.group;
        emit MemberPoolRegistered(id, first.group, member0, member1);
    }

    function beforeInitialize(address, PoolKey calldata key, uint160) external view onlyManager returns (bytes4) {
        _group(key);
        return IHooks.beforeInitialize.selector;
    }

    function afterSwap(address, PoolKey calldata key, IPoolManager.SwapParams calldata, BalanceDelta, bytes calldata)
        external
        onlyManager
        returns (bytes4, int128)
    {
        _notify(key, 0);
        return (IHooks.afterSwap.selector, 0);
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata key,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external onlyManager returns (bytes4, BalanceDelta) {
        _notify(key, 1);
        return (IHooks.afterAddLiquidity.selector, BalanceDelta.wrap(0));
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata key,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external onlyManager returns (bytes4, BalanceDelta) {
        _notify(key, 2);
        return (IHooks.afterRemoveLiquidity.selector, BalanceDelta.wrap(0));
    }

    function _group(PoolKey calldata key) private view returns (bytes32 group) {
        group = poolGroups[key.toId()];
        if (address(key.hooks) != address(this) || group == bytes32(0)) revert InvalidPool();
    }

    function _notify(PoolKey calldata key, uint8 kind) private {
        bytes32 group = _group(key);
        PoolId id = key.toId();
        controller.requestGroupCheck(group);
        emit MemberPoolActivity(id, group, ++poolActivity[id], kind);
    }
}
