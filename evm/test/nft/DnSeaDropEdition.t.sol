// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdStorage, stdStorage} from "forge-std/StdStorage.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {DnSeaDropEdition} from "../../src/nft/DnSeaDropEdition.sol";
import {IDnMintAdapter} from "../../src/nft/IDnMintAdapter.sol";
import {INftSeaDrop, INftHouseFees} from "../../src/nft/NftMintInterfaces.sol";
import {PublicDrop, AllowListData} from "../../src/nft/seadrop/SeaDropStructs.sol";
import {HouseFeeRouter} from "../../src/tokenized/HouseFeeRouter.sol";

interface ITestTokenbound {
    function owner() external view returns (address);
    function token() external view returns (uint256, address, uint256);
    function isValidSigner(address, bytes calldata) external view returns (bytes4);
    function execute(address to, uint256 value, bytes calldata data, uint8 operation)
        external
        payable
        returns (bytes memory);
}

// TEST DOUBLE ONLY. This models ownership and a 2% entry fee; it does not trade,
// rebalance, or prove that an actual delta-neutral receipt exists in production.
contract TestDnAdapter is ERC20, IDnMintAdapter {
    bool public override ready = true;
    uint256 public mode;
    HouseFeeRouter public immutable router;

    constructor(HouseFeeRouter router_) ERC20("TEST ONLY DN", "TESTDN") {
        router = router_;
    }

    function receiptToken() external view returns (address) {
        return address(this);
    }

    function setMode(uint256 value) external {
        mode = value;
    }

    function setReady(bool value) external {
        ready = value;
    }

    function depositNative(address[] calldata receivers, uint256[] calldata assets, uint256[] calldata minimums)
        external
        payable
    {
        require(ready, "Not ready");
        require(mode != 1, "Execution failed");
        uint256 sum;
        uint256 fees;
        for (uint256 i; i < receivers.length; ++i) {
            sum += assets[i];
            uint256 fee = assets[i] * 200 / 10_000;
            fees += fee;
            uint256 shares = assets[i] - fee;
            require(shares >= minimums[i], "Slippage");
            if (mode == 2 && i == receivers.length - 1) shares = 1;
            _mint(receivers[i], shares);
        }
        require(sum == msg.value, "Wrong value");
        if (fees != 0) router.payNative{value: fees}();
    }
}

contract MintCallbackProbe is IERC721Receiver {
    DnSeaDropEdition immutable nft;
    bool public transferBlocked;

    constructor(DnSeaDropEdition nft_) {
        nft = nft_;
    }

    function onERC721Received(address, address, uint256 id, bytes calldata) external returns (bytes4) {
        try nft.transferFrom(address(this), address(0xC0FFEE), id) {
            transferBlocked = false;
        } catch {
            transferBlocked = true;
        }
        return IERC721Receiver.onERC721Received.selector;
    }
}

/// All value movement occurs on a local fork, never on mainnet.
contract DnSeaDropEditionForkTest is Test {
    using stdStorage for StdStorage;
    INftSeaDrop constant SEA = INftSeaDrop(0x00005EA00Ac477B1030CE78506496e8C2dE24bf5);
    address constant OS = 0x0000a26b00c1F0DF003000390027140000fAa719;
    address constant WIZARDS = 0x1b88A6c6516FD2918905186F21Bb9F5CaA1a15c8;
    IERC20 constant WETH = IERC20(0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73);
    address constant ALICE = address(0xA11CE);
    address constant BOB = address(0xB0B);
    uint80 constant PRICE = 0.001 ether;
    DnSeaDropEdition nft;
    HouseFeeRouter router;
    TestDnAdapter adapter;
    uint256 wizardBefore;
    uint256 osBefore;

    function setUp() public {
        vm.createSelectFork("robinhood");
        router = new HouseFeeRouter();
        adapter = new TestDnAdapter(router);
        nft = new DnSeaDropEdition("Delta $1", "DLP1", 1, address(this), adapter, INftHouseFees(address(router)));
        nft.configure();
        nft.setBaseURI("ipfs://example/1/");
        nft.setContractURI("ipfs://example/collection");
        nft.updatePublicDrop(address(SEA), _drop(PRICE));
        nft.setExecutionQuote(0.98 ether, uint48(block.timestamp + 10 minutes));
        nft.setPaused(false);
        wizardBefore = WETH.balanceOf(WIZARDS);
        osBefore = OS.balance;
        vm.deal(ALICE, 100 ether);
    }

    function _drop(uint80 price) private view returns (PublicDrop memory) {
        return PublicDrop(price, uint48(block.timestamp - 1), uint48(block.timestamp + 1 days), 10_000, 1000, true);
    }

    function _mint(uint256 count) private {
        vm.prank(ALICE);
        SEA.mintPublic{value: uint256(PRICE) * count}(address(nft), OS, ALICE, count);
    }

    function testRealSeaDropMintPaysTenOneEightyNineAndFundsDistinctAccounts() public {
        _mint(3);
        assertEq(nft.totalMinted(), 3);
        assertEq(nft.mintedBy(ALICE), 3);
        assertEq(OS.balance - osBefore, 3 * PRICE / 10);
        assertEq(WETH.balanceOf(WIZARDS) - wizardBefore, 3 * uint256(PRICE) * 278 / 10_000);
        for (uint256 id = 1; id <= 3; ++id) {
            address account = nft.accountOf(id);
            assertEq(nft.ownerOf(id), ALICE);
            assertEq(ITestTokenbound(account).owner(), ALICE);
            (uint256 chain, address collection, uint256 tokenId) = ITestTokenbound(account).token();
            assertEq(chain, 4663);
            assertEq(collection, address(nft));
            assertEq(tokenId, id);
            assertEq(adapter.balanceOf(account), uint256(PRICE) * 8722 / 10_000);
        }
        assertTrue(nft.accountOf(1) != nft.accountOf(2));
        assertEq(adapter.balanceOf(ALICE), 0);
        assertEq(address(nft).balance, 0);
        assertEq(address(router).balance, 0);
    }

    function testNftTransferMovesAuthorityOverTheSameDnAssets() public {
        _mint(1);
        address account = nft.accountOf(1);
        uint256 shares = adapter.balanceOf(account);
        vm.prank(ALICE);
        nft.transferFrom(ALICE, BOB, 1);
        assertEq(ITestTokenbound(account).owner(), BOB);
        assertEq(ITestTokenbound(account).isValidSigner(ALICE, ""), bytes4(0));
        assertEq(ITestTokenbound(account).isValidSigner(BOB, ""), bytes4(0x523e3260));
        bytes memory callData = abi.encodeCall(IERC20.transfer, (BOB, shares));
        vm.expectRevert();
        vm.prank(ALICE);
        ITestTokenbound(account).execute(address(adapter), 0, callData, 0);
        vm.prank(BOB);
        ITestTokenbound(account).execute(address(adapter), 0, callData, 0);
        assertEq(adapter.balanceOf(BOB), shares);
        assertEq(adapter.balanceOf(account), 0);
    }

    function testAdapterFailureRollsBackMintAccountsAndBothFeePayments() public {
        adapter.setMode(1);
        address account = nft.accountOf(1);
        uint256 aliceBefore = ALICE.balance;
        vm.expectRevert();
        _mint(1);
        assertEq(nft.totalMinted(), 0);
        assertEq(nft.mintedBy(ALICE), 0);
        assertEq(account.code.length, 0);
        assertEq(ALICE.balance, aliceBefore);
        assertEq(OS.balance, osBefore);
        assertEq(WETH.balanceOf(WIZARDS), wizardBefore);
    }

    function testReceiptBalanceChecksRejectPartialFundingOfABatch() public {
        adapter.setMode(2);
        vm.expectRevert();
        _mint(3);
        assertEq(nft.totalMinted(), 0);
        assertEq(adapter.totalSupply(), 0);
        assertEq(OS.balance, osBefore);
        assertEq(WETH.balanceOf(WIZARDS), wizardBefore);
    }

    function testClosedOrStaleOrUnavailableRouteCannotMint() public {
        nft.setPaused(true);
        vm.expectRevert();
        _mint(1);
        nft.setPaused(false);
        adapter.setReady(false);
        vm.expectRevert();
        _mint(1);
        adapter.setReady(true);
        vm.warp(block.timestamp + 11 minutes);
        vm.expectRevert();
        _mint(1);
        assertEq(nft.totalMinted(), 0);
    }

    function testNeitherOwnerNorMintBuyerCanRedirectTheFixedFeePolicy() public {
        vm.expectRevert();
        nft.updateCreatorPayoutAddress(address(SEA), BOB);
        vm.expectRevert();
        nft.updateAllowedFeeRecipient(address(SEA), BOB, true);
        vm.expectRevert();
        nft.setMaxSupply(20_000);
        nft.setPaused(true);
        PublicDrop memory drop = _drop(PRICE);
        drop.feeBps = 0;
        vm.expectRevert();
        nft.updatePublicDrop(address(SEA), drop);
        drop.feeBps = 1000;
        drop.restrictFeeRecipients = false;
        vm.expectRevert();
        nft.updatePublicDrop(address(SEA), drop);
        vm.expectRevert();
        vm.prank(ALICE);
        SEA.mintPublic{value: PRICE}(address(nft), BOB, ALICE, 1);
    }

    function testRoyaltyIsTenPercentToRouterAndNativeRoyaltyReachesWizards() public {
        (address recipient, uint256 amount) = nft.royaltyInfo(1, 2 ether);
        assertEq(recipient, address(router));
        assertEq(amount, 0.2 ether);
        vm.deal(BOB, 1 ether);
        vm.prank(BOB);
        (bool ok,) = recipient.call{value: amount}("");
        assertTrue(ok);
        assertEq(WETH.balanceOf(WIZARDS) - wizardBefore, amount);
    }

    function testCannotTransferNftIntoItsOwnAccountEvenWithoutSafeTransfer() public {
        _mint(1);
        address account = nft.accountOf(1);
        vm.expectRevert();
        vm.prank(ALICE);
        nft.transferFrom(ALICE, account, 1);
        assertEq(nft.ownerOf(1), ALICE);
    }

    function testNftCannotBeSoldDuringItsUnfundedReceiverCallback() public {
        MintCallbackProbe probe = new MintCallbackProbe(nft);
        nft.updatePayer(address(SEA), ALICE, true);
        vm.prank(ALICE);
        SEA.mintPublic{value: PRICE}(address(nft), OS, address(probe), 1);
        assertTrue(probe.transferBlocked());
        assertEq(nft.ownerOf(1), address(probe));
        assertGt(adapter.balanceOf(nft.accountOf(1)), 0);
    }

    function testUnsupportedStagesAndNonSeaDropMintsFail() public {
        AllowListData memory allowList;
        vm.expectRevert();
        nft.updateAllowList(address(SEA), allowList);
        vm.expectRevert();
        nft.mintSeaDrop(ALICE, 1);
        vm.expectRevert();
        _mint(21);
    }

    function testMaximumSupplyCannotBeExceeded() public {
        // Arrange near the boundary without 10,000 account deployments.
        stdstore.target(address(nft)).sig("totalMinted()").checked_write(9999);
        vm.expectRevert();
        _mint(2);
        _mint(1);
        assertEq(nft.totalMinted(), 10_000);
        vm.expectRevert();
        _mint(1);
    }

    function testMetadataFreezesOnFirstMint() public {
        _mint(1);
        assertEq(nft.tokenURI(1), "ipfs://example/1/1");
        vm.expectRevert();
        nft.setBaseURI("ipfs://replacement/");
        vm.expectRevert();
        nft.setContractURI("ipfs://replacement");
        vm.expectRevert();
        nft.setProvenanceHash(bytes32(uint256(1)));
        assertTrue(nft.supportsInterface(0x1890fe8e));
        assertTrue(nft.supportsInterface(0x2a55205a));
    }

    function testFuzzRoundingConservesEveryWei(uint80 priceSeed, uint8 countSeed) public {
        uint80 price = uint80(bound(priceSeed, 1000, 0.1 ether));
        uint256 count = bound(countSeed, 1, 20);
        nft.setPaused(true);
        nft.updatePublicDrop(address(SEA), _drop(price));
        nft.setPaused(false);
        uint256 gross = uint256(price) * count;
        vm.prank(ALICE);
        SEA.mintPublic{value: gross}(address(nft), OS, ALICE, count);
        uint256 shares;
        for (uint256 i = 1; i <= count; ++i) {
            shares += adapter.balanceOf(nft.accountOf(i));
        }
        assertEq(shares + OS.balance - osBefore + WETH.balanceOf(WIZARDS) - wizardBefore, gross);
        assertEq(address(nft).balance, 0);
    }
}
