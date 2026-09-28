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
import {NftContributionBatch} from "./NftContributionBatch.sol";
import {IDnPendingMintAdapter} from "./IDnPendingMintAdapter.sol";

/// Mint proceeds bootstrap the strategy. This contract issues NO DN receipts.
/// Actual USDG is segregated into batch escrows whose claims belong to NFT accounts.
/// No owner withdrawal, arbitrary swap route, reserve donor, or seed inventory.
contract DnPendingAdapter is IDnPendingMintAdapter, Ownable2Step, ReentrancyGuard, IUnlockCallback {
    using SafeERC20 for IERC20;
    NeutralVault public immutable VAULT;
    IERC20 public constant USDG = IERC20(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);
    IPoolManager public constant MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    address public constant SWAP_HOOK = 0xC74E7983718DAEEfE5dA80690Afbd65d7eF74088;
    uint256 public constant MAX_QUOTE_AGE = 15 minutes;
    bytes32 public immutable vaultCodeHash;
    bytes32 public immutable managerCodeHash;
    bytes32 public immutable swapHookCodeHash;
    bool public paused = true;
    mapping(address => bool) public editions;
    mapping(address => address) public override batchOf;
    NftContributionBatch public currentBatch;
    uint256 public minimumUsdPerEth;
    uint256 public remainingNative;
    uint48 public validUntil;
    bytes32 private unlockHash;

    event EditionAllowed(address indexed edition, bool allowed);
    event Quote(uint256 minimumUsdPerEth, uint256 nativeCap, uint48 validUntil);
    event BatchCreated(address indexed batch);
    event ContributionRecorded(address indexed account, address indexed batch, uint256 usdgAssets);
    event SaleContributed(address indexed edition, address indexed batch, uint256 nativeAssets, uint256 usdgAssets);
    error InvalidInput();
    error Unavailable();
    error SettlementFailed();

    constructor(address owner_, NeutralVault vault_, bytes32 expectedVaultHash) Ownable(owner_) {
        VAULT = vault_;
        if (
            block.chainid != 4663 || address(VAULT).code.length == 0 || address(USDG).code.length == 0
                || address(MANAGER).code.length == 0 || SWAP_HOOK.code.length == 0
                || address(VAULT).codehash != expectedVaultHash || address(VAULT.asset()) != address(USDG)
        ) revert InvalidInput();
        vaultCodeHash = address(VAULT).codehash;
        managerCodeHash = address(MANAGER).codehash;
        swapHookCodeHash = SWAP_HOOK.codehash;
    }

    function receiptToken() external view returns (address) { return address(VAULT); }

    function contributedAssets(address account) external view returns (uint256) {
        address batch = batchOf[account];
        return batch == address(0) ? 0 : NftContributionBatch(batch).contributions(account);
    }

    function setEdition(address edition, bool allowed) external onlyOwner {
        if (edition.code.length == 0) revert InvalidInput();
        editions[edition] = allowed;
        emit EditionAllowed(edition, allowed);
    }

    function setPaused(bool value) external onlyOwner { paused = value; }

    function setQuote(uint256 minimumUsd, uint256 nativeCap, uint48 expiry) external onlyOwner {
        if (minimumUsd == 0 || nativeCap == 0 || expiry <= block.timestamp || expiry > block.timestamp + MAX_QUOTE_AGE) {
            revert InvalidInput();
        }
        minimumUsdPerEth = minimumUsd;
        remainingNative = nativeCap;
        validUntil = expiry;
        emit Quote(minimumUsd, nativeCap, expiry);
    }

    /// Cash contributions can begin with zero vault supply and no seed capital.
    function ready() public view returns (bool) {
        return !paused && remainingNative != 0 && block.timestamp <= validUntil
            && address(VAULT).codehash == vaultCodeHash && address(MANAGER).codehash == managerCodeHash
            && SWAP_HOOK.codehash == swapHookCodeHash;
    }

    function depositNative(address[] calldata accounts, uint256[] calldata assets, uint256[] calldata minimums)
        external payable nonReentrant returns (address batchAddress)
    {
        uint256 count = accounts.length;
        if (!editions[msg.sender] || !ready() || msg.value == 0 || msg.value > remainingNative) revert Unavailable();
        if (count == 0 || count > 20 || assets.length != count || minimums.length != count) revert InvalidInput();
        uint256 sum;
        for (uint256 i; i < count; ++i) {
            if (accounts[i].code.length == 0 || accounts[i] == address(this) || assets[i] == 0 || minimums[i] == 0
                || batchOf[accounts[i]] != address(0)) revert InvalidInput();
            for (uint256 j; j < i; ++j) if (accounts[i] == accounts[j]) revert InvalidInput();
            sum += assets[i];
        }
        if (sum != msg.value || msg.value > uint256(uint128(type(int128).max))) revert InvalidInput();
        remainingNative -= msg.value;
        uint256 beforeCash = USDG.balanceOf(address(this));
        bytes memory data = abi.encode(msg.value);
        unlockHash = keccak256(data);
        MANAGER.unlock(data);
        delete unlockHash;
        uint256 output = USDG.balanceOf(address(this)) - beforeCash;
        if (output < Math.mulDiv(msg.value, minimumUsdPerEth, 1 ether, Math.Rounding.Ceil)) revert SettlementFailed();

        NftContributionBatch batch = currentBatch;
        if (address(batch) == address(0) || !batch.collecting()) {
            batch = new NftContributionBatch(VAULT, address(this));
            currentBatch = batch;
            emit BatchCreated(address(batch));
        }
        batchAddress = address(batch);
        uint256[] memory credits = new uint256[](count);
        uint256 allocated;
        for (uint256 i; i < count; ++i) {
            uint256 amount = i + 1 == count ? output - allocated : Math.mulDiv(output, assets[i], msg.value);
            if (amount == 0 || amount < minimums[i]) revert SettlementFailed();
            allocated += amount;
            credits[i] = amount;
            batchOf[accounts[i]] = batchAddress;
        }
        USDG.forceApprove(batchAddress, output);
        batch.credit(accounts, credits);
        USDG.forceApprove(batchAddress, 0);
        if (USDG.balanceOf(address(this)) != beforeCash) revert SettlementFailed();
        for (uint256 i; i < count; ++i) {
            if (batch.contributions(accounts[i]) != credits[i]) revert SettlementFailed();
            emit ContributionRecorded(accounts[i], batchAddress, credits[i]);
        }
        emit SaleContributed(msg.sender, batchAddress, msg.value, output);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(MANAGER) || unlockHash == bytes32(0) || keccak256(data) != unlockHash) revert InvalidInput();
        delete unlockHash;
        uint256 amount = abi.decode(data, (uint256));
        PoolKey memory key = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(USDG)), 0x800000, 60, IHooks(SWAP_HOOK));
        BalanceDelta change = MANAGER.swap(key, IPoolManager.SwapParams(true, -int256(amount), TickMath.MIN_SQRT_PRICE + 1), "");
        if (change.amount0() != -int256(amount) || change.amount1() <= 0) revert SettlementFailed();
        MANAGER.sync(key.currency0);
        MANAGER.settle{value: amount}();
        MANAGER.take(key.currency1, address(this), uint256(uint128(change.amount1())));
        return "";
    }
}
