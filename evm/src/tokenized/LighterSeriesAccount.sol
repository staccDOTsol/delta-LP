// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface ILighterL1 {
    function executedPriorityRequestCount() external view returns (uint64);
    function openPriorityRequestCount() external view returns (uint64);
    function addressToAccountIndex(address owner) external view returns (uint48);
    function changePubKey(uint48 accountIndex, uint8 apiKeyIndex, bytes calldata publicKey) external;
    function deposit(address to, uint16 assetIndex, uint8 route, uint256 amount) external payable;
    function createOrder(
        uint48 accountIndex,
        uint16 marketIndex,
        uint48 baseAmount,
        uint32 price,
        uint8 isAsk,
        uint8 orderType
    ) external;
    function cancelAllOrders(uint48 accountIndex) external;
    function withdraw(uint48 accountIndex, uint16 assetIndex, uint8 route, uint64 amount) external;
    function withdrawPendingBalance(address owner, uint16 assetIndex, uint128 amount) external;
    function getPendingBalance(address owner, uint16 assetIndex) external view returns (uint128);
}

/// Per-series L1 owner: opposite strategies cannot net in the same Lighter account.
/// The controller owner can rotate slot 42. Its private-key holder is a trusted
/// venue operator, NOT a permission-restricted or trade-only signer.
contract LighterSeriesAccount {
    using SafeERC20 for IERC20;
    address public immutable controller;
    IERC20 public immutable usdg;
    ILighterL1 public immutable lighter;
    uint16 public immutable marketId;
    uint48 public accountIndex;
    bool public bound;
    uint64 public priorityEnd;
    uint8 public constant API_KEY_INDEX = 42;

    error OnlyController();
    modifier onlyController() {
        if (msg.sender != controller) revert OnlyController();
        _;
    }

    constructor(IERC20 asset, ILighterL1 venue, uint16 market, address controller_) {
        require(address(asset).code.length != 0 && address(venue).code.length != 0 && controller_ != address(0));
        usdg = asset;
        lighter = venue;
        marketId = market;
        controller = controller_;
    }

    /// Binding must be reconciled with this contract's account ownership at the venue.
    /// The Lighter priority queue additionally validates the caller's master account.
    function bind(uint48 index) external onlyController {
        require(!bound && index > 2 && index < type(uint48).max);
        require(lighter.addressToAccountIndex(address(this)) == index, "Foreign Lighter account");
        accountIndex = index;
        bound = true;
    }

    function deposit(uint256 amount) external onlyController {
        usdg.safeTransferFrom(controller, address(this), amount);
        usdg.forceApprove(address(lighter), amount);
        lighter.deposit(address(this), 3, 0, amount);
        usdg.forceApprove(address(lighter), 0);
        _queued();
    }

    function order(uint48 size, uint32 limitPrice, bool ask) external onlyController {
        require(bound && size != 0 && limitPrice != 0);
        // L1 limit order. It can rest or partially fill: the controller stays
        // pending until fills, cancellation and the resulting position reconcile.
        lighter.createOrder(accountIndex, marketId, size, limitPrice, ask ? 1 : 0, 0);
        _queued();
    }

    function cancelOrders() external onlyController {
        require(bound);
        lighter.cancelAllOrders(accountIndex);
        _queued();
    }

    function configureKey(bytes calldata publicKey) external onlyController {
        require(bound && publicKey.length == 40, "Invalid venue key");
        bool nonzero;
        // Lighter encodes five canonical Goldilocks field elements, little endian.
        for (uint256 i; i < 5; ++i) {
            uint64 word;
            for (uint256 j; j < 8; ++j) {
                word |= uint64(uint8(publicKey[i * 8 + j])) << (8 * j);
            }
            require(word < 0xffffffff00000001, "Noncanonical venue key");
            nonzero = nonzero || word != 0;
        }
        require(nonzero, "Zero venue key");
        lighter.changePubKey(accountIndex, API_KEY_INDEX, publicKey);
        _queued();
    }

    function withdraw(uint64 amount) external onlyController {
        require(bound && amount >= 1e6);
        lighter.withdraw(accountIndex, 3, 0, amount);
        _queued();
    }

    /// Execution of the priority request is necessary but does not prove a fill.
    function priorityProcessed() external view returns (bool) {
        return lighter.executedPriorityRequestCount() >= priorityEnd;
    }

    function _queued() private {
        uint64 end = lighter.executedPriorityRequestCount() + lighter.openPriorityRequestCount();
        require(end > priorityEnd, "Priority request missing");
        priorityEnd = end;
    }

    function collect() external onlyController returns (uint256 amount) {
        uint128 pending = lighter.getPendingBalance(address(this), 3);
        if (pending != 0) lighter.withdrawPendingBalance(address(this), 3, pending);
        amount = usdg.balanceOf(address(this));
        if (amount != 0) usdg.safeTransfer(controller, amount);
    }
}
