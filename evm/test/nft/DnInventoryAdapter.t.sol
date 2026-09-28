// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DnInventoryAdapter} from "../../src/nft/DnInventoryAdapter.sol";
import {DnSeaDropEdition} from "../../src/nft/DnSeaDropEdition.sol";
import {INftSeaDrop, INftHouseFees} from "../../src/nft/NftMintInterfaces.sol";
import {PublicDrop} from "../../src/nft/seadrop/SeaDropStructs.sol";
import {NeutralVault} from "../../src/tokenized/NeutralVault.sol";

/// All swaps and mints are LOCAL fork transactions. NAV is mocked only in funded
/// cases because production has no activated receipts; this does not prove fills.
contract DnInventoryAdapterForkTest is Test {
    NeutralVault constant VAULT = NeutralVault(0xe9AE3aEb63680960995978ee6c33E68B57c00688);
    IERC20 constant USDG = IERC20(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);
    IERC20 constant WETH = IERC20(0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73);
    INftSeaDrop constant SEA = INftSeaDrop(0x00005EA00Ac477B1030CE78506496e8C2dE24bf5);
    address constant OS = 0x0000a26b00c1F0DF003000390027140000fAa719;
    address constant WIZARDS = 0x1b88A6c6516FD2918905186F21Bb9F5CaA1a15c8;
    address constant ROUTER = 0xBfac70063f04e116F5a509cC746BEeb2F053467D;
    address constant ALICE = address(0xA11CE);
    DnInventoryAdapter adapter;
    DnSeaDropEdition nft;
    uint80 constant PRICE = 0.0004 ether;

    function setUp() public {
        vm.createSelectFork("robinhood");
        adapter = new DnInventoryAdapter(address(this), VAULT, address(VAULT).codehash);
        nft = new DnSeaDropEdition("Money Doubler $1", "DLP1", 1, address(this), adapter, INftHouseFees(ROUTER));
        nft.configure();
        nft.setBaseURI("https://example.com/metadata/");
        nft.setContractURI("https://example.com/collection.json");
        nft.updatePublicDrop(
            address(SEA),
            PublicDrop(PRICE, uint48(block.timestamp - 1), uint48(block.timestamp + 1 days), 10000, 1000, true)
        );
        adapter.setEdition(address(nft), true);
        adapter.setQuote(2000e6, 2e18, 1 ether, uint48(block.timestamp + 10 minutes));
        adapter.setPaused(false);
        vm.deal(ALICE, 10 ether);
    }

    function _inventory() private {
        // Receipt transfer implementation and dependencies are real. Seed and NAV
        // are synthetic, explicitly separate from the unseeded readiness test.
        deal(address(VAULT), address(adapter), 1000 ether, true);
        vm.mockCall(address(VAULT), abi.encodeCall(VAULT.portfolio, ()), abi.encode(2000e6, int256(0), 50000e6));
        nft.setExecutionQuote(900e18, uint48(block.timestamp + 10 minutes));
        nft.setPaused(false);
    }

    function _mint(uint256 count) private {
        vm.prank(ALICE);
        SEA.mintPublic{value: uint256(PRICE) * count}(address(nft), OS, ALICE, count);
    }

    function testProductionZeroSupplyCannotEnableMints() public {
        assertEq(VAULT.totalSupply(), 0);
        assertFalse(adapter.ready());
        vm.expectRevert();
        nft.setPaused(false);
        vm.expectRevert();
        _mint(1);
    }

    function testConstructorPinsReceiptCodeAndReadsItsActualEntryFee() public {
        assertEq(adapter.ENTRY_BPS(), 200);
        vm.expectRevert();
        this.deployAdapter(bytes32(0));
        vm.mockCall(address(VAULT.controller()), abi.encodeWithSignature("ENTRY_FEE_BPS()"), abi.encode(uint256(300)));
        DnInventoryAdapter revised = new DnInventoryAdapter(address(this), VAULT, address(VAULT).codehash);
        assertEq(revised.ENTRY_BPS(), 300);
        assertEq(revised.receiptToken(), address(VAULT));
        assertFalse(revised.ready());
        // This verifies configuration handling, not a new live fee deployment.
        vm.mockCall(address(VAULT.controller()), abi.encodeWithSignature("ENTRY_FEE_BPS()"), abi.encode(uint256(10001)));
        vm.expectRevert();
        this.deployAdapter(address(VAULT).codehash);
    }

    function deployAdapter(bytes32 codeHash) external returns (DnInventoryAdapter) {
        return new DnInventoryAdapter(address(this), VAULT, codeHash);
    }

    function testRealNativePoolSwapFundsRealReceiptTransfersThroughSeaDrop() public {
        _inventory();
        uint256 osBefore = OS.balance;
        uint256 wizardBefore = WETH.balanceOf(WIZARDS);
        _mint(3);
        uint256 output = USDG.balanceOf(address(adapter));
        assertGt(output, 0);
        uint256 totalShares = output * 9800 / 10000 * 1000 ether / 2000e6;
        uint256 delivered;
        for (uint256 id = 1; id <= 3; ++id) {
            uint256 balance = VAULT.balanceOf(nft.accountOf(id));
            assertGt(balance, 0);
            delivered += balance;
            assertEq(nft.ownerOf(id), ALICE);
        }
        assertApproxEqAbs(delivered, totalShares, 3);
        assertEq(VAULT.balanceOf(address(adapter)) + delivered, 1000 ether);
        assertEq(OS.balance - osBefore, 3 * uint256(PRICE) / 10);
        // 1% now. Entry reserve is paid by later replenishment, not a transfer tax.
        assertEq(WETH.balanceOf(WIZARDS) - wizardBefore, 3 * uint256(PRICE) / 100);
        assertEq(address(adapter).balance, 0);
        assertEq(USDG.allowance(address(adapter), address(VAULT)), 0);
    }

    function testSlippageFailureRollsBackSwapMintAndFees() public {
        _inventory();
        adapter.setQuote(1000000e6, 2e18, 1 ether, uint48(block.timestamp + 1 minutes));
        uint256 beforeEth = ALICE.balance;
        uint256 beforeOs = OS.balance;
        uint256 beforeWizard = WETH.balanceOf(WIZARDS);
        vm.expectRevert();
        _mint(2);
        assertEq(ALICE.balance, beforeEth);
        assertEq(OS.balance, beforeOs);
        assertEq(WETH.balanceOf(WIZARDS), beforeWizard);
        assertEq(nft.totalMinted(), 0);
        assertEq(USDG.balanceOf(address(adapter)), 0);
        assertEq(VAULT.balanceOf(address(adapter)), 1000 ether);
    }

    function testInsufficientInventoryDoesNotIssuePendingReceipts() public {
        _inventory();
        deal(address(VAULT), address(adapter), 1, false);
        vm.expectRevert();
        _mint(1);
        assertEq(nft.totalMinted(), 0);
        assertEq(USDG.balanceOf(address(adapter)), 0);
    }

    function testReceiptMinimumRollsBackAllBatchMembers() public {
        _inventory();
        nft.setExecutionQuote(1000000e18, uint48(block.timestamp + 1 minutes));
        vm.expectRevert();
        _mint(3);
        assertEq(nft.totalMinted(), 0);
        assertEq(VAULT.balanceOf(nft.accountOf(1)), 0);
        assertEq(USDG.balanceOf(address(adapter)), 0);
    }

    function testExpiredQuoteUnmatchedDeltaAndStaleNavDisableReadiness() public {
        _inventory();
        assertTrue(adapter.ready());
        vm.mockCall(address(VAULT), abi.encodeCall(VAULT.portfolio, ()), abi.encode(2000e6, int256(11e6), 50000e6));
        assertFalse(adapter.ready());
        vm.mockCallRevert(
            address(VAULT), abi.encodeCall(VAULT.portfolio, ()), abi.encodeWithSignature("Error(string)", "Stale")
        );
        assertFalse(adapter.ready());
        vm.clearMockedCalls();
        vm.warp(vm.getBlockTimestamp() + 16 minutes);
        assertFalse(adapter.ready());
    }

    function testAggregateNativeCapAndQuoteNavCap() public {
        _inventory();
        adapter.setQuote(2000e6, 2e18, uint256(PRICE) * 89 / 100, uint48(block.timestamp + 1 minutes));
        _mint(1);
        assertEq(adapter.remainingNative(), 0);
        assertFalse(adapter.ready());
        vm.expectRevert();
        _mint(1);
        adapter.setQuote(2000e6, 1, 1 ether, uint48(block.timestamp + 1 minutes));
        vm.expectRevert();
        _mint(1);
    }

    function testUnauthorizedCallerCannotAccessInventoryOrCallback() public {
        _inventory();
        address[] memory a = new address[](1);
        uint256[] memory b = new uint256[](1);
        a[0] = ALICE;
        b[0] = 1;
        vm.prank(ALICE);
        vm.expectRevert();
        adapter.depositNative{value: 1}(a, b, b);
        vm.expectRevert();
        adapter.unlockCallback(abi.encode(uint256(1)));
        vm.prank(ALICE);
        vm.expectRevert();
        adapter.replenish(1, 1, uint64(block.timestamp + 1 days));
    }

    function testClosedProductionVaultRejectsReplenishmentWithoutLosingCash() public {
        _inventory();
        _mint(1);
        uint256 cash = USDG.balanceOf(address(adapter));
        assertFalse(VAULT.entriesOpen());
        vm.expectRevert();
        adapter.replenish(cash, 1, uint64(block.timestamp + 1 days));
        assertEq(USDG.balanceOf(address(adapter)), cash);
        assertEq(USDG.allowance(address(adapter), address(VAULT)), 0);
    }

    function testChangedDependencyCodeClosesAdapter() public {
        _inventory();
        vm.etch(adapter.SWAP_HOOK(), hex"00");
        assertFalse(adapter.ready());
    }

    function testReplenishmentUsesOnePayerReceiverAndRefundReturnsOnlyToReserve() public {
        _inventory();
        _mint(3);
        uint256 cash = USDG.balanceOf(address(adapter));
        vm.prank(VAULT.controller().keeper());
        VAULT.setEntriesOpen(true);
        uint256 first = cash / 2;
        adapter.replenish(first, 1, uint64(block.timestamp + 1 days));
        adapter.replenish(cash - first, 1, uint64(block.timestamp + 1 days));
        (uint256 assets, uint256 minimum, address receiver, bool listed) = VAULT.deposits(address(adapter));
        assertEq(assets, cash);
        assertEq(minimum, 2);
        assertEq(receiver, address(adapter));
        assertTrue(listed);
        assertEq(USDG.balanceOf(address(adapter)), 0);
        assertEq(USDG.allowance(address(adapter), address(VAULT)), 0);
        uint256 beforeSupply = VAULT.totalSupply();
        adapter.lowerPendingMinimum(1);
        adapter.refundPending();
        assertEq(USDG.balanceOf(address(adapter)), cash);
        assertEq(VAULT.totalSupply(), beforeSupply);
        (assets,,,) = VAULT.deposits(address(adapter));
        assertEq(assets, 0);
    }
}
