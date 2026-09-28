// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {
    PublicDrop,
    AllowListData,
    TokenGatedDropStage,
    SignedMintValidationParams,
    MintParams
} from "./SeaDropStructs.sol";

// Field-for-field ABI used by ERC721SeaDrop / OpenSea Studio. Keep ordering and
// integer widths: matching only function names does not match the selector.
struct MultiConfigureStruct {
    uint256 maxSupply;
    string baseURI;
    string contractURI;
    address seaDropImpl;
    PublicDrop publicDrop;
    string dropURI;
    AllowListData allowListData;
    address creatorPayoutAddress;
    bytes32 provenanceHash;
    address[] allowedFeeRecipients;
    address[] disallowedFeeRecipients;
    address[] allowedPayers;
    address[] disallowedPayers;
    address[] tokenGatedAllowedNftTokens;
    TokenGatedDropStage[] tokenGatedDropStages;
    address[] disallowedTokenGatedAllowedNftTokens;
    address[] signers;
    SignedMintValidationParams[] signedMintValidationParams;
    address[] disallowedSigners;
}

interface ISeaDropStudio {
    function getPublicDrop(address nft) external view returns (PublicDrop memory);
    function getCreatorPayoutAddress(address nft) external view returns (address);
    function getFeeRecipientIsAllowed(address nft, address recipient) external view returns (bool);
    function getPayerIsAllowed(address nft, address payer) external view returns (bool);
    function updatePayer(address payer, bool allowed) external;
    function getSignedMintValidationParams(address nft, address signer)
        external
        view
        returns (SignedMintValidationParams memory);
    function updateSignedMintValidationParams(address signer, SignedMintValidationParams calldata params) external;
    function mintSigned(
        address nft,
        address feeRecipient,
        address minterIfNotPayer,
        uint256 quantity,
        MintParams calldata params,
        uint256 salt,
        bytes calldata signature
    ) external payable;
}
