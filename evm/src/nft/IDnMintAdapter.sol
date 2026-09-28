// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Boundary between NFT settlement and the pooled DN strategy.
/// @dev A production implementation must settle ETH into actual redeemable DN
/// shares, aggregate small deposits, enforce execution limits, and preserve the
/// existing strategy entry fee. Pending orders/cash must not masquerade as shares.
interface IDnMintAdapter {
    function receiptToken() external view returns (address);
    function ready() external view returns (bool);

    /// Sum(assets) must equal msg.value. Each receiver is an ERC-6551 account.
    /// Revert if any receiver cannot get its minimum shares. No deferred success.
    function depositNative(address[] calldata receivers, uint256[] calldata assets, uint256[] calldata minShares)
        external
        payable;
}
