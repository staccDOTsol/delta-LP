// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {NeutralVault} from "../tokenized/NeutralVault.sol";
import {NeutralExit} from "../tokenized/NeutralEscrows.sol";
import {IDnMintAdapter} from "./IDnMintAdapter.sol";

/// Atomic sales of ALREADY ACTIVATED receipts; never mints an IOU for a venue order.
/// Seed receipts are irrevocable protocol inventory, not an LP deposit claim.
/// All sale proceeds remain in this contract or the fixed vault for replenishment.
/// Owner controls availability/quotes, but cannot withdraw inventory or cash.
contract DnInventoryAdapter is IDnMintAdapter, Ownable2Step, ReentrancyGuard, IUnlockCallback {
    using SafeERC20 for IERC20;
    NeutralVault public immutable VAULT;
    IERC20 public constant USDG = IERC20(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);
    IPoolManager public constant MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    address public constant SWAP_HOOK = 0xC74E7983718DAEEfE5dA80690Afbd65d7eF74088;
    uint256 public immutable ENTRY_BPS;
    uint256 public constant MAX_QUOTE_AGE = 15 minutes;
    bytes32 public immutable vaultCodeHash;
    bytes32 public immutable managerCodeHash;
    bytes32 public immutable swapHookCodeHash;
    bool public paused = true;
    mapping(address => bool) public editions;
    mapping(address => bool) public recoveryExits;
    uint256 public minimumUsdPerEth; // USDG's 6-decimal units per 1 ETH
    uint256 public maximumSharesPerUsd; // receipt units per 1 USDG (1e6 units)
    uint256 public remainingNative; // aggregate sales cap until quote refresh
    uint48 public validUntil;
    bytes32 private unlockHash;

    event EditionAllowed(address indexed edition, bool allowed);
    event Quote(uint256 minimumUsdPerEth, uint256 maximumSharesPerUsd, uint256 nativeCap, uint48 validUntil);
    event InventoryDonated(address indexed donor, uint256 shares);
    event Sold(address indexed edition, uint256 nativeAssets, uint256 usdgReceived, uint256 sharesDelivered);
    event ReplenishmentQueued(uint256 assets, uint256 minimumShares);
    event PendingRecovery(address indexed exitEscrow);
    error Unavailable();
    error InvalidInput();
    error SettlementFailed();

    constructor(address owner_, NeutralVault vault_, bytes32 expectedVaultHash) Ownable(owner_) {
        VAULT = vault_;
        if (
            block.chainid != 4663 || address(VAULT).code.length == 0 || address(USDG).code.length == 0
                || address(MANAGER).code.length == 0 || SWAP_HOOK.code.length == 0
                || address(VAULT).codehash != expectedVaultHash || address(VAULT.asset()) != address(USDG)
        ) revert InvalidInput();
        ENTRY_BPS = VAULT.controller().ENTRY_FEE_BPS();
        if (ENTRY_BPS == 0 || ENTRY_BPS > 1000) revert InvalidInput();
        vaultCodeHash = address(VAULT).codehash;
        managerCodeHash = address(MANAGER).codehash;
        swapHookCodeHash = SWAP_HOOK.codehash;
    }

    function receiptToken() external view returns (address) {
        return address(VAULT);
    }

    function setEdition(address edition, bool allowed) external onlyOwner {
        if (edition.code.length == 0) revert InvalidInput();
        editions[edition] = allowed;
        emit EditionAllowed(edition, allowed);
    }

    function setPaused(bool value) external onlyOwner {
        paused = value;
    }

    function setQuote(uint256 minimumUsd, uint256 maximumShares, uint256 nativeCap, uint48 expiry) external onlyOwner {
        if (
            minimumUsd == 0 || maximumShares == 0 || nativeCap == 0 || expiry <= block.timestamp
                || expiry > block.timestamp + MAX_QUOTE_AGE
        ) revert InvalidInput();
        minimumUsdPerEth = minimumUsd;
        maximumSharesPerUsd = maximumShares;
        remainingNative = nativeCap;
        validUntil = expiry;
        emit Quote(minimumUsd, maximumShares, nativeCap, expiry);
    }

    function ready() public view returns (bool) {
        if (
            paused || remainingNative == 0 || block.timestamp > validUntil || !_dependencies()
                || VAULT.totalSupply() == 0 || VAULT.balanceOf(address(this)) == 0
        ) return false;
        try VAULT.portfolio() returns (uint256 nav, int256 delta, uint256) {
            return nav != 0 && _abs(delta) <= nav / 200;
        } catch {
            return false;
        }
    }

    function _dependencies() private view returns (bool) {
        return address(VAULT).codehash == vaultCodeHash && address(MANAGER).codehash == managerCodeHash
            && SWAP_HOOK.codehash == swapHookCodeHash;
    }

    /// Donor receives no claim against the reserve. User NFT holdings are never pulled back.
    function donateInventory(uint256 shares) external nonReentrant {
        if (shares == 0) revert InvalidInput();
        IERC20(address(VAULT)).safeTransferFrom(msg.sender, address(this), shares);
        emit InventoryDonated(msg.sender, shares);
    }

    function depositNative(address[] calldata receivers, uint256[] calldata assets, uint256[] calldata minimums)
        external
        payable
        nonReentrant
    {
        uint256 count = receivers.length;
        if (!editions[msg.sender] || !ready() || msg.value == 0 || msg.value > remainingNative) revert Unavailable();
        if (count == 0 || count > 20 || assets.length != count || minimums.length != count) revert InvalidInput();
        uint256 sum;
        for (uint256 i; i < count; ++i) {
            if (receivers[i] == address(0) || receivers[i] == address(this) || assets[i] == 0 || minimums[i] == 0) {
                revert InvalidInput();
            }
            sum += assets[i];
        }
        if (sum != msg.value || msg.value > uint256(uint128(type(int128).max))) revert InvalidInput();
        (uint256 nav,,) = VAULT.portfolio();
        uint256 supply = VAULT.totalSupply();
        remainingNative -= msg.value;
        uint256 beforeCash = USDG.balanceOf(address(this));
        bytes memory data = abi.encode(msg.value);
        unlockHash = keccak256(data);
        MANAGER.unlock(data);
        delete unlockHash;
        uint256 output = USDG.balanceOf(address(this)) - beforeCash;
        if (output < Math.mulDiv(msg.value, minimumUsdPerEth, 1 ether, Math.Rounding.Ceil)) revert SettlementFailed();
        // Reserve the bound controller's actual entry cost; no second fee is sent
        // now. The controller routes it when replenishment claims are issued.
        uint256 backing = Math.mulDiv(output, 10_000 - ENTRY_BPS, 10_000);
        uint256 shares = Math.mulDiv(backing, supply, nav);
        if (
            shares == 0 || shares > VAULT.balanceOf(address(this))
                || shares > Math.mulDiv(backing, maximumSharesPerUsd, 1e6)
        ) revert SettlementFailed();
        uint256 delivered;
        for (uint256 i; i < count; ++i) {
            uint256 quantity = Math.mulDiv(shares, assets[i], msg.value);
            if (quantity == 0 || quantity < minimums[i]) revert SettlementFailed();
            IERC20(address(VAULT)).safeTransfer(receivers[i], quantity);
            delivered += quantity;
        }
        emit Sold(msg.sender, msg.value, output, delivered);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(MANAGER) || unlockHash == bytes32(0) || keccak256(data) != unlockHash) {
            revert InvalidInput();
        }
        delete unlockHash;
        uint256 amount = abi.decode(data, (uint256));
        PoolKey memory key =
            PoolKey(Currency.wrap(address(0)), Currency.wrap(address(USDG)), 0x800000, 60, IHooks(SWAP_HOOK));
        BalanceDelta change =
            MANAGER.swap(key, IPoolManager.SwapParams(true, -int256(amount), TickMath.MIN_SQRT_PRICE + 1), "");
        // Reject partial consumption: never strand an unallocated ETH remainder.
        if (change.amount0() != -int256(amount) || change.amount1() <= 0) revert SettlementFailed();
        MANAGER.sync(key.currency0);
        MANAGER.settle{value: amount}();
        MANAGER.take(key.currency1, address(this), uint256(uint128(change.amount1())));
        return "";
    }

    /// Queues existing proceeds. No receipt is counted as inventory until activate()
    /// has actually minted it. Every epoch uses this one fixed payer/receiver.
    function replenish(uint256 assets, uint256 minimumShares, uint64 deadline) external onlyOwner nonReentrant {
        if (!_dependencies() || assets == 0 || minimumShares == 0) revert InvalidInput();
        USDG.forceApprove(address(VAULT), assets);
        VAULT.enter(assets, minimumShares, address(this), deadline);
        USDG.forceApprove(address(VAULT), 0);
        emit ReplenishmentQueued(assets, minimumShares);
    }

    function refundPending() external onlyOwner nonReentrant {
        VAULT.refund(address(this));
    }

    function cancelPending() external onlyOwner nonReentrant {
        VAULT.cancelAllocation();
    }

    function lowerPendingMinimum(uint256 minimum) external onlyOwner {
        VAULT.lowerMinimum(minimum);
    }

    function recoverPending(uint256 minimumAssets, uint64 deadline)
        external
        onlyOwner
        nonReentrant
        returns (address exit)
    {
        exit = VAULT.recoverPending(true, minimumAssets, deadline);
        recoveryExits[exit] = true;
        emit PendingRecovery(exit);
    }

    function updateRecovery(address exit, uint256 minimumAssets, uint64 deadline) external onlyOwner {
        if (!recoveryExits[exit]) revert InvalidInput();
        NeutralExit(exit).lowerMinimum(minimumAssets);
        if (deadline > NeutralExit(exit).deadline()) NeutralExit(exit).extendDeadline(deadline);
    }

    function _abs(int256 value) private pure returns (uint256) {
        if (value == type(int256).min) return type(uint256).max;
        return uint256(value < 0 ? -value : value);
    }
}
