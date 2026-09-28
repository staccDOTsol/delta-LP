// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DnPendingAdapter} from "../../src/nft/DnPendingAdapter.sol";
import {DnPendingSeaDropEdition} from "../../src/nft/DnPendingSeaDropEdition.sol";
import {NftContributionBatch} from "../../src/nft/NftContributionBatch.sol";
import {INftSeaDrop, INftHouseFees} from "../../src/nft/NftMintInterfaces.sol";
import {PublicDrop} from "../../src/nft/seadrop/SeaDropStructs.sol";
import {NeutralVault} from "../../src/tokenized/NeutralVault.sol";

interface IPendingTokenbound {
    function owner() external view returns (address);
    function execute(address to, uint256 value, bytes calldata data, uint8 operation) external payable returns (bytes memory);
}

/// Real SeaDrop, ERC6551, swap pool and USDG on a LOCAL fork. This demonstrates
/// mint-funded pending cash with zero DN supply; no venue trade or funded live
/// strategy is asserted. Batch activation/recovery uses separate escrow tests.
contract DnPendingAdapterForkTest is Test {
    NeutralVault constant VAULT = NeutralVault(0x385d37788a63a205df8044cf7cF6a59CC740159A);
    IERC20 constant USDG = IERC20(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);
    IERC20 constant WETH = IERC20(0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73);
    INftSeaDrop constant SEA = INftSeaDrop(0x00005EA00Ac477B1030CE78506496e8C2dE24bf5);
    address constant OS = 0x0000a26b00c1F0DF003000390027140000fAa719;
    address constant WIZARDS = 0x1b88A6c6516FD2918905186F21Bb9F5CaA1a15c8;
    address constant ROUTER = 0xBfac70063f04e116F5a509cC746BEeb2F053467D;
    address constant ALICE = address(0xA11CE);
    address constant BOB = address(0xB0B);
    uint80 constant PRICE = 0.0004 ether;
    DnPendingAdapter adapter;
    DnPendingSeaDropEdition nft;

    function setUp() public {
        vm.createSelectFork("robinhood");
        adapter = new DnPendingAdapter(address(this), VAULT, address(VAULT).codehash);
        nft = _edition(1);
        adapter.setQuote(2000e6, 1 ether, uint48(block.timestamp + 10 minutes));
        adapter.setPaused(false);
        nft.setPaused(false);
        vm.deal(ALICE, 100 ether);
    }

    function _edition(uint256 denomination) private returns (DnPendingSeaDropEdition e) {
        e = new DnPendingSeaDropEdition("Pending cash NFT", "PENDING", denomination, address(this), adapter, INftHouseFees(ROUTER));
        e.configure();
        e.setBaseURI("https://example.com/metadata/");
        e.setContractURI("https://example.com/collection.json");
        e.updatePublicDrop(address(SEA), PublicDrop(PRICE, uint48(block.timestamp - 1), uint48(block.timestamp + 1 days), 10000, 1000, true));
        e.setFundingQuote(2000e6, uint48(block.timestamp + 10 minutes));
        adapter.setEdition(address(e), true);
    }

    function _mint(DnPendingSeaDropEdition edition, uint256 count) private {
        vm.prank(ALICE);
        SEA.mintPublic{value: uint256(PRICE) * count}(address(edition), OS, ALICE, count);
    }

    function testFirstMintWorksWithZeroDnSupplyAndNoSeed() public {
        assertEq(VAULT.totalSupply(), 0);
        assertTrue(adapter.ready());
        uint256 osBefore = OS.balance;
        uint256 wizardsBefore = WETH.balanceOf(WIZARDS);
        _mint(nft, 3);
        NftContributionBatch batch = adapter.currentBatch();
        uint256 credited;
        for (uint256 id = 1; id <= 3; ++id) {
            address account = nft.accountOf(id);
            assertEq(nft.ownerOf(id), ALICE);
            assertEq(IPendingTokenbound(account).owner(), ALICE);
            assertEq(adapter.batchOf(account), address(batch));
            uint256 cash = batch.contributions(account);
            assertGe(cash, uint256(PRICE) * 89 / 100 * 2000e6 / 1 ether);
            assertEq(adapter.contributedAssets(account), cash);
            credited += cash;
            assertEq(VAULT.balanceOf(account), 0);
        }
        assertEq(USDG.balanceOf(address(batch)), credited);
        assertEq(batch.totalContributions(), credited);
        assertEq(USDG.balanceOf(address(adapter)), 0);
        assertEq(address(adapter).balance, 0);
        assertEq(USDG.allowance(address(adapter), address(batch)), 0);
        assertEq(OS.balance - osBefore, 3 * uint256(PRICE) / 10);
        assertEq(WETH.balanceOf(WIZARDS) - wizardsBefore, 3 * uint256(PRICE) / 100);
        assertEq(VAULT.totalSupply(), 0);
    }

    function testDifferentEditionsPoolCashWithoutSeedInventory() public {
        DnPendingSeaDropEdition two = _edition(2);
        two.setPaused(false);
        _mint(nft, 1);
        _mint(two, 1);
        address first = nft.accountOf(1);
        address second = two.accountOf(1);
        NftContributionBatch batch = adapter.currentBatch();
        assertEq(adapter.batchOf(first), adapter.batchOf(second));
        assertEq(batch.totalContributions(), batch.contributions(first) + batch.contributions(second));
        assertEq(USDG.balanceOf(address(batch)), batch.totalContributions());
        assertEq(VAULT.totalSupply(), 0);
    }

    function testPendingWithdrawalFollowsNftOwnerAndReturnsOnlyItsCash() public {
        _mint(nft, 2);
        address account = nft.accountOf(1);
        address second = nft.accountOf(2);
        NftContributionBatch batch = adapter.currentBatch();
        uint256 amount = batch.contributions(account);
        uint256 secondAmount = batch.contributions(second);
        vm.prank(ALICE);
        nft.transferFrom(ALICE, BOB, 1);
        bytes memory callData = abi.encodeWithSignature("withdraw()");
        vm.expectRevert();
        vm.prank(ALICE);
        IPendingTokenbound(account).execute(address(batch), 0, callData, 0);
        vm.prank(BOB);
        IPendingTokenbound(account).execute(address(batch), 0, callData, 0);
        assertEq(USDG.balanceOf(account), amount);
        assertEq(USDG.balanceOf(BOB), 0);
        assertEq(batch.contributions(account), 0);
        assertEq(batch.contributions(second), secondAmount);
        assertEq(USDG.balanceOf(address(batch)), secondAmount);
        assertEq(nft.ownerOf(1), BOB);
        assertEq(VAULT.totalSupply(), 0);
    }

    function testBelowBatchThresholdCannotInventShares() public {
        _mint(nft, 1);
        NftContributionBatch batch = adapter.currentBatch();
        vm.expectRevert();
        batch.queue();
        assertEq(VAULT.totalSupply(), 0);
        assertGt(adapter.contributedAssets(nft.accountOf(1)), 0);
    }

    function testNextMintUsesNewEscrowAfterPriorBatchQueues() public {
        _mint(nft, 1);
        NftContributionBatch first = adapter.currentBatch();
        uint256 original = first.contributions(nft.accountOf(1));
        // Local transition fixture only: the actual batch lifecycle is tested
        // separately. No venue fill or receipt is manufactured in this test.
        vm.mockCall(address(VAULT), abi.encodeWithSignature("entriesOpen()"), abi.encode(true));
        vm.mockCall(address(VAULT), abi.encodeWithSignature("minimumBatchAssets()"), abi.encode(uint256(1)));
        vm.mockCall(address(VAULT), abi.encodeWithSelector(VAULT.enter.selector), bytes(""));
        first.queue();
        _mint(nft, 1);
        NftContributionBatch second = adapter.currentBatch();
        assertTrue(address(second) != address(first));
        assertEq(adapter.batchOf(nft.accountOf(1)), address(first));
        assertEq(adapter.batchOf(nft.accountOf(2)), address(second));
        assertEq(first.contributions(nft.accountOf(1)), original);
        assertEq(first.contributions(nft.accountOf(2)), 0);
        assertEq(second.contributions(nft.accountOf(1)), 0);
        assertGt(second.contributions(nft.accountOf(2)), 0);
        assertEq(VAULT.totalSupply(), 0);
    }

    function testSwapFailureRollsBackNftBothFeesAndContribution() public {
        adapter.setQuote(1000000e6, 1 ether, uint48(block.timestamp + 10 minutes));
        uint256 aliceBefore = ALICE.balance;
        uint256 osBefore = OS.balance;
        uint256 wizardsBefore = WETH.balanceOf(WIZARDS);
        vm.expectRevert();
        _mint(nft, 2);
        assertEq(nft.totalMinted(), 0);
        assertEq(nft.accountOf(1).code.length, 0);
        assertEq(ALICE.balance, aliceBefore);
        assertEq(OS.balance, osBefore);
        assertEq(WETH.balanceOf(WIZARDS), wizardsBefore);
        assertEq(adapter.batchOf(nft.accountOf(1)), address(0));
        assertEq(address(adapter.currentBatch()), address(0));
        assertEq(adapter.remainingNative(), 1 ether);
    }

    function testPerNftCashMinimumRollsBackAllContributions() public {
        nft.setFundingQuote(1000000e6, uint48(block.timestamp + 10 minutes));
        vm.expectRevert();
        _mint(nft, 3);
        assertEq(nft.totalMinted(), 0);
        assertEq(adapter.batchOf(nft.accountOf(1)), address(0));
        assertEq(address(adapter.currentBatch()), address(0));
    }

    function testExpiredQuotesDisableMintWithoutPretendingCashIsInvested() public {
        vm.warp(block.timestamp + 11 minutes);
        assertFalse(adapter.ready());
        vm.expectRevert();
        _mint(nft, 1);
    }

    function testFiniteNativeBudgetLimitsTotalSales() public {
        uint256 contribution = uint256(PRICE) * 89 / 100;
        adapter.setQuote(2000e6, contribution, uint48(block.timestamp + 10 minutes));
        _mint(nft, 1);
        assertEq(adapter.remainingNative(), 0);
        assertFalse(adapter.ready());
        vm.expectRevert();
        _mint(nft, 1);
        assertEq(nft.totalMinted(), 1);
    }

    function testFullTwentyMintConservesAllUsdUnits() public {
        _mint(nft, 20);
        NftContributionBatch batch = adapter.currentBatch();
        uint256 sum;
        for (uint256 id = 1; id <= 20; ++id) sum += batch.contributions(nft.accountOf(id));
        assertEq(sum, batch.totalContributions());
        assertEq(sum, USDG.balanceOf(address(batch)));
        assertEq(nft.totalMinted(), 20);
    }

    function testRevokedEditionCannotTakeContributions() public {
        adapter.setEdition(address(nft), false);
        vm.expectRevert();
        _mint(nft, 1);
        assertEq(nft.totalMinted(), 0);
    }

    function testDependenciesCannotChangeUnderPendingSales() public {
        vm.etch(address(VAULT), hex"00");
        assertFalse(adapter.ready());
        vm.expectRevert();
        _mint(nft, 1);
    }

    function testCallbackAndWrongCodeHashRejected() public {
        vm.expectRevert();
        adapter.unlockCallback(abi.encode(uint256(1)));
        vm.expectRevert();
        this.deployAdapter(bytes32(0));
    }

    function deployAdapter(bytes32 expectedHash) external returns (DnPendingAdapter) {
        return new DnPendingAdapter(address(this), VAULT, expectedHash);
    }
}
