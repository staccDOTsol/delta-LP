// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MemberController} from "../../src/tokenized/MemberController.sol";
import {MemberToken} from "../../src/tokenized/MemberToken.sol";
import {LighterSeriesAccount, ILighterL1} from "../../src/tokenized/LighterSeriesAccount.sol";

contract TestUSDG is ERC20 {
    constructor() ERC20("Test USDG", "USDG") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockLighterL1 is ILighterL1 {
    IERC20 public asset;
    mapping(address => uint256) public deposits;
    mapping(address => uint128) public pending;
    mapping(address => uint48) public addressToAccountIndex;

    function assign(address owner, uint48 index) external {
        addressToAccountIndex[owner] = index;
    }
    uint256 public orderCount;
    uint48 public lastSize;
    uint32 public lastPrice;
    uint8 public lastAsk;
    address public lastOwner;

    constructor(IERC20 a) {
        asset = a;
    }

    function deposit(address to, uint16 index, uint8 route, uint256 amount) external payable {
        require(to == msg.sender && index == 3 && route == 0);
        asset.transferFrom(msg.sender, address(this), amount);
        deposits[to] += amount;
    }

    function createOrder(uint48, uint16 market, uint48 size, uint32 price, uint8 ask, uint8 kind) external {
        require(market == 0 && kind == 0);
        ++orderCount;
        lastSize = size;
        lastPrice = price;
        lastAsk = ask;
        lastOwner = msg.sender;
    }
    function cancelAllOrders(uint48) external {}

    function withdraw(uint48, uint16 index, uint8 route, uint64 amount) external {
        require(index == 3 && route == 0);
        pending[msg.sender] += amount;
    }

    function withdrawPendingBalance(address owner, uint16, uint128 amount) external {
        require(pending[owner] >= amount);
        pending[owner] -= amount;
        asset.transfer(owner, amount);
    }

    function getPendingBalance(address owner, uint16) external view returns (uint128) {
        return pending[owner];
    }
}

contract MemberControllerTest is Test {
    TestUSDG asset;
    MockLighterL1 venue;
    MemberController controller;
    bytes32 constant ETH = keccak256("ETH");
    address alice = address(0xa11ce);
    address bob = address(0xb0b);
    address pool = address(0xbeef);
    uint256 long3;
    uint256 short3;

    function setUp() public {
        vm.warp(10_000);
        vm.chainId(4663);
        address fanout = 0x1b88A6c6516FD2918905186F21Bb9F5CaA1a15c8;
        vm.mockCall(fanout, abi.encodeWithSignature("tokenCount()"), abi.encode(uint256(8010)));
        vm.mockCall(
            fanout,
            abi.encodeWithSignature("collection()"),
            abi.encode(address(0x7c165Ae6E7BFD939Fee1ACA99Ca5aeDf85c52dD4))
        );
        asset = new TestUSDG();
        venue = new MockLighterL1(asset);
        controller = new MemberController(asset, venue, address(this), address(this), address(this));
        long3 = _member(3, false);
        short3 = _member(3, true);
        asset.mint(alice, 1_000e6);
        vm.prank(alice);
        asset.approve(address(controller), type(uint256).max);
    }

    function _member(uint8 leverage, bool short) internal returns (uint256 id) {
        id = controller.createMember(ETH, 0, leverage, short, 4, 2, "Test member", "MEM");
        controller.setEnabled(id, true);
        venue.assign(address(controller.memberState(id).custody), uint48(1000 + id));
        controller.bindAccount(id, uint48(1000 + id));
        _report(id, 0, 0);
    }

    function _report(uint256 id, int256 venueEquity, int256 position) internal {
        MemberController.Member memory m = controller.memberState(id);
        controller.reconcile(
            id,
            MemberController.Report(
                m.reportSequence + 1,
                m.requestedAction,
                uint64(block.timestamp),
                venueEquity,
                position,
                2_500e6,
                venueEquity > 0 ? uint256(venueEquity) : 0,
                true,
                keccak256("test evidence only")
            )
        );
    }

    function _deposit(uint256 id, uint256 assets) internal returns (MemberToken token) {
        uint256 gross = assets * 10_000 / 9_800;
        vm.prank(alice);
        uint256 request = controller.requestDeposit(id, gross, 1, alice, uint64(block.timestamp + 600));
        _report(id, 0, 0);
        controller.settleRequest(request);
        token = MemberToken(controller.memberToken(id));
    }

    function testTransfersIncludingAMMsTriggerTheWholeUnderlyingGroup() public {
        MemberToken token = _deposit(long3, 100e6);
        assertEq(controller.groupRequested(ETH), 1); // mint
        vm.prank(alice);
        token.transfer(pool, 10e18);
        vm.prank(pool);
        token.transfer(bob, 5e18);
        vm.prank(bob);
        token.approve(alice, 1e18);
        vm.prank(alice);
        token.transferFrom(bob, pool, 1e18);
        assertEq(controller.groupRequested(ETH), 4);
        assertEq(venue.orderCount(), 0, "transfers cannot pretend the venue has filled");
        uint256[] memory ids = token.counterparties();
        assertEq(ids.length, 1);
        assertEq(ids[0], short3);
        assertEq(controller.memberState(long3).nav, 100e6);
    }

    function testUnauthorizedHooksMintBurnAndCustodyCallsFail() public {
        MemberToken token = _deposit(long3, 10e6);
        vm.expectRevert();
        vm.prank(alice);
        token.mint(alice, 1e18);
        vm.expectRevert();
        vm.prank(alice);
        token.burn(alice, 1e18);
        vm.expectRevert();
        vm.prank(alice);
        controller.onMemberTransfer(long3, alice, bob, 1);
        LighterSeriesAccount custody = controller.memberState(long3).custody;
        vm.expectRevert();
        vm.prank(alice);
        custody.withdraw(1e6);
    }

    function testNeutralAllocationCoversEveryEnabledMatchedTierAndConservesUSDG() public {
        _member(5, false);
        _member(5, true);
        _member(10, false);
        _member(10, true);
        _member(4, false); // unmatched: cannot form a neutral pair
        uint256[] memory minima = new uint256[](6);
        for (uint256 i; i < 6; ++i) {
            minima[i] = 1;
        }
        uint256 balance = asset.balanceOf(alice);
        vm.prank(alice);
        (uint256 first, uint256 count, uint256 allocated) =
            controller.requestNeutral(ETH, 60e6 + 5, minima, alice, uint64(block.timestamp + 600));
        assertEq(first, 1);
        assertEq(count, 6);
        assertEq(allocated, 60e6);
        assertEq(balance - asset.balanceOf(alice), allocated);
        assertEq(controller.escrowAssets(), allocated);
        for (uint256 id = first; id < first + count; ++id) {
            (,,, uint256 amount,,,,,) = controller.requests(id);
            assertEq(amount, 10e6);
            controller.settleRequest(id);
        }
        assertEq(controller.escrowAssets(), 0);
        for (uint256 id = 1; id <= 6; ++id) {
            assertEq(MemberToken(controller.memberToken(id)).balanceOf(alice), 9.8e18);
        }
        assertEq(asset.balanceOf(controller.FEE_FANOUT()), 1.2e6);
    }

    function testPendingDepositsAreNotNAVOrTradingCashAndCanBeCancelled() public {
        _deposit(long3, 10e6);
        vm.prank(alice);
        uint256 request = controller.requestDeposit(long3, 50e6, 1, alice, uint64(block.timestamp + 600));
        assertEq(controller.memberState(long3).nav, 10e6);
        vm.expectRevert();
        controller.fundVenue(long3, 11e6);
        vm.prank(alice);
        controller.cancelRequest(request);
        assertEq(controller.escrowAssets(), 0);
        assertEq(asset.balanceOf(address(controller)), 10e6);
    }

    function testVenueDepositLocksPricingUntilReconciledAndDoesNotDoubleCountNAV() public {
        _deposit(long3, 100e6);
        controller.fundVenue(long3, 80e6);
        MemberController.Member memory m = controller.memberState(long3);
        assertEq(m.cash, 20e6);
        assertEq(venue.deposits(address(m.custody)), 80e6);
        vm.expectRevert();
        controller.target(long3);
        _report(long3, 80e6, 0);
        assertEq(controller.memberState(long3).nav, 100e6);
        (int256 desired, int256 delta, bool needed) = controller.target(long3);
        assertEq(desired, 1200);
        assertEq(delta, 1200);
        assertTrue(needed);
    }

    function testRebalanceHasBoundedPriceAndDoesNotTreatSubmissionAsFill() public {
        _deposit(short3, 100e6);
        controller.fundVenue(short3, 100e6);
        _report(short3, 100e6, 0);
        vm.expectRevert();
        controller.rebalance(short3, 240_000);
        controller.rebalance(short3, 250_000);
        assertEq(venue.lastSize(), 1200);
        assertEq(venue.lastAsk(), 1);
        assertEq(venue.orderCount(), 1);
        assertEq(controller.memberState(short3).position, 0);
        vm.expectRevert();
        controller.rebalance(short3, 250_000);
        _report(short3, 100e6, -600); // actual partial fill, remainder cancelled
        (, int256 remainder, bool needed) = controller.target(short3);
        assertEq(remainder, -600);
        assertTrue(needed);
        controller.rebalance(short3, 250_000);
        assertEq(venue.lastSize(), 600);
    }

    function testRedeemNeverSpendsAnotherSeriesOrPendingDeposits() public {
        MemberToken token = _deposit(long3, 100e6);
        _deposit(short3, 100e6);
        controller.fundVenue(long3, 100e6);
        _report(long3, 100e6, 0);
        vm.startPrank(alice);
        token.approve(address(controller), 10e18);
        uint256 r = controller.requestRedeem(long3, 10e18, 9.6e6, alice, uint64(block.timestamp + 600));
        vm.stopPrank();
        vm.expectRevert();
        controller.settleRequest(r);
        controller.requestVenueWithdrawal(long3, 10e6);
        controller.collectVenueWithdrawal(long3);
        vm.expectRevert();
        controller.settleRequest(r);
        _report(long3, 90e6, 0);
        controller.settleRequest(r);
        assertEq(controller.memberState(long3).nav, 90e6);
        assertEq(controller.memberState(short3).cash, 100e6);
        assertEq(token.totalSupply(), 90e18);
    }

    function testStaleOrUnsettledReportCannotPriceShares() public {
        _deposit(long3, 10e6);
        vm.warp(block.timestamp + 61);
        vm.expectRevert();
        controller.target(long3);
        MemberController.Member memory m = controller.memberState(long3);
        MemberController.Report memory r = MemberController.Report(
            m.reportSequence + 1,
            m.requestedAction,
            uint64(block.timestamp),
            0,
            0,
            2_500e6,
            0,
            false,
            keccak256("evidence")
        );
        vm.expectRevert();
        controller.reconcile(long3, r);
        r.ordersAndTransfersSettled = true;
        r.action = 55;
        vm.expectRevert();
        controller.reconcile(long3, r);
    }

    function testLossShrinksNAVAndTargetInsteadOfPretendingRebalancePreventsLoss() public {
        _deposit(long3, 100e6);
        controller.fundVenue(long3, 100e6);
        _report(long3, 100e6, 1200);
        _report(long3, 50e6, 1200);
        (int256 desired, int256 delta, bool needed) = controller.target(long3);
        assertEq(desired, 600);
        assertEq(delta, -600);
        assertTrue(needed);
        _report(long3, -1e6, 1200);
        (desired, delta, needed) = controller.target(long3);
        assertEq(desired, 0);
        assertEq(delta, -1200);
        assertTrue(needed);
    }

    function testDonationCannotMintUnbackedSharesOrBecomeAnotherMembersCash() public {
        asset.mint(address(controller), 500e6);
        _deposit(long3, 10e6);
        assertEq(controller.memberState(long3).nav, 10e6);
        assertEq(controller.memberState(short3).nav, 0);
        assertEq(MemberToken(controller.memberToken(long3)).totalSupply(), 10e18);
    }

    function testEntryAndExitFeesUseNetQuotesAndAllHouseRevenueGoesToWizards() public {
        vm.prank(alice);
        uint256 r = controller.requestDeposit(long3, 100e6, 98e18, alice, uint64(block.timestamp + 600));
        controller.settleRequest(r);
        MemberToken token = MemberToken(controller.memberToken(long3));
        assertEq(token.totalSupply(), 98e18);
        assertEq(controller.memberState(long3).nav, 98e6);
        assertEq(asset.balanceOf(controller.FEE_FANOUT()), 2e6);
        vm.startPrank(alice);
        token.approve(address(controller), 98e18);
        uint256 exit = controller.requestRedeem(long3, 98e18, 94.08e6, alice, uint64(block.timestamp + 600));
        vm.stopPrank();
        uint256 beforeBalance = asset.balanceOf(alice);
        controller.settleRequest(exit);
        assertEq(asset.balanceOf(alice) - beforeBalance, 94.08e6);
        assertEq(asset.balanceOf(controller.FEE_FANOUT()), 5.92e6);
        assertEq(controller.memberState(long3).nav, 0);
        assertEq(token.totalSupply(), 0);
        assertEq(asset.balanceOf(address(controller)), 0);
    }

    function testFeeSlippageFailureAndCancellationChargeNothing() public {
        vm.prank(alice);
        uint256 r = controller.requestDeposit(long3, 100e6, 100e18, alice, uint64(block.timestamp + 600));
        vm.expectRevert();
        controller.settleRequest(r);
        vm.prank(alice);
        controller.cancelRequest(r);
        assertEq(asset.balanceOf(alice), 1_000e6);
        assertEq(asset.balanceOf(controller.FEE_FANOUT()), 0);
    }

    function testFuzzTransfersConserveClaimsAndOnlyIncrementGroupSequence(uint96 raw) public {
        MemberToken token = _deposit(long3, 100e6);
        uint256 amount = bound(raw, 0, 100e18);
        uint64 beforeSeq = controller.groupRequested(ETH);
        vm.prank(alice);
        token.transfer(bob, amount);
        assertEq(token.totalSupply(), 100e18);
        assertEq(token.balanceOf(alice) + token.balanceOf(bob), 100e18);
        assertEq(controller.groupRequested(ETH), beforeSeq + 1);
        assertEq(controller.memberState(long3).nav, 100e6);
    }
}
