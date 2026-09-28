// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MemberController} from "./MemberController.sol";

/// Keeps one incoming allocation separate from existing LP shareholders.
contract NeutralAllocation {
    using SafeERC20 for IERC20;
    MemberController public immutable controller;
    address public immutable vault;
    bytes32 public immutable group;
    uint256[] private ids;
    uint256 public firstRequest;
    bool public cancelled;

    constructor(MemberController c, address v, bytes32 g, uint256[] memory members) {
        controller = c; vault = v; group = g; ids = members;
    }
    modifier onlyVault() { require(msg.sender == vault); _; }

    function start(uint256[] calldata minima, uint64 deadline) external onlyVault {
        require(firstRequest == 0 && !cancelled);
        IERC20 asset = controller.usdg();
        uint256 assets = asset.balanceOf(address(this));
        asset.forceApprove(address(controller), assets);
        (uint256 first, uint256 count,) = controller.requestNeutral(group, assets, minima, address(this), deadline);
        require(count == ids.length);
        firstRequest = first;
        // Bind the reviewed member order, not just the number of eligible legs.
        for (uint256 i; i < count; ++i) {
            (address owner, address receiver, uint256 member,,,,,,) = controller.requests(first + i);
            require(owner == address(this) && receiver == address(this) && member == ids[i], "Family changed");
        }
        asset.forceApprove(address(controller), 0);
    }
    function settled() public view returns (bool) {
        if (firstRequest == 0 || cancelled) return false;
        for (uint256 i; i < ids.length; ++i) {
            (,,,,,,,, bool completed) = controller.requests(firstRequest + i);
            if (!completed) return false;
        }
        return true;
    }
    function cancel() external onlyVault {
        require(!cancelled && firstRequest != 0);
        controller.cancelBatch(firstRequest);
        cancelled = true;
        IERC20 asset = controller.usdg();
        asset.safeTransfer(vault, asset.balanceOf(address(this)));
    }
    function release(address receiver, uint256 numerator, uint256 denominator) external onlyVault {
        require(settled() && numerator != 0 && numerator <= denominator);
        for (uint256 i; i < ids.length; ++i) {
            IERC20 token = IERC20(controller.memberToken(ids[i]));
            token.safeTransfer(receiver, Math.mulDiv(token.balanceOf(address(this)), numerator, denominator));
        }
        IERC20 asset = controller.usdg();
        asset.safeTransfer(receiver, Math.mulDiv(asset.balanceOf(address(this)), numerator, denominator));
    }
}

/// USDG exits remain pending until the member redemptions settle. The user can
/// recover unsettled member claims in kind if execution stops; no admin recipient.
contract NeutralExit {
    using SafeERC20 for IERC20;
    MemberController public immutable controller;
    address public immutable vault;
    address public immutable owner;
    address public immutable receiver;
    uint256 public minimumAssets;
    uint256[] private ids;
    uint256[] private requests;
    uint256 public queuedMembers;
    uint64 public deadline;
    bool public started;
    bool public completed;
    event Paid(address indexed receiver, uint256 assets);
    event Recovered(address indexed owner);

    constructor(MemberController c, address v, address o, address r, uint256 minimum, uint256[] memory members) {
        require(o != address(0) && r != address(0));
        controller = c; vault = v; owner = o; receiver = r; minimumAssets = minimum; ids = members;
    }
    function start(uint64 deadline_) external {
        require(msg.sender == vault && !started && deadline_ > block.timestamp);
        started = true;
        deadline = deadline_;
        IERC20 asset = controller.usdg();
        // Locally held USDG did not pass through a member redemption.
        uint256 fee = Math.mulDiv(asset.balanceOf(address(this)), controller.EXIT_FEE_BPS(), 10_000);
        if (fee != 0) {
            asset.forceApprove(address(controller), fee);
            controller.payHouseFee(fee);
            asset.forceApprove(address(controller), 0);
        }
    }
    function memberCount() external view returns (uint256) { return ids.length; }
    /// Permissionless, bounded batches keep a 50-tier exit below transaction gas
    /// limits. Even boundaries enqueue each long/short pair together.
    function queue(uint256 maximumMembers) external {
        require(started && !completed && deadline > block.timestamp);
        require(maximumMembers >= 2 && maximumMembers <= 20 && maximumMembers % 2 == 0);
        uint256 end = Math.min(queuedMembers + maximumMembers, ids.length);
        for (uint256 i = queuedMembers; i < end; ++i) {
            queuedMembers = i + 1;
            IERC20 token = IERC20(controller.memberToken(ids[i]));
            uint256 shares = token.balanceOf(address(this));
            if (shares != 0) {
                token.forceApprove(address(controller), shares);
                requests.push(controller.requestRedeem(ids[i], shares, 1, address(this), deadline));
                token.forceApprove(address(controller), 0);
            }
        }
    }
    function extendDeadline(uint64 next) external {
        require(msg.sender == owner && !completed && next > block.timestamp && next > deadline);
        deadline = next;
    }
    function requestIds() external view returns (uint256[] memory) { return requests; }
    function ready() public view returns (bool) {
        if (!started || completed || queuedMembers != ids.length) return false;
        for (uint256 i; i < requests.length; ++i) {
            (,,,,,,,, bool done) = controller.requests(requests[i]);
            if (!done) return false;
        }
        return true;
    }
    function finish() external {
        require(ready());
        IERC20 asset = controller.usdg();
        uint256 assets = asset.balanceOf(address(this));
        require(assets >= minimumAssets, "Exit minimum");
        completed = true;
        asset.safeTransfer(receiver, assets);
        emit Paid(receiver, assets);
    }
    function lowerMinimum(uint256 minimum) external {
        require(msg.sender == owner && !completed && minimum <= minimumAssets);
        minimumAssets = minimum;
    }
    function recoverInKind() external {
        require(msg.sender == owner && started && !completed);
        completed = true;
        for (uint256 i; i < requests.length; ++i) {
            (,,,,,,,, bool done) = controller.requests(requests[i]);
            if (!done) controller.cancelRequest(requests[i]);
        }
        for (uint256 i; i < ids.length; ++i) {
            IERC20 token = IERC20(controller.memberToken(ids[i]));
            uint256 balance = token.balanceOf(address(this));
            if (balance != 0) token.safeTransfer(owner, balance);
        }
        IERC20 asset = controller.usdg();
        asset.safeTransfer(owner, asset.balanceOf(address(this)));
        emit Recovered(owner);
    }
}

/// Child bytecode lives outside the vault's EIP-170 runtime budget.
contract NeutralEscrowFactory {
    MemberController public immutable controller;
    constructor(MemberController c) { require(address(c).code.length != 0); controller = c; }
    function allocation(bytes32 group, uint256[] calldata ids) external returns (NeutralAllocation) {
        return new NeutralAllocation(controller, msg.sender, group, ids);
    }
    function exit(address owner, address receiver, uint256 minimum, uint256[] calldata ids) external returns (NeutralExit) {
        return new NeutralExit(controller, msg.sender, owner, receiver, minimum, ids);
    }
}
