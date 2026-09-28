// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {NftContributionBatch} from "../../src/nft/NftContributionBatch.sol";
import {NeutralVault} from "../../src/tokenized/NeutralVault.sol";

contract BatchAsset is ERC20 {
    constructor() ERC20("Test asset", "TEST") {}
    function mint(address to,uint256 amount) external { _mint(to,amount); }
}
contract BatchAllocation {
    bool public settled;
    function setSettled(bool value) external { settled=value; }
}
contract BatchController {
    mapping(uint256=>address) public memberToken;
    constructor(){for(uint256 i=1;i<=100;i++)memberToken[i]=address(new BatchAsset());}
}
/// Unit fixture only; no real venue execution or production receipt issuance.
contract ContributionVaultFixture is ERC20 {
    struct Deposit {uint256 assets;uint256 minimumShares;address receiver;bool listed;}
    BatchAsset public immutable asset;
    BatchController public controller=new BatchController();
    BatchAllocation public allocation=new BatchAllocation();
    mapping(address=>Deposit) public deposits;
    uint256 public pendingAssets;
    uint256 public minimumBatchAssets=2000e6;
    uint256 public epoch=1;
    uint256 public depositorCount;
    bool public entriesOpen=true;
    NeutralVault.Phase public phase;
    constructor(BatchAsset token) ERC20("Fixture receipt","FIXTURE"){asset=token;}
    function enter(uint256 amount,uint256 minimum,address receiver,uint64) external {
        require(entriesOpen&&phase==NeutralVault.Phase.Collecting);
        asset.transferFrom(msg.sender,address(this),amount);
        deposits[msg.sender]=Deposit(amount,minimum,receiver,true);pendingAssets+=amount;depositorCount++;
    }
    function setPhase(NeutralVault.Phase p) external {phase=p;}
    function refund(address account) external {
        require(phase!=NeutralVault.Phase.Allocating&&(msg.sender==account||phase==NeutralVault.Phase.Refundable));
        uint256 amount=deposits[account].assets;require(amount>0);delete deposits[account];pendingAssets-=amount;asset.transfer(account,amount);
    }
    function activate(address account) external {
        Deposit memory d=deposits[account];require(d.assets>0);delete deposits[account];pendingAssets-=d.assets;
        asset.transfer(address(0xbeef),d.assets);_mint(d.receiver,d.assets*9700/10000*1e12);epoch++;
    }
    function cancelAllocation() external {require(phase==NeutralVault.Phase.Allocating&&!allocation.settled());phase=NeutralVault.Phase.Refundable;}
    function memberIds() external pure returns(uint256[] memory ids){ids=new uint256[](100);for(uint256 i;i<100;i++)ids[i]=i+1;}
    function recoverPending(bool asUSDG,uint256,uint64) external returns(address){
        require(!asUSDG&&phase==NeutralVault.Phase.Allocating&&allocation.settled());
        uint256 amount=deposits[msg.sender].assets;require(amount>0);delete deposits[msg.sender];pendingAssets-=amount;asset.transfer(address(0xbeef),amount);
        for(uint256 i=1;i<=100;i++)BatchAsset(controller.memberToken(i)).mint(msg.sender,amount+i);
        return address(0);
    }
}

contract NftContributionBatchTest is Test {
    address constant ALICE=address(0xa11ce);address constant BOB=address(0xb0b);address constant CALLER=address(0xca11);
    BatchAsset asset;ContributionVaultFixture vault;NftContributionBatch batch;
    function setUp() public {
        asset=new BatchAsset();vault=new ContributionVaultFixture(asset);
        batch=new NftContributionBatch(NeutralVault(address(vault)),address(this));
        asset.approve(address(batch),type(uint256).max);
    }
    function credit(uint256 a,uint256 b) private {
        address[] memory accounts=new address[](2);accounts[0]=ALICE;accounts[1]=BOB;
        uint256[] memory amounts=new uint256[](2);amounts[0]=a;amounts[1]=b;
        asset.mint(address(this),a+b);batch.credit(accounts,amounts);
    }
    function testMintContributionsNeedNoExistingReceiptOrPersonalSeed() public {
        credit(1e6,9e6);assertEq(vault.totalSupply(),0);assertEq(asset.balanceOf(address(batch)),10e6);
        assertEq(batch.contributions(ALICE),1e6);assertTrue(batch.collecting());
        vm.expectRevert(NftContributionBatch.Unavailable.selector);batch.queue();
        vm.prank(CALLER);vm.expectRevert(NftContributionBatch.Unavailable.selector);batch.withdraw();
        vm.prank(ALICE);batch.withdraw();assertEq(asset.balanceOf(ALICE),1e6);assertEq(batch.totalContributions(),9e6);
    }
    function testContributionsCannotBeCreatedByAnUnapprovedCaller() public {
        address[] memory accounts=new address[](1);accounts[0]=ALICE;uint256[] memory amounts=new uint256[](1);amounts[0]=1e6;
        vm.prank(CALLER);vm.expectRevert(NftContributionBatch.Unavailable.selector);batch.credit(accounts,amounts);
    }
    function testPooledContributionsUseOneVaultPayerAndActualReceiptClaims() public {
        for(uint256 i;i<10;i++)credit(50e6,150e6);
        batch.queue();assertEq(vault.depositorCount(),1);assertEq(vault.totalSupply(),0);assertEq(asset.allowance(address(batch),address(vault)),0);
        vm.prank(ALICE);vm.expectRevert(NftContributionBatch.Unavailable.selector);batch.withdraw();
        vm.expectRevert(NftContributionBatch.Unavailable.selector);batch.claim(ALICE);
        vault.activate(address(batch));uint256 issued=vault.balanceOf(address(batch));
        vm.prank(CALLER);batch.claim(ALICE);batch.claim(BOB);
        assertEq(vault.balanceOf(ALICE),issued/4);assertEq(vault.balanceOf(BOB),issued-issued/4);assertEq(vault.balanceOf(CALLER),0);
        assertEq(vault.balanceOf(address(batch)),0);assertEq(batch.remainingContributions(),0);
        vm.expectRevert(NftContributionBatch.Unavailable.selector);batch.claim(ALICE);
    }
    function testExternalRefundIsCashNotAClaimOfActivatedShares() public {
        credit(500e6,1500e6);batch.queue();vault.setPhase(NeutralVault.Phase.Refundable);
        vm.prank(CALLER);vault.refund(address(batch));batch.settle();batch.claim(ALICE);batch.claim(BOB);
        assertEq(asset.balanceOf(ALICE),500e6);assertEq(asset.balanceOf(BOB),1500e6);assertEq(vault.totalSupply(),0);
    }
    function testTimeoutRecoveryCancelsUnissuedBatchWithoutAnOwner() public {
        credit(500e6,1500e6);batch.queue();vault.setPhase(NeutralVault.Phase.Allocating);
        vm.expectRevert(NftContributionBatch.Unavailable.selector);batch.recover();vm.warp(block.timestamp+1 days);
        vm.prank(CALLER);batch.recover();batch.claim(ALICE);batch.claim(BOB);
        assertEq(asset.balanceOf(ALICE)+asset.balanceOf(BOB),2000e6);
    }
    function testSettledFailedActivationRecoversAll100MembersInBoundedPages() public {
        credit(500e6,1500e6);batch.queue();vault.setPhase(NeutralVault.Phase.Allocating);vault.allocation().setSettled(true);
        vm.warp(block.timestamp+1 days);batch.recover();assertEq(batch.payoutAssetCount(),102);
        vm.expectRevert(NftContributionBatch.InvalidInput.selector);batch.claimInKind(ALICE,0,21);
        for(uint256 start;start<100;start+=20){batch.claimInKind(ALICE,start,20);vm.prank(CALLER);batch.claimInKind(BOB,start,20);}
        for(uint256 i=1;i<=100;i++){
            IERC20 token=IERC20(vault.controller().memberToken(i));uint256 total=2000e6+i;
            assertEq(token.balanceOf(ALICE),total/4);assertEq(token.balanceOf(BOB),total-total/4);assertEq(token.balanceOf(address(batch)),0);
        }
        vm.expectRevert(NftContributionBatch.Unavailable.selector);batch.claimInKind(ALICE,0,20);
        batch.claim(ALICE);batch.claim(BOB);assertEq(vault.totalSupply(),0);
    }
    function testBatchCanJoinOtherPublicContributionsAtSharedThreshold() public {
        asset.mint(address(this),1000e6);asset.approve(address(vault),1000e6);vault.enter(1000e6,1,address(this),uint64(block.timestamp+600));
        credit(250e6,750e6);batch.queue();assertEq(vault.pendingAssets(),2000e6);assertEq(vault.depositorCount(),2);
    }
    function testFuzzRefundRoundingConservesAllCash(uint64 x,uint64 y,uint32 donation) public {
        uint256 a=bound(uint256(x),1e6,1e12);uint256 b=bound(uint256(y),2000e6,1e12);credit(a,b);batch.queue();
        vault.setPhase(NeutralVault.Phase.Refundable);vault.refund(address(batch));asset.mint(address(batch),donation);
        batch.claim(ALICE);batch.claim(BOB);
        assertEq(asset.balanceOf(ALICE)+asset.balanceOf(BOB),a+b+donation);assertEq(asset.balanceOf(address(batch)),0);
    }
}
