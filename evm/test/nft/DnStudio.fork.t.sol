// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DnPendingAdapter} from "../../src/nft/DnPendingAdapter.sol";
import {DnPendingSeaDropEditionV2} from "../../src/nft/DnPendingSeaDropEditionV2.sol";
import {NftContributionBatch} from "../../src/nft/NftContributionBatch.sol";
import {INftSeaDrop, INftHouseFees} from "../../src/nft/NftMintInterfaces.sol";
import {ISeaDropStudio, MultiConfigureStruct} from "../../src/nft/seadrop/ISeaDropStudio.sol";
import {PublicDrop, MintParams, SignedMintValidationParams} from "../../src/nft/seadrop/SeaDropStructs.sol";
import {NeutralVault} from "../../src/tokenized/NeutralVault.sol";

/// Regression pattern from nft-range/test/NguStudio.fork.t.sol: publish against
/// the real SeaDrop, repeat publication, then mint. All transactions are local.
contract DnStudioForkTest is Test {
    NeutralVault constant VAULT = NeutralVault(0x3D4Ee6D147AF67371073e74206D6d49e64960f9c);
    INftSeaDrop constant SEA = INftSeaDrop(0x00005EA00Ac477B1030CE78506496e8C2dE24bf5);
    ISeaDropStudio constant STUDIO = ISeaDropStudio(address(SEA));
    IERC20 constant USDG = IERC20(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);
    IERC20 constant WETH = IERC20(0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73);
    address constant OS = 0x0000a26b00c1F0DF003000390027140000fAa719;
    address constant WIZARDS = 0x1b88A6c6516FD2918905186F21Bb9F5CaA1a15c8;
    address constant ROUTER = 0xBfac70063f04e116F5a509cC746BEeb2F053467D;
    address constant ALICE = address(0xA11CE);
    address constant PAYER = address(0xB0B);
    uint80 constant PRICE = 0.0004 ether;
    uint256 constant SIGNER_KEY = 123456789; // Synthetic local-fork key only.
    DnPendingAdapter adapter;
    DnPendingSeaDropEditionV2 nft;
    uint256 initialPending;
    uint256 initialReceipts;

    function setUp() public {
        vm.createSelectFork(vm.envOr("NFT_STUDIO_FORK_RPC", string("https://rpc.mainnet.chain.robinhood.com")));
        initialPending = VAULT.pendingAssets();
        initialReceipts = VAULT.totalSupply();
        adapter = new DnPendingAdapter(address(this), VAULT, address(VAULT).codehash);
        nft = new DnPendingSeaDropEditionV2("Studio fork", "FORK", 1, address(this), adapter, INftHouseFees(ROUTER));
        nft.configure();
        adapter.setEdition(address(nft), true);
        adapter.setQuote(2000e6, 1 ether, uint48(block.timestamp + 10 minutes));
        adapter.setPaused(false);
        nft.setFundingQuote(2000e6, uint48(block.timestamp + 10 minutes));
        vm.deal(ALICE, 100 ether);
        vm.deal(PAYER, 100 ether);
    }

    function config() internal view returns (MultiConfigureStruct memory c) {
        c.maxSupply = 10000;
        c.baseURI = "https://example.com/metadata/";
        c.contractURI = "https://example.com/collection.json";
        c.provenanceHash = keccak256("fixed artwork");
        c.seaDropImpl = address(SEA);
        c.publicDrop =
            PublicDrop(PRICE, uint48(block.timestamp - 1), uint48(block.timestamp + 1 days), 10000, 1000, true);
        c.dropURI = "https://example.com/drop.json";
        c.creatorPayoutAddress = address(nft);
        c.allowedFeeRecipients = new address[](1);
        c.allowedFeeRecipients[0] = OS; // Already configured: SeaDrop rejects a duplicate add.
        c.allowedPayers = new address[](1);
        c.allowedPayers[0] = PAYER;
        c.signers = new address[](1);
        c.signers[0] = vm.addr(SIGNER_KEY);
        c.signedMintValidationParams = new SignedMintValidationParams[](1);
        c.signedMintValidationParams[0] =
            SignedMintValidationParams(0, 16777215, 0, type(uint40).max, 200000000, 0, 1000);
    }

    function publish() internal {
        nft.multiConfigure(config());
        nft.setPaused(false);
    }

    function publicMint(uint256 qty) internal {
        vm.prank(ALICE);
        SEA.mintPublic{value: uint256(PRICE) * qty}(address(nft), OS, ALICE, qty);
    }

    function mintParams() internal view returns (MintParams memory p) {
        p = MintParams(PRICE, 10000, block.timestamp - 1, block.timestamp + 1 days, 1, 10000, 1000, true);
    }

    function signedMint(MintParams memory p, uint256 salt) internal {
        bytes32 paramsHash = keccak256(
            abi.encode(
                keccak256(
                    "MintParams(uint256 mintPrice,uint256 maxTotalMintableByWallet,uint256 startTime,uint256 endTime,uint256 dropStageIndex,uint256 maxTokenSupplyForStage,uint256 feeBps,bool restrictFeeRecipients)"
                ),
                p
            )
        );
        bytes32 payload = keccak256(
            abi.encode(
                keccak256(
                    "SignedMint(address nftContract,address minter,address feeRecipient,MintParams mintParams,uint256 salt)MintParams(uint256 mintPrice,uint256 maxTotalMintableByWallet,uint256 startTime,uint256 endTime,uint256 dropStageIndex,uint256 maxTokenSupplyForStage,uint256 feeBps,bool restrictFeeRecipients)"
                ),
                address(nft),
                ALICE,
                OS,
                paramsHash,
                salt
            )
        );
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("SeaDrop"),
                keccak256("1.0"),
                block.chainid,
                address(SEA)
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, keccak256(abi.encodePacked("\x19\x01", domain, payload)));
        vm.prank(ALICE);
        STUDIO.mintSigned{value: p.mintPrice}(address(nft), OS, ALICE, 1, p, salt, abi.encodePacked(r, s, v));
    }

    function assertFunding(uint256 qty) internal view {
        NftContributionBatch batch = adapter.currentBatch();
        uint256 sum;
        for (uint256 id = 1; id <= qty; ++id) {
            assertEq(nft.ownerOf(id), ALICE);
            address account = nft.accountOf(id);
            assertEq(adapter.batchOf(account), address(batch));
            assertGt(batch.contributions(account), 0);
            sum += batch.contributions(account);
        }
        assertEq(USDG.balanceOf(address(batch)), sum);
        assertEq(batch.totalContributions(), sum);
        assertEq(nft.totalSupply(), qty);
        assertEq(VAULT.pendingAssets(), initialPending, "existing user deposit untouched");
        assertEq(VAULT.totalSupply(), initialReceipts, "no premature strategy shares");
    }

    function testStudioPublishRepeatAndPublicMintPreserveFunding() public {
        MultiConfigureStruct memory c = config();
        vm.recordLogs();
        nft.multiConfigure(c);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 events;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(nft) && logs[i].topics[0] == keccak256("MaxSupplyUpdated(uint256)")) {
                assertEq(abi.decode(logs[i].data, (uint256)), 10000);
                events++;
            }
        }
        assertEq(events, 1);
        nft.setPaused(false);
        nft.multiConfigure(c); // Repeat while live: no DuplicateFeeRecipient / DuplicatePayer.
        uint256 beforeOs = OS.balance;
        uint256 beforeWizard = WETH.balanceOf(WIZARDS);
        publicMint(2);
        nft.multiConfigure(c); // Identical metadata is repeatable after first mint too.
        assertEq(OS.balance - beforeOs, uint256(PRICE) * 2 / 10);
        assertEq(WETH.balanceOf(WIZARDS) - beforeWizard, uint256(PRICE) * 2 / 100);
        assertEq(STUDIO.getCreatorPayoutAddress(address(nft)), address(nft));
        assertTrue(STUDIO.getPayerIsAllowed(address(nft), PAYER));
        assertFunding(2);
    }

    function testCapturedStudioPayloadFailsV1AndPublishesV2() public {
        bytes memory data = vm.parseJsonBytes(vm.readFile("test/fixtures/studio-publish-2026-09-28.json"), ".data");
        assertEq(bytes4(data), DnPendingSeaDropEditionV2.multiConfigure.selector);
        address oldNft = 0xDa66c3e243D15813E6810c0370823A67b1497672;
        vm.prank(0x26E8134eCC3af5cCE32f34B03E7BD2f318B25158);
        (bool oldOk,) = oldNft.call(data);
        assertFalse(oldOk, "deployed V1 rejects the actual Studio transaction");
        bytes memory args = new bytes(data.length - 4);
        for (uint256 i; i < args.length; ++i) args[i] = data[i + 4];
        MultiConfigureStruct memory c = abi.decode(args, (MultiConfigureStruct));
        assertEq(c.maxSupply, 10000);
        assertEq(c.creatorPayoutAddress, oldNft);
        // Only the collection-specific payout is rebound; no other Studio field changes.
        c.creatorPayoutAddress = address(nft);
        nft.setBaseURI("https://example.com/metadata/");
        nft.setContractURI("https://example.com/collection.json");
        nft.multiConfigure(c);
        nft.multiConfigure(c);
        assertEq(STUDIO.getPublicDrop(address(nft)).mintPrice, c.publicDrop.mintPrice);
        assertTrue(STUDIO.getPayerIsAllowed(address(nft), c.allowedPayers[0]));
        assertEq(STUDIO.getSignedMintValidationParams(address(nft), c.signers[0]).minFeeBps, 1000);
        nft.setPaused(false);
        // This captured window is historical: set time locally inside it and refresh local quotes.
        vm.warp(uint256(c.publicDrop.startTime) + 1);
        adapter.setQuote(2000e6, 1 ether, uint48(block.timestamp + 10 minutes));
        nft.setFundingQuote(2000e6, uint48(block.timestamp + 10 minutes));
        vm.prank(ALICE);
        SEA.mintPublic{value: c.publicDrop.mintPrice}(address(nft), OS, ALICE, 1);
        assertFunding(1);
    }

    function testPreviousVaultPendingDepositCanStillBeRefunded() public {
        address depositor = 0x26E8134eCC3af5cCE32f34B03E7BD2f318B25158;
        (uint256 assets,,,) = VAULT.deposits(depositor);
        assertEq(assets, 3e6, "known pre-migration deposit");
        uint256 beforeBalance = USDG.balanceOf(depositor);
        vm.prank(depositor);
        VAULT.refund(depositor);
        assertEq(USDG.balanceOf(depositor), beforeBalance + assets);
        assertEq(VAULT.pendingAssets(), initialPending - assets);
        assertEq(VAULT.totalSupply(), initialReceipts);
    }

    function testStudioSignerAndPublicMintShareExactPriceFeesAndBatch() public {
        publish();
        SignedMintValidationParams memory v = STUDIO.getSignedMintValidationParams(address(nft), vm.addr(SIGNER_KEY));
        assertEq(v.minFeeBps, 1000);
        assertEq(v.maxFeeBps, 1000);
        uint256 beforeOs = OS.balance;
        uint256 beforeWizard = WETH.balanceOf(WIZARDS);
        publicMint(1);
        signedMint(mintParams(), 1);
        assertFunding(2);
        assertEq(OS.balance - beforeOs, uint256(PRICE) * 2 / 10);
        assertEq(WETH.balanceOf(WIZARDS) - beforeWizard, uint256(PRICE) * 2 / 100);
    }

    function testRepeatedPayerAndSignerRemoval() public {
        publish();
        MultiConfigureStruct memory c;
        c.seaDropImpl = address(SEA);
        c.disallowedPayers = new address[](1);
        c.disallowedPayers[0] = PAYER;
        c.disallowedSigners = new address[](1);
        c.disallowedSigners[0] = vm.addr(SIGNER_KEY);
        nft.multiConfigure(c);
        nft.multiConfigure(c);
        assertFalse(STUDIO.getPayerIsAllowed(address(nft), PAYER));
        assertEq(STUDIO.getSignedMintValidationParams(address(nft), vm.addr(SIGNER_KEY)).maxMaxTotalMintableByWallet, 0);
    }

    function testSignedPriceMismatchRollsBackAllState() public {
        publish();
        MintParams memory p = mintParams();
        p.mintPrice += 100;
        uint256 beforeOs = OS.balance;
        uint256 beforeAlice = ALICE.balance;
        vm.expectRevert();
        signedMint(p, 1);
        assertEq(nft.totalMinted(), 0);
        assertEq(OS.balance, beforeOs);
        assertEq(ALICE.balance, beforeAlice);
        assertEq(address(adapter.currentBatch()), address(0));
    }

    function testSignedMintCannotAlterFeeOrBypassPublicWindow() public {
        publish();
        MintParams memory p = mintParams();
        p.feeBps = 0;
        vm.expectRevert();
        signedMint(p, 1);
        MultiConfigureStruct memory c = config();
        c.publicDrop.startTime = uint48(block.timestamp + 1 hours);
        nft.multiConfigure(c);
        vm.expectRevert();
        signedMint(mintParams(), 2);
        assertEq(nft.totalMinted(), 0);
    }

    function testStudioCannotRedirectPayoutOrChangeSupply() public {
        MultiConfigureStruct memory c = config();
        c.creatorPayoutAddress = ALICE;
        vm.expectRevert();
        nft.multiConfigure(c);
        c = config();
        c.maxSupply = 20000;
        vm.expectRevert();
        nft.multiConfigure(c);
    }

    function testStudioRejectsUnsupportedStagesAndMalformedSignerArrays() public {
        MultiConfigureStruct memory c = config();
        c.allowListData.merkleRoot = keccak256("unsupported stage");
        vm.expectRevert();
        nft.multiConfigure(c);
        c = config();
        c.signers = new address[](0);
        vm.expectRevert();
        nft.multiConfigure(c);
    }

    function testNonOwnerCannotPublishAndStaleQuoteStillClosesMints() public {
        MultiConfigureStruct memory c = config();
        vm.prank(ALICE);
        vm.expectRevert();
        nft.multiConfigure(c);
        publish();
        vm.warp(block.timestamp + 11 minutes);
        vm.expectRevert();
        publicMint(1);
        assertEq(nft.totalMinted(), 0);
    }
}
