// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ISeaDropStudio, MultiConfigureStruct} from "./seadrop/ISeaDropStudio.sol";
import {IDnPendingMintAdapter} from "./IDnPendingMintAdapter.sol";
import {NftContributionBatch} from "./NftContributionBatch.sol";
import {INftSeaDrop, INftAccountRegistry, INftHouseFees} from "./NftMintInterfaces.sol";
import {INonFungibleSeaDropToken} from "./seadrop/INonFungibleSeaDropToken.sol";
import {ISeaDropTokenContractMetadata} from "./seadrop/ISeaDropTokenContractMetadata.sol";
import {PublicDrop, AllowListData, TokenGatedDropStage, SignedMintValidationParams} from "./seadrop/SeaDropStructs.sol";

/// @notice One 10,000-piece edition. Every NFT owns its pending cash contribution through ERC-6551.
/// Actual DN shares arrive only after the pooled strategy batch activates.
/// @dev Studio-compatible candidate, not an upgrade of the immutable V1 deployment.
/// Public and signed mints settle at the same public price and fixed fee split.
/// No administrator mint, withdrawal, account authority, or destination replacement.
contract DnPendingSeaDropEditionV2 is ERC721, Ownable2Step, ReentrancyGuard, INonFungibleSeaDropToken {
    INftSeaDrop public constant SEA_DROP = INftSeaDrop(0x00005EA00Ac477B1030CE78506496e8C2dE24bf5);
    INftAccountRegistry public constant REGISTRY = INftAccountRegistry(0x000000006551c19487814612e58FE06813775758);
    // Direct ERC-1167 delegation to Tokenbound's AccountV3. No second, mutable
    // AccountProxy implementation slot or public initialization window.
    address public constant ACCOUNT_IMPLEMENTATION = 0x41C8f39463A868d3A88af00cd0fe7102F30E44eC;
    address public constant OPENSEA_FEE_RECIPIENT = 0x0000a26b00c1F0DF003000390027140000fAa719;
    address public constant WIZARDS = 0x1b88A6c6516FD2918905186F21Bb9F5CaA1a15c8;
    uint256 public constant MAX_SUPPLY = 10_000;
    uint256 public constant MAX_BATCH = 20;
    uint256 public constant MAX_QUOTE_AGE = 30 minutes;
    uint16 public constant OPENSEA_BPS = 1_000;
    uint16 public constant WIZARDS_MINT_BPS = 100;
    uint16 public constant ROYALTY_BPS = 1_000;

    uint256 public immutable denominationUsd;
    IDnPendingMintAdapter public immutable adapter;
    IERC20 public immutable receipt;
    INftHouseFees public immutable houseFees;
    uint256 public totalMinted;
    mapping(address => uint256) public mintedBy;
    string public override baseURI;
    string public override contractURI;
    bytes32 public override provenanceHash;
    PublicDrop private _drop;
    bool public configured;
    bool public paused = true;
    uint256 public minUSDGPerEth;
    uint48 public quoteValidUntil;
    uint256 private _pendingFirst;
    uint256 private _pendingQuantity;
    uint256 private _pendingGross;

    struct Allocation {
        address[] accounts;
        uint256[] assets;
        uint256[] minimums;
        uint256[] balances;
    }

    event SeaDropTokenDeployed();
    event FundingQuoteUpdated(uint256 minUSDGPerEth, uint48 validUntil);
    event MintPauseUpdated(bool paused);
    event AccountContributionRecorded(
        uint256 indexed tokenId,
        address indexed account,
        address indexed batch,
        uint256 nativeAssets,
        uint256 usdgAssets
    );
    event MintSettled(
        uint256 firstTokenId, uint256 quantity, uint256 gross, uint256 openSeaFee, uint256 wizardFee, uint256 dnAssets
    );

    error InvalidConfiguration();
    error MintUnavailable();
    error UnsupportedStage();
    error ImmutablePolicy();
    error IncompleteFunding();

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 denomination_,
        address owner_,
        IDnPendingMintAdapter adapter_,
        INftHouseFees houseFees_
    ) ERC721(name_, symbol_) Ownable(owner_) {
        if (
            block.chainid != 4663 || address(SEA_DROP).code.length == 0 || address(REGISTRY).code.length == 0
                || ACCOUNT_IMPLEMENTATION.code.length == 0 || address(adapter_).code.length == 0
                || address(houseFees_).code.length == 0 || houseFees_.FANOUT() != WIZARDS
                || !_validDenomination(denomination_)
        ) revert InvalidConfiguration();
        address receipt_ = adapter_.receiptToken();
        if (receipt_.code.length == 0) revert InvalidConfiguration();
        denominationUsd = denomination_;
        adapter = adapter_;
        receipt = IERC20(receipt_);
        houseFees = houseFees_;
        emit SeaDropTokenDeployed();
        emit MaxSupplyUpdated(MAX_SUPPLY);
    }

    modifier noPendingMint() {
        if (_pendingQuantity != 0) revert MintUnavailable();
        _;
    }

    /// Must be called after deployment: SeaDrop checks ERC-165 on the caller.
    function configure() external onlyOwner noPendingMint {
        if (configured) revert ImmutablePolicy();
        configured = true;
        SEA_DROP.updateCreatorPayoutAddress(address(this));
        SEA_DROP.updateAllowedFeeRecipient(OPENSEA_FEE_RECIPIENT, true);
    }

    function setPaused(bool value) external onlyOwner noPendingMint {
        if (
            !value
                && (!configured
                    || !adapter.ready()
                    || quoteValidUntil < block.timestamp
                    || _drop.mintPrice == 0
                    || bytes(baseURI).length == 0
                    || bytes(contractURI).length == 0)
        ) revert MintUnavailable();
        paused = value;
        emit MintPauseUpdated(value);
    }

    /// Lower bound on pending USDG (6 decimals) per ETH after the fixed swap.
    /// These are contribution units BEFORE the later DN entry fee, not shares.
    function setFundingQuote(uint256 minimum, uint48 validUntil) external onlyOwner noPendingMint {
        if (minimum == 0 || validUntil <= block.timestamp || validUntil > block.timestamp + MAX_QUOTE_AGE) {
            revert InvalidConfiguration();
        }
        minUSDGPerEth = minimum;
        quoteValidUntil = validUntil;
        emit FundingQuoteUpdated(minimum, validUntil);
    }

    function mintSeaDrop(address minter, uint256 quantity) external override nonReentrant {
        if (msg.sender != address(SEA_DROP)) revert OnlyAllowedSeaDrop();
        if (
            paused || !configured || _pendingQuantity != 0 || quantity == 0 || quantity > MAX_BATCH
                || totalMinted + quantity > MAX_SUPPLY || block.timestamp > quoteValidUntil || !adapter.ready()
                || block.timestamp < _drop.startTime || block.timestamp > _drop.endTime
                || mintedBy[minter] + quantity > _drop.maxTotalMintableByWallet
        ) {
            revert MintUnavailable();
        }
        uint256 first = totalMinted + 1;
        totalMinted += quantity;
        mintedBy[minter] += quantity;
        _pendingFirst = first;
        _pendingQuantity = quantity;
        _pendingGross = uint256(_drop.mintPrice) * quantity;
        for (uint256 i; i < quantity; ++i) {
            REGISTRY.createAccount(ACCOUNT_IMPLEMENTATION, bytes32(0), block.chainid, address(this), first + i);
            _safeMint(minter, first + i);
        }
    }

    /// SeaDrop mints first, pays its fee, then calls the creator payout. Failure
    /// here rolls back the NFTs, accounts, OpenSea fee, and strategy operation.
    receive() external payable nonReentrant {
        uint256 quantity = _pendingQuantity;
        uint256 first = _pendingFirst;
        uint256 gross = _pendingGross;
        uint256 openSeaFee = gross * OPENSEA_BPS / 10_000;
        if (msg.sender != address(SEA_DROP) || quantity == 0 || msg.value != gross - openSeaFee) {
            revert IncompleteFunding();
        }
        uint256 wizardFee = gross * WIZARDS_MINT_BPS / 10_000;
        uint256 dnAssets = msg.value - wizardFee;
        if (wizardFee != 0) houseFees.payNative{value: wizardFee}();
        _fundAccounts(first, quantity, dnAssets);
        delete _pendingFirst;
        delete _pendingQuantity;
        delete _pendingGross;
        emit MintSettled(first, quantity, gross, openSeaFee, wizardFee, dnAssets);
    }

    function _fundAccounts(uint256 first, uint256 quantity, uint256 dnAssets) private {
        Allocation memory a = Allocation(
            new address[](quantity), new uint256[](quantity), new uint256[](quantity), new uint256[](quantity)
        );
        for (uint256 i; i < quantity; ++i) {
            a.accounts[i] = accountOf(first + i);
            a.assets[i] = dnAssets / quantity + (i < dnAssets % quantity ? 1 : 0);
            a.minimums[i] = Math.mulDiv(a.assets[i], minUSDGPerEth, 1 ether, Math.Rounding.Ceil);
            if (a.minimums[i] == 0) revert IncompleteFunding();
            if (adapter.batchOf(a.accounts[i]) != address(0)) revert IncompleteFunding();
            a.balances[i] = adapter.contributedAssets(a.accounts[i]);
        }
        address batch = adapter.depositNative{value: dnAssets}(a.accounts, a.assets, a.minimums);
        if (batch.code.length == 0) revert IncompleteFunding();
        for (uint256 i; i < quantity; ++i) {
            if (adapter.batchOf(a.accounts[i]) != batch) revert IncompleteFunding();
            uint256 afterBalance = NftContributionBatch(batch).contributions(a.accounts[i]);
            if (afterBalance < a.balances[i] || afterBalance - a.balances[i] < a.minimums[i]) {
                revert IncompleteFunding();
            }
            emit AccountContributionRecorded(first + i, a.accounts[i], batch, a.assets[i], afterBalance - a.balances[i]);
        }
    }

    function accountOf(uint256 tokenId) public view returns (address) {
        if (tokenId == 0 || tokenId > MAX_SUPPLY) revert InvalidConfiguration();
        return REGISTRY.account(ACCOUNT_IMPLEMENTATION, bytes32(0), block.chainid, address(this), tokenId);
    }

    function getMintStats(address minter) external view override returns (uint256, uint256, uint256) {
        return (mintedBy[minter], totalMinted, MAX_SUPPLY);
    }

    function updatePublicDrop(address seaDropImpl, PublicDrop calldata value) public override onlyOwner noPendingMint {
        _checkSeaDrop(seaDropImpl);
        if (
            !configured || value.mintPrice < 100 || value.feeBps != OPENSEA_BPS || !value.restrictFeeRecipients
                || value.startTime == 0 || value.endTime <= value.startTime || value.maxTotalMintableByWallet == 0
        ) revert InvalidConfiguration();
        _drop = value;
        SEA_DROP.updatePublicDrop(value);
    }

    function updateAllowedSeaDrop(address[] calldata allowed) external view override onlyOwner {
        if (allowed.length != 1 || allowed[0] != address(SEA_DROP)) revert ImmutablePolicy();
    }

    function updateCreatorPayoutAddress(address seaDropImpl, address payout) public view override onlyOwner {
        _checkSeaDrop(seaDropImpl);
        if (payout != address(this)) revert ImmutablePolicy();
    }

    function updateAllowedFeeRecipient(address seaDropImpl, address recipient, bool allowed)
        public
        view
        override
        onlyOwner
    {
        _checkSeaDrop(seaDropImpl);
        if (recipient != OPENSEA_FEE_RECIPIENT || !allowed) revert ImmutablePolicy();
    }

    function updateDropURI(address seaDropImpl, string calldata uri) public override onlyOwner noPendingMint {
        _checkSeaDrop(seaDropImpl);
        SEA_DROP.updateDropURI(uri);
    }

    function updatePayer(address seaDropImpl, address payer, bool allowed) public override onlyOwner noPendingMint {
        _checkSeaDrop(seaDropImpl);
        ISeaDropStudio sd = ISeaDropStudio(address(SEA_DROP));
        if (sd.getPayerIsAllowed(address(this), payer) != allowed) sd.updatePayer(payer, allowed);
    }

    // Disable alternate stages whose mint parameters could bypass the fixed split.
    function updateAllowList(address, AllowListData calldata) external pure override {
        revert UnsupportedStage();
    }

    function updateTokenGatedDrop(address, address, TokenGatedDropStage calldata) external pure override {
        revert UnsupportedStage();
    }

    /// Studio's broad signer envelope is narrowed to the immutable fee policy.
    /// The payout callback additionally enforces the exact current public price.
    function updateSignedMintValidationParams(address impl, address signer, SignedMintValidationParams memory p)
        public
        override
        onlyOwner
        noPendingMint
    {
        _checkSeaDrop(impl);
        ISeaDropStudio sd = ISeaDropStudio(impl);
        if (p.maxMaxTotalMintableByWallet == 0) {
            // Removing an absent signer must be safe to repeat, like payer removal.
            if (sd.getSignedMintValidationParams(address(this), signer).maxMaxTotalMintableByWallet != 0) {
                SignedMintValidationParams memory empty;
                sd.updateSignedMintValidationParams(signer, empty);
            }
            return;
        }
        if (!configured || _drop.mintPrice == 0 || p.minFeeBps > OPENSEA_BPS || p.maxFeeBps < OPENSEA_BPS) {
            revert InvalidConfiguration();
        }
        p.minFeeBps = OPENSEA_BPS;
        p.maxFeeBps = OPENSEA_BPS;
        if (p.minMintPrice < _drop.mintPrice) p.minMintPrice = _drop.mintPrice;
        sd.updateSignedMintValidationParams(signer, p);
    }

    /// Exact ERC721SeaDrop tuple, including optional fields used by Studio.
    /// Unsupported allowlist/token-gated stages fail explicitly, never silently.
    function multiConfigure(MultiConfigureStruct calldata c) external onlyOwner noPendingMint {
        _checkSeaDrop(c.seaDropImpl);
        if (!configured) revert InvalidConfiguration();
        if (c.maxSupply != 0) setMaxSupply(c.maxSupply);
        if (bytes(c.baseURI).length != 0) setBaseURI(c.baseURI);
        if (bytes(c.contractURI).length != 0) setContractURI(c.contractURI);
        if (c.provenanceHash != bytes32(0)) setProvenanceHash(c.provenanceHash);
        if (c.publicDrop.startTime != 0 || c.publicDrop.endTime != 0) updatePublicDrop(c.seaDropImpl, c.publicDrop);
        if (bytes(c.dropURI).length != 0) updateDropURI(c.seaDropImpl, c.dropURI);
        if (c.creatorPayoutAddress != address(0)) updateCreatorPayoutAddress(c.seaDropImpl, c.creatorPayoutAddress);
        if (
            c.allowListData.merkleRoot != bytes32(0) || c.tokenGatedAllowedNftTokens.length != 0
                || c.tokenGatedDropStages.length != 0 || c.disallowedTokenGatedAllowedNftTokens.length != 0
        ) {
            revert UnsupportedStage();
        }
        for (uint256 i; i < c.allowedFeeRecipients.length; ++i) {
            updateAllowedFeeRecipient(c.seaDropImpl, c.allowedFeeRecipients[i], true);
        }
        for (uint256 i; i < c.disallowedFeeRecipients.length; ++i) {
            updateAllowedFeeRecipient(c.seaDropImpl, c.disallowedFeeRecipients[i], false);
        }
        for (uint256 i; i < c.allowedPayers.length; ++i) {
            updatePayer(c.seaDropImpl, c.allowedPayers[i], true);
        }
        for (uint256 i; i < c.disallowedPayers.length; ++i) {
            updatePayer(c.seaDropImpl, c.disallowedPayers[i], false);
        }
        if (c.signers.length != c.signedMintValidationParams.length) revert InvalidConfiguration();
        for (uint256 i; i < c.signers.length; ++i) {
            updateSignedMintValidationParams(c.seaDropImpl, c.signers[i], c.signedMintValidationParams[i]);
        }
        SignedMintValidationParams memory empty;
        for (uint256 i; i < c.disallowedSigners.length; ++i) {
            updateSignedMintValidationParams(c.seaDropImpl, c.disallowedSigners[i], empty);
        }
    }

    function setBaseURI(string calldata uri) public override onlyOwner noPendingMint {
        if (bytes(uri).length == 0 || (totalMinted != 0 && keccak256(bytes(uri)) != keccak256(bytes(baseURI)))) {
            revert ImmutablePolicy();
        }
        baseURI = uri;
        emit BatchMetadataUpdate(1, MAX_SUPPLY);
    }

    function setContractURI(string calldata uri) public override onlyOwner noPendingMint {
        if (bytes(uri).length == 0 || (totalMinted != 0 && keccak256(bytes(uri)) != keccak256(bytes(contractURI)))) {
            revert ImmutablePolicy();
        }
        contractURI = uri;
        emit ContractURIUpdated(uri);
    }

    function setProvenanceHash(bytes32 value) public override onlyOwner noPendingMint {
        if (totalMinted != 0 && value != provenanceHash) revert ProvenanceHashCannotBeSetAfterMintStarted();
        bytes32 old = provenanceHash;
        provenanceHash = value;
        emit ProvenanceHashUpdated(old, value);
    }

    function setMaxSupply(uint256 value) public override onlyOwner {
        if (value != MAX_SUPPLY) revert ImmutablePolicy();
        emit MaxSupplyUpdated(value);
    }

    function setRoyaltyInfo(RoyaltyInfo calldata value) external view override onlyOwner {
        if (value.royaltyAddress != address(houseFees) || value.royaltyBps != ROYALTY_BPS) revert ImmutablePolicy();
    }

    function totalSupply() external view returns (uint256) {
        return totalMinted;
    }

    function maxSupply() external pure override returns (uint256) {
        return MAX_SUPPLY;
    }

    function royaltyAddress() external view override returns (address) {
        return address(houseFees);
    }

    function royaltyBasisPoints() external pure override returns (uint256) {
        return ROYALTY_BPS;
    }

    function royaltyInfo(uint256, uint256 salePrice) external view override returns (address, uint256) {
        return (address(houseFees), Math.mulDiv(salePrice, ROYALTY_BPS, 10_000));
    }

    function supportsInterface(bytes4 id) public view override(ERC721, IERC165) returns (bool) {
        return id == type(INonFungibleSeaDropToken).interfaceId || id == type(ISeaDropTokenContractMetadata).interfaceId
            || id == 0x2a55205a || id == 0x49064906 || super.supportsInterface(id);
    }

    function _baseURI() internal view override returns (string memory) {
        return baseURI;
    }

    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        // Neither safeTransferFrom nor plain transferFrom may place this NFT
        // inside its own account. Also prevent sales during unfunded mint callbacks.
        if (to == accountOf(tokenId) || (_ownerOf(tokenId) != address(0) && _pendingQuantity != 0)) {
            revert MintUnavailable();
        }
        return super._update(to, tokenId, auth);
    }

    function _checkSeaDrop(address seaDropImpl) private pure {
        if (seaDropImpl != address(SEA_DROP)) revert OnlyAllowedSeaDrop();
    }

    function _validDenomination(uint256 v) private pure returns (bool) {
        return v == 1 || v == 2 || v == 5 || v == 10 || v == 20 || v == 50 || v == 100;
    }
}
