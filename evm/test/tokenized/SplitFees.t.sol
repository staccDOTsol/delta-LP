// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SplitHouseFeeRouter, IWeightedNftFeeFanout} from "../../src/tokenized/SplitHouseFeeRouter.sol";
import {SplitFeeMemberController} from "../../src/tokenized/SplitFeeMemberController.sol";
import {MemberController} from "../../src/tokenized/MemberController.sol";
import {MemberToken} from "../../src/tokenized/MemberToken.sol";
import {NeutralExit} from "../../src/tokenized/NeutralEscrows.sol";
import {TestUSDG, MockLighterL1} from "./MemberController.t.sol";
import {MockFeeToken, MockWizardFanout} from "./HouseFeeRouter.t.sol";
import {WeightedNftFeeFanout} from "../../src/tokenized/WeightedNftFeeFanout.sol";
import {FanoutTestEdition} from "./WeightedNftFeeFanout.t.sol";

contract WeightedFanoutStub {
    bool public configured = true;
    function tokenCount() external pure returns (uint256) { return 70_000; }
    function totalWeight() external pure returns (uint256) { return 1_880_000; }
    function harvest(address) external {}
    function setConfigured(bool value) external { configured = value; }
}

contract SplitFeesTest is Test {
    address constant WIZARDS = 0x1b88A6c6516FD2918905186F21Bb9F5CaA1a15c8;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant ALICE = address(0xa11ce);
    TestUSDG asset;
    MockLighterL1 venue;
    SplitHouseFeeRouter router;
    WeightedFanoutStub nfts;
    SplitFeeMemberController controller;
    uint256 member;

    function setUp() public {
        vm.chainId(4663);vm.warp(10_000);
        vm.etch(WIZARDS,address(new MockWizardFanout()).code);
        vm.etch(WETH,address(new MockFeeToken()).code);
        nfts = new WeightedFanoutStub();
        router = new SplitHouseFeeRouter(IWeightedNftFeeFanout(address(nfts)));
        asset = new TestUSDG();venue = new MockLighterL1(asset);
        controller = new SplitFeeMemberController(asset,venue,address(this),address(this),address(this),router);
        member = controller.createMember(keccak256("ETH"),0,3,false,4,2,"Long","LONG");
        controller.setEnabled(member,true);
        _report();
        asset.mint(ALICE,100e6);
        vm.prank(ALICE);asset.approve(address(controller),type(uint256).max);
    }

    function _report() private {
        MemberController.Member memory m=controller.memberState(member);
        controller.reconcile(member,MemberController.Report(m.reportSequence+1,m.requestedAction,uint64(block.timestamp),
            0,0,2500e6,0,true,keccak256("test only"),200));
    }
    function _request() private returns(uint256 request) {
        vm.prank(ALICE);request=controller.requestDeposit(member,100e6,1,ALICE,uint64(block.timestamp+60));
        _report();
    }

    function testMintTransferRedeemChargesThreeSixAndSplitsBothHalves() public {
        assertEq(controller.ENTRY_FEE_BPS(),300);assertEq(controller.EXIT_FEE_BPS(),600);
        controller.settleRequest(_request());
        MemberToken token=MemberToken(controller.memberToken(member));
        assertEq(token.balanceOf(ALICE),97e18);assertEq(asset.balanceOf(address(controller)),97e6);
        assertEq(asset.balanceOf(WIZARDS),1.5e6);assertEq(asset.balanceOf(address(nfts)),1.5e6);
        vm.prank(ALICE);token.transfer(address(0xbeef),1e18);
        vm.prank(address(0xbeef));token.transfer(ALICE,1e18);
        assertEq(asset.balanceOf(WIZARDS),1.5e6);assertEq(asset.balanceOf(address(nfts)),1.5e6);
        vm.startPrank(ALICE);token.approve(address(controller),97e18);
        uint256 request=controller.requestRedeem(member,97e18,91.18e6,ALICE,uint64(block.timestamp+60));vm.stopPrank();
        _report();controller.settleRequest(request);
        assertEq(asset.balanceOf(ALICE),91.18e6);
        assertEq(asset.balanceOf(WIZARDS),4.41e6);assertEq(asset.balanceOf(address(nfts)),4.41e6);
        assertEq(asset.balanceOf(address(controller)),0);assertEq(asset.balanceOf(address(router)),0);
        assertEq(asset.allowance(address(controller),address(router)),0);
        assertEq(token.totalSupply(),0);
    }

    function testUnconfiguredCollectionsCannotReceiveHouseFeesOrPartiallySettle() public {
        uint256 request=_request();nfts.setConfigured(false);
        vm.expectRevert("NFT collections not configured");controller.settleRequest(request);
        assertEq(asset.balanceOf(address(controller)),100e6);assertEq(controller.escrowAssets(),100e6);
        assertEq(asset.balanceOf(WIZARDS),0);assertEq(asset.balanceOf(address(nfts)),0);
        assertEq(IERC20(controller.memberToken(member)).totalSupply(),0);
    }

    function testIdleCashExitUsesSixPercentSplitExactlyOnce() public {
        uint256[] memory ids=new uint256[](0);
        NeutralExit escrow=new NeutralExit(controller,address(this),ALICE,ALICE,94e6,ids);
        asset.mint(address(escrow),100e6);escrow.start(uint64(block.timestamp+60));
        assertEq(asset.balanceOf(WIZARDS),3e6);assertEq(asset.balanceOf(address(nfts)),3e6);
        escrow.finish();assertEq(asset.balanceOf(ALICE),194e6);
        vm.expectRevert();escrow.finish();
        assertEq(asset.balanceOf(WIZARDS),3e6);assertEq(asset.balanceOf(address(nfts)),3e6);
    }

    function testFeeRoutingCannotDebitPrincipalOrAnotherPayersApproval() public {
        controller.settleRequest(_request());
        vm.expectRevert();vm.prank(address(0xbad));controller.payHouseFee(1e6);
        assertEq(asset.balanceOf(address(controller)),97e6);
        asset.mint(address(this),2e6);asset.approve(address(controller),2e6);controller.payHouseFee(2e6);
        assertEq(asset.balanceOf(address(controller)),97e6);assertEq(asset.balanceOf(WIZARDS),2.5e6);
    }

    function testNativeFeesAndPermissionlessFlushCannotRedirect() public {
        vm.deal(address(this),1 ether);router.payNative{value:0.1 ether}();
        assertEq(IERC20(WETH).balanceOf(WIZARDS),0.05 ether);
        assertEq(IERC20(WETH).balanceOf(address(nfts)),0.05 ether);
        asset.mint(address(router),10);vm.prank(address(0xbad));router.flush(asset);
        assertEq(asset.balanceOf(WIZARDS),5);assertEq(asset.balanceOf(address(nfts)),5);
        assertEq(asset.balanceOf(address(0xbad)),0);
    }

    function testFuzzOddFeeCarryIsCumulativeAndConservesEveryUnit(uint128 a,uint128 b) public {
        uint256 first=uint256(a)+1;uint256 second=uint256(b)+1;uint256 total=first+second;
        asset.mint(address(this),total);asset.approve(address(router),total);
        router.pay(asset,first);router.pay(asset,second);
        assertEq(asset.balanceOf(WIZARDS),total/2);
        assertEq(asset.balanceOf(address(nfts)),total-total/2);
        assertEq(asset.balanceOf(address(router)),0);
    }

    function testActualSevenCollectionDistributorReceivesAndPaysBothFeeLegs() public {
        WeightedNftFeeFanout recipient=new WeightedNftFeeFanout(address(this));
        address[7] memory editions;
        for(uint8 i;i<7;++i){
            FanoutTestEdition edition=new FanoutTestEdition(recipient.weight(i),10_000);
            editions[i]=address(edition);edition.mint(ALICE,1);
        }
        router=new SplitHouseFeeRouter(IWeightedNftFeeFanout(address(recipient)));
        controller=new SplitFeeMemberController(asset,venue,address(this),address(this),address(this),router);
        assertFalse(controller.feesReady());recipient.configure(editions);assertTrue(controller.feesReady());
        member=controller.createMember(keccak256("ETH"),0,3,false,4,2,"Long","LONG");
        controller.setEnabled(member,true);_report();
        vm.prank(ALICE);asset.approve(address(controller),100e6);
        controller.settleRequest(_request());
        MemberToken token=MemberToken(controller.memberToken(member));
        vm.startPrank(ALICE);token.approve(address(controller),97e18);
        uint256 request=controller.requestRedeem(member,97e18,1,ALICE,uint64(block.timestamp+60));vm.stopPrank();
        _report();controller.settleRequest(request);
        router.harvest(address(asset));
        uint8[] memory indexes=new uint8[](7);uint256[] memory ids=new uint256[](7);uint256 expected;
        for(uint8 i;i<7;++i){indexes[i]=i;ids[i]=1;expected+=4_410000*recipient.weight(i)/1_880_000;}
        vm.prank(ALICE);recipient.claim(address(asset),indexes,ids);
        assertEq(asset.balanceOf(WIZARDS),4.41e6);
        assertEq(asset.balanceOf(ALICE),91.18e6+expected);
        assertEq(asset.balanceOf(address(recipient)),4.41e6-expected);
        assertEq(asset.balanceOf(WIZARDS)+asset.balanceOf(ALICE)+asset.balanceOf(address(recipient)),100e6);
    }
}
