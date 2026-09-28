// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LighterSeriesAccount, ILighterL1} from "../../src/tokenized/LighterSeriesAccount.sol";
import {HouseFeeRouter, IFeeFanout} from "../../src/tokenized/HouseFeeRouter.sol";

interface ILighterQueue is ILighterL1 {
    function openPriorityRequestCount() external view returns (uint64);
}

contract TokenizedRobinhoodIntegrationTest is Test {
    IERC20 constant USDG = IERC20(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);
    ILighterQueue constant LIGHTER = ILighterQueue(0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d);
    address constant FAN = 0x1b88A6c6516FD2918905186F21Bb9F5CaA1a15c8;

    function setUp() public {
        vm.createSelectFork("robinhood");
    }

    function testLighterContractOwnedDepositBindsItsOwnAccountAndQueuesOrders() public {
        // Only fork-local balances change. This does not prove a matching-engine fill.
        LighterSeriesAccount custody = new LighterSeriesAccount(USDG, LIGHTER, 0, address(this));
        vm.prank(address(LIGHTER));
        USDG.transfer(address(this), 10e6);
        USDG.approve(address(custody), 10e6);
        uint64 beforeQueue = LIGHTER.openPriorityRequestCount();
        custody.deposit(10e6);
        assertEq(LIGHTER.openPriorityRequestCount(), beforeQueue + 1);
        uint48 index = LIGHTER.addressToAccountIndex(address(custody));
        assertGt(index, 2);
        vm.expectRevert();
        custody.bind(index + 1);
        custody.bind(index);
        assertEq(custody.accountIndex(), index);
        custody.order(50, 250000, false);
        assertEq(LIGHTER.openPriorityRequestCount(), beforeQueue + 2);
        custody.cancelOrders();
        assertEq(LIGHTER.openPriorityRequestCount(), beforeQueue + 3);
    }

    function testReal8010FanoutReceivesAndHarvestsHouseFeesOnFork() public {
        HouseFeeRouter router = new HouseFeeRouter();
        assertEq(IFeeFanout(FAN).tokenCount(), 8010);
        vm.prank(address(LIGHTER));
        USDG.transfer(address(this), 2e6);
        uint256 beforeBalance = USDG.balanceOf(FAN);
        USDG.approve(address(router), 2e6);
        router.pay(USDG, 2e6);
        assertEq(USDG.balanceOf(FAN) - beforeBalance, 2e6);
        router.harvest(address(USDG));
    }
}
