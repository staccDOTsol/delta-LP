// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {HouseFeeRouter} from "../../src/tokenized/HouseFeeRouter.sol";

contract MockFeeToken is ERC20 {
    constructor() ERC20("Fee", "FEE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }
}

contract MockWizardFanout {
    function tokenCount() external pure returns (uint256) {
        return 8010;
    }

    function collection() external pure returns (address) {
        return 0x7c165Ae6E7BFD939Fee1ACA99Ca5aeDf85c52dD4;
    }
    function harvest(address) external {}
}

contract HouseFeeRouterTest is Test {
    address constant FAN = 0x1b88A6c6516FD2918905186F21Bb9F5CaA1a15c8;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant LEGACY = 0x04C9229Fba6AFDC6ac9eD4312acb4BC74f1a436e;
    HouseFeeRouter router;
    MockFeeToken usdg;

    function setUp() public {
        vm.chainId(4663);
        vm.etch(FAN, address(new MockWizardFanout()).code);
        vm.etch(WETH, address(new MockFeeToken()).code);
        router = new HouseFeeRouter();
        usdg = new MockFeeToken();
    }

    function testAllDesignatedHouseFeesReachThe8010Fanout() public {
        usdg.mint(address(this), 5e6);
        usdg.approve(address(router), 5e6);
        router.pay(usdg, 5e6);
        assertEq(usdg.balanceOf(FAN), 5e6);
        assertEq(usdg.balanceOf(address(router)), 0);
        assertEq(usdg.balanceOf(LEGACY), 0);
    }

    function testNativeFeesAreWrappedBeforeFanoutPayment() public {
        vm.deal(address(this), 1 ether);
        router.payNative{value: 0.01 ether}();
        assertEq(IERC20(WETH).balanceOf(FAN), 0.01 ether);
        assertEq(FAN.balance, 0);
        assertEq(address(router).balance, 0);
    }

    function testFlushCannotBeRedirectedByItsCaller() public {
        usdg.mint(address(router), 100);
        vm.prank(address(0xbad));
        router.flush(usdg);
        assertEq(usdg.balanceOf(FAN), 100);
        assertEq(usdg.balanceOf(address(0xbad)), 0);
    }

    function testCallerCannotSpendAnotherPayersApproval() public {
        usdg.mint(address(this), 5e6);
        usdg.approve(address(router), 5e6);
        vm.expectRevert();
        vm.prank(address(0xbad));
        router.pay(usdg, 5e6);
        assertEq(usdg.balanceOf(address(this)), 5e6);
    }

    function testDeploymentRejectsOtherChainsAndWrongFanout() public {
        vm.chainId(1);
        vm.expectRevert();
        new HouseFeeRouter();
        vm.chainId(4663);
        vm.mockCall(FAN, abi.encodeWithSignature("tokenCount()"), abi.encode(uint256(10000)));
        vm.expectRevert();
        new HouseFeeRouter();
    }
}
