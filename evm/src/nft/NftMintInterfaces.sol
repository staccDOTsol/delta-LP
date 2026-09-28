// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PublicDrop} from "./seadrop/SeaDropStructs.sol";

interface INftSeaDrop {
    function mintPublic(address nft, address feeRecipient, address minterIfNotPayer, uint256 quantity) external payable;
    function updatePublicDrop(PublicDrop calldata publicDrop) external;
    function updateCreatorPayoutAddress(address payout) external;
    function updateAllowedFeeRecipient(address recipient, bool allowed) external;
    function updateDropURI(string calldata uri) external;
    function updatePayer(address payer, bool allowed) external;
}

interface INftAccountRegistry {
    function account(address implementation, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId)
        external
        view
        returns (address);
    function createAccount(
        address implementation,
        bytes32 salt,
        uint256 chainId,
        address tokenContract,
        uint256 tokenId
    ) external returns (address);
}

interface INftHouseFees {
    function FANOUT() external view returns (address);
    function payNative() external payable;
}
