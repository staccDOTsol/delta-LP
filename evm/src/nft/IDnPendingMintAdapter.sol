// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Pending funding is USDG held for an NFT account, NOT an activated DN receipt.
interface IDnPendingMintAdapter {
    function receiptToken() external view returns (address);
    function ready() external view returns (bool);
    function batchOf(address account) external view returns (address);
    function contributedAssets(address account) external view returns (uint256);

    /// Convert ETH into actual USDG and credit each account in an isolated batch.
    /// Minimums are USDG's six-decimal units, before the later DN entry fee.
    function depositNative(address[] calldata accounts, uint256[] calldata assets, uint256[] calldata minimumUSDG)
        external payable returns (address batch);
}
