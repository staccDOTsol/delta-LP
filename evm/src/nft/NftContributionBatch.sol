// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {NeutralVault} from "../tokenized/NeutralVault.sol";

/// Mint proceeds, credited to fixed NFT accounts, aggregate into one vault payer.
/// Contributions are pending cash, not DN shares. There is no owner or sweep.
contract NftContributionBatch is ReentrancyGuard {
    using SafeERC20 for IERC20;
    enum State { Collecting, Queued, Settled }
    NeutralVault public immutable vault;
    IERC20 public immutable asset;
    address public immutable adapter;
    uint256 public constant RECOVERY_DELAY = 1 days;
    uint256 public constant ALLOCATION_WINDOW = 20 minutes;
    State public state;
    uint256 public totalContributions;
    uint256 public remainingContributions;
    uint256 public queuedAt;
    uint256 public queuedEpoch;
    mapping(address => uint256) public contributions;
    mapping(address => uint256) public remainingByAsset;
    mapping(address => mapping(address => bool)) public claimedAsset;
    address[] private payoutAssets;

    event Credited(address indexed account, uint256 assets);
    event Withdrawn(address indexed account, uint256 assets);
    event Queued(uint256 indexed epoch, uint256 assets);
    event Settled(uint256 receiptShares, uint256 localCash, bool recoveredInKind);
    event Claimed(address indexed account, uint256 contribution);
    error Unavailable();
    error InvalidInput();
    error InexactTransfer();

    constructor(NeutralVault vault_, address adapter_) {
        if (address(vault_).code.length == 0 || adapter_ == address(0)) revert InvalidInput();
        vault = vault_; asset = vault_.asset(); adapter = adapter_;
    }

    function collecting() external view returns (bool) { return state == State.Collecting; }
    function payoutAssetCount() external view returns (uint256) { return payoutAssets.length; }
    function payoutAsset(uint256 index) external view returns (address) { return payoutAssets[index]; }

    /// Only the adapter can add claims, and only against exact received USDG.
    function credit(address[] calldata accounts, uint256[] calldata amounts) external nonReentrant {
        if (msg.sender != adapter || state != State.Collecting) revert Unavailable();
        if (accounts.length == 0 || accounts.length > 20 || accounts.length != amounts.length) revert InvalidInput();
        uint256 sum;
        for (uint256 i; i < accounts.length; ++i) {
            if (accounts[i] == address(0) || accounts[i] == address(this) || amounts[i] == 0) revert InvalidInput();
            contributions[accounts[i]] += amounts[i]; sum += amounts[i];
            emit Credited(accounts[i], amounts[i]);
        }
        uint256 beforeBalance = asset.balanceOf(address(this));
        asset.safeTransferFrom(msg.sender, address(this), sum);
        if (asset.balanceOf(address(this)) != beforeBalance + sum) revert InexactTransfer();
        totalContributions += sum;
    }

    /// The NFT's account authorizes its own cash withdrawal before allocation.
    /// NFT sale fees already paid to their recipients are not refunded here.
    function withdraw() external nonReentrant {
        uint256 amount = contributions[msg.sender];
        if (state != State.Collecting || amount == 0) revert Unavailable();
        delete contributions[msg.sender]; totalContributions -= amount;
        _pay(asset, msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    /// One batch consumes one vault depositor slot. No receipt inventory needed.
    /// The vault enforces actual NAV, fee-adjusted execution loss and delta bounds.
    function queue() external nonReentrant {
        uint256 amount = totalContributions;
        if (state != State.Collecting || amount == 0 || !vault.entriesOpen()
            || vault.phase() != NeutralVault.Phase.Collecting
            || amount + vault.pendingAssets() < vault.minimumBatchAssets()) revert Unavailable();
        state = State.Queued; queuedAt = block.timestamp; queuedEpoch = vault.epoch();
        remainingContributions = amount;
        asset.forceApprove(address(vault), amount);
        vault.enter(amount, 1, address(this), uint64(block.timestamp + ALLOCATION_WINDOW));
        asset.forceApprove(address(vault), 0);
        emit Queued(queuedEpoch, amount);
    }

    /// Anyone may recover a stalled batch, but every asset still belongs to its
    /// fixed NFT accounts. Issued claims recover in kind, not as a cash promise.
    function recover() external nonReentrant {
        if (state != State.Queued || block.timestamp < queuedAt + RECOVERY_DELAY) revert Unavailable();
        (uint256 pending,,,) = vault.deposits(address(this));
        bool inKind;
        if (pending != 0) {
            if (vault.phase() == NeutralVault.Phase.Allocating) {
                if (vault.allocation().settled()) {
                    vault.recoverPending(false, 0, 0); inKind = true;
                } else {
                    vault.cancelAllocation(); vault.refund(address(this));
                }
            } else vault.refund(address(this));
        }
        _settle(inKind);
    }

    /// Outcome is determined from actual funds. A cleared deposit alone does
    /// not prove activation: an external refund can also clear that mapping.
    function settle() external nonReentrant { _settle(false); }
    function _settle(bool inKind) private {
        if (state != State.Queued) revert Unavailable();
        (uint256 pending,,,) = vault.deposits(address(this));
        if (pending != 0) revert Unavailable();
        uint256 receipts = vault.balanceOf(address(this));
        uint256 cash = asset.balanceOf(address(this));
        _addPayout(address(asset)); _addPayout(address(vault));
        bool backed = receipts != 0 || cash != 0;
        if (inKind) {
            uint256[] memory ids = vault.memberIds();
            for (uint256 i; i < ids.length; ++i) {
                address token = vault.controller().memberToken(ids[i]);
                _addPayout(token);
                if (IERC20(token).balanceOf(address(this)) != 0) backed = true;
            }
        }
        if (!backed) revert Unavailable();
        state = State.Settled;
        emit Settled(receipts, cash, inKind);
    }

    /// Permissionless delivery goes only to the credited NFT account. Its
    /// current NFT owner controls that account even if the NFT has transferred.
    function claim(address account) external nonReentrant {
        if (state == State.Queued) _settle(false);
        _claimable(account);
        bool cash = _claimAsset(account, address(asset));
        bool shares = _claimAsset(account, address(vault));
        if (!cash && !shares) revert Unavailable();
        if (cash) remainingContributions -= contributions[account];
        emit Claimed(account, contributions[account]);
    }

    /// Recovering all 100 member assets is paginated; any caller can deliver
    /// each page, but the recipient is always the original NFT account.
    function claimInKind(address account, uint256 start, uint256 count) external nonReentrant {
        _claimable(account);
        if (count == 0 || count > 20 || start + count > payoutAssets.length - 2) revert InvalidInput();
        bool changed;
        for (uint256 i = start + 2; i < start + count + 2; ++i) {
            if (_claimAsset(account, payoutAssets[i])) changed = true;
        }
        if (!changed) revert Unavailable();
        emit Claimed(account, contributions[account]);
    }

    function _addPayout(address token) private {
        payoutAssets.push(token); remainingByAsset[token] = totalContributions;
    }
    function _claimable(address account) private view {
        if (state != State.Settled || contributions[account] == 0) revert Unavailable();
    }
    function _claimAsset(address account, address tokenAddress) private returns (bool) {
        if (claimedAsset[account][tokenAddress]) return false;
        uint256 amount = contributions[account]; uint256 remaining = remainingByAsset[tokenAddress];
        claimedAsset[account][tokenAddress] = true;
        remainingByAsset[tokenAddress] = remaining - amount;
        IERC20 token = IERC20(tokenAddress);
        uint256 payout = Math.mulDiv(token.balanceOf(address(this)), amount, remaining);
        if (payout != 0) _pay(token, account, payout);
        return true;
    }

    function _pay(IERC20 token, address to, uint256 amount) private {
        uint256 beforeSender = token.balanceOf(address(this)); uint256 beforeReceiver = token.balanceOf(to);
        token.safeTransfer(to, amount);
        if (token.balanceOf(address(this)) != beforeSender - amount || token.balanceOf(to) != beforeReceiver + amount) revert InexactTransfer();
    }
}
