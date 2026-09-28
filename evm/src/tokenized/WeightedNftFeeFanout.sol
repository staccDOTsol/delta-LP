// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IWeightedEdition is IERC721 {
    function denominationUsd() external view returns (uint256);
    function MAX_SUPPLY() external view returns (uint256);
}

/// Seven immutable 10k editions. Fixed weights reserve past entitlements for
/// unminted IDs; minting later acquires those reserves. Claims follow ownerOf.
/// No administrator withdrawal, recipient change, token sweep or share issuance.
contract WeightedNftFeeFanout is ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 public constant tokenCount = 70_000;
    uint256 public constant totalWeight = 1_880_000;
    uint256 public constant MAX_CLAIM = 50;
    address public initializer;
    bool public configured;
    address[7] public collections;

    struct Distribution {
        uint256 received;
        uint256 paid;
        uint256 accountedBalance;
    }
    mapping(address => Distribution) public distributions;
    // Asset -> edition index -> token ID -> lifetime claimed whole token units.
    mapping(address => mapping(uint8 => mapping(uint256 => uint256))) public claimed;
    event Configured(address[7] collections);
    event Harvested(address indexed token, uint256 added, uint256 received);
    event Claimed(address indexed token, address indexed owner, uint256 amount);
    error InvalidConfiguration();
    error InvalidClaim();
    error UnsupportedAsset();

    constructor(address initializer_) {
        if (initializer_ == address(0)) revert InvalidConfiguration();
        initializer = initializer_;
    }

    /// Order is $1, $2, $5, $10, $20, $50, $100. Authority is erased forever.
    function configure(address[7] calldata editions) external {
        if (configured || msg.sender != initializer) revert InvalidConfiguration();
        for (uint8 i; i < 7; ++i) {
            address edition = editions[i];
            if (
                edition.code.length == 0 || !IERC165(edition).supportsInterface(type(IERC721).interfaceId)
                    || IWeightedEdition(edition).denominationUsd() != weight(i)
                    || IWeightedEdition(edition).MAX_SUPPLY() != 10_000
            ) revert InvalidConfiguration();
            for (uint8 j; j < i; ++j) {
                if (editions[j] == edition) revert InvalidConfiguration();
            }
            collections[i] = edition;
        }
        configured = true;
        delete initializer;
        emit Configured(editions);
    }

    function weight(uint8 index) public pure returns (uint256) {
        if (index == 0) return 1;
        if (index == 1) return 2;
        if (index == 2) return 5;
        if (index == 3) return 10;
        if (index == 4) return 20;
        if (index == 5) return 50;
        if (index == 6) return 100;
        revert InvalidClaim();
    }

    /// Count actual ERC-20 receipts, not an untrusted router-provided amount.
    function harvest(address token) external nonReentrant {
        _harvest(token);
    }

    function _harvest(address token) private {
        if (!configured || token.code.length == 0) revert InvalidConfiguration();
        Distribution storage d = distributions[token];
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance < d.accountedBalance) revert UnsupportedAsset();
        uint256 added = balance - d.accountedBalance;
        if (added != 0) {
            d.received += added;
            d.accountedBalance = balance;
            emit Harvested(token, added, d.received);
        }
    }

    /// Cumulative exact mulDiv avoids per-harvest rounding loss. Fractions stay
    /// reserved until subsequent receipts make a whole unit claimable.
    function claimable(address token, uint8 collectionIndex, uint256 id) external view returns (uint256) {
        _validId(collectionIndex, id);
        Distribution memory d = distributions[token];
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance < d.accountedBalance) revert UnsupportedAsset();
        return Math.mulDiv(d.received + (balance - d.accountedBalance), weight(collectionIndex), totalWeight)
            - claimed[token][collectionIndex][id];
    }

    function claim(address token, uint8[] calldata collectionIndices, uint256[] calldata ids) external nonReentrant {
        uint256 length = ids.length;
        if (length == 0 || length > MAX_CLAIM || collectionIndices.length != length) revert InvalidClaim();
        _harvest(token);
        Distribution storage d = distributions[token];
        uint256 amount;
        for (uint256 i; i < length; ++i) {
            uint8 index = collectionIndices[i];
            uint256 id = ids[i];
            _validId(index, id);
            if (IERC721(collections[index]).ownerOf(id) != msg.sender) revert InvalidClaim();
            uint256 accrued = Math.mulDiv(d.received, weight(index), totalWeight);
            amount += accrued - claimed[token][index][id];
            claimed[token][index][id] = accrued;
        }
        if (amount == 0) return;
        d.paid += amount;
        d.accountedBalance -= amount;
        uint256 recipientBefore = IERC20(token).balanceOf(msg.sender);
        IERC20(token).safeTransfer(msg.sender, amount);
        // Reject negative rebases, sender surcharges and fee-on-transfer claims.
        if (
            IERC20(token).balanceOf(address(this)) != d.accountedBalance
                || IERC20(token).balanceOf(msg.sender) != recipientBefore + amount
        ) revert UnsupportedAsset();
        emit Claimed(token, msg.sender, amount);
    }

    function _validId(uint8 index, uint256 id) private view {
        if (!configured || index >= 7 || id == 0 || id > 10_000) revert InvalidClaim();
    }
}
