// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {WeightedNftFeeFanout} from "../../src/tokenized/WeightedNftFeeFanout.sol";

contract FanoutTestEdition is ERC721 {
    uint256 public immutable denominationUsd;
    uint256 public immutable MAX_SUPPLY;

    constructor(uint256 denomination, uint256 maximum) ERC721("Test edition", "TEST") {
        denominationUsd = denomination;
        MAX_SUPPLY = maximum;
    }

    function mint(address recipient, uint256 id) external {
        _mint(recipient, id);
    }
}

contract FanoutTestToken is ERC20 {
    address public fanout;
    uint256 public mode;
    bool public reentryBlocked;
    constructor() ERC20("Test fee", "FEE") {}

    function mint(address who, uint256 amount) external {
        _mint(who, amount);
    }

    function burn(address who, uint256 amount) external {
        _burn(who, amount);
    }

    function configure(address target, uint256 mode_) external {
        fanout = target;
        mode = mode_;
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (from == fanout && mode == 1) {
            try WeightedNftFeeFanout(fanout).harvest(address(this)) {
                reentryBlocked = false;
            } catch {
                reentryBlocked = true;
            }
        }
        if (from == fanout && mode == 2 && amount > 0) {
            super._update(from, to, amount - 1);
            super._update(from, address(0), 1);
        } else {
            super._update(from, to, amount);
        }
    }
}

contract WeightedNftFeeFanoutTest is Test {
    WeightedNftFeeFanout fanout;
    FanoutTestEdition[7] editions;
    FanoutTestToken token;
    address constant ALICE = address(0xA11CE);
    address constant BOB = address(0xB0B);

    function setUp() public {
        fanout = new WeightedNftFeeFanout(address(this));
        token = new FanoutTestToken();
        address[7] memory addresses;
        for (uint8 i; i < 7; ++i) {
            editions[i] = new FanoutTestEdition(fanout.weight(i), 10000);
            addresses[i] = address(editions[i]);
        }
        fanout.configure(addresses);
    }

    function _claim(uint8 index, uint256 id, address owner) private {
        uint8[] memory indexes = new uint8[](1);
        uint256[] memory ids = new uint256[](1);
        indexes[0] = index;
        ids[0] = id;
        vm.prank(owner);
        fanout.claim(address(token), indexes, ids);
    }

    function testRegistrationIsOneTimeAndAuthorityIsErased() public {
        assertTrue(fanout.configured());
        assertEq(fanout.initializer(), address(0));
        assertEq(fanout.tokenCount(), 70000);
        assertEq(fanout.totalWeight(), 1880000);
        address[7] memory addresses;
        for (uint8 i; i < 7; ++i) {
            addresses[i] = address(editions[i]);
        }
        vm.expectRevert();
        fanout.configure(addresses);
    }

    function testInvalidRegistrationCannotPartiallyInitialize() public {
        WeightedNftFeeFanout other = new WeightedNftFeeFanout(address(this));
        address[7] memory addresses;
        for (uint8 i; i < 7; ++i) {
            addresses[i] = address(editions[i]);
        }
        vm.prank(ALICE);
        vm.expectRevert();
        other.configure(addresses);
        addresses[6] = address(editions[0]);
        vm.expectRevert();
        other.configure(addresses);
        assertFalse(other.configured());
        assertEq(other.collections(0), address(0));
        addresses[6] = address(new FanoutTestEdition(100, 9999));
        vm.expectRevert();
        other.configure(addresses);
        addresses[6] = address(token);
        vm.expectRevert();
        other.configure(addresses);
        vm.expectRevert();
        other.harvest(address(token));
    }

    function testExactTierWeightsAndUnmintedReserveAreConserved() public {
        token.mint(address(fanout), 1880000);
        fanout.harvest(address(token));
        uint256 total;
        for (uint8 i; i < 7; ++i) {
            editions[i].mint(ALICE, 1);
            uint256 weight = fanout.weight(i);
            assertEq(fanout.claimable(address(token), i, 1), weight);
            _claim(i, 1, ALICE);
            total += weight;
        }
        assertEq(total, 188);
        assertEq(token.balanceOf(ALICE), 188);
        assertEq(token.balanceOf(address(fanout)), 1880000 - 188);
        (uint256 received, uint256 paid, uint256 accounted) = fanout.distributions(address(token));
        assertEq(received, 1880000);
        assertEq(paid, total);
        assertEq(accounted, received - paid);
    }

    function testUnmintedTokenCannotClaimButAcquiresItsPastEntitlementOnMint() public {
        token.mint(address(fanout), 1880000);
        assertEq(fanout.claimable(address(token), 6, 10000), 100);
        vm.expectRevert();
        _claim(6, 10000, ALICE);
        editions[6].mint(ALICE, 10000);
        _claim(6, 10000, ALICE);
        assertEq(token.balanceOf(ALICE), 100);
    }

    function testUnclaimedFeesFollowCurrentNftOwnerWithoutResettingPaidHistory() public {
        editions[6].mint(ALICE, 1);
        token.mint(address(fanout), 1880000);
        _claim(6, 1, ALICE);
        token.mint(address(fanout), 1880000);
        vm.prank(ALICE);
        editions[6].transferFrom(ALICE, BOB, 1);
        vm.expectRevert();
        _claim(6, 1, ALICE);
        _claim(6, 1, BOB);
        assertEq(token.balanceOf(ALICE), 100);
        assertEq(token.balanceOf(BOB), 100);
        _claim(6, 1, BOB);
        assertEq(token.balanceOf(BOB), 100);
    }

    function testSmallHarvestsAccumulateWithoutRoundingLoss() public {
        editions[6].mint(ALICE, 1);
        for (uint256 i; i < 188; ++i) {
            token.mint(address(fanout), 100);
            fanout.harvest(address(token));
            _claim(6, 1, ALICE);
        }
        assertEq(token.balanceOf(ALICE), 1);
        assertEq(fanout.claimed(address(token), 6, 1), 1);
        assertEq(token.balanceOf(address(fanout)), 18799);
    }

    function testBatchBoundsUnknownIdsAndDuplicateIds() public {
        editions[0].mint(ALICE, 1);
        token.mint(address(fanout), 1880000);
        uint8[] memory indexes = new uint8[](51);
        uint256[] memory ids = new uint256[](51);
        vm.expectRevert();
        fanout.claim(address(token), indexes, ids);
        vm.expectRevert();
        _claim(7, 1, ALICE);
        vm.expectRevert();
        _claim(0, 0, ALICE);
        vm.expectRevert();
        _claim(0, 10001, ALICE);
        indexes = new uint8[](2);
        ids = new uint256[](2);
        ids[0] = 1;
        ids[1] = 1;
        vm.prank(ALICE);
        fanout.claim(address(token), indexes, ids);
        assertEq(token.balanceOf(ALICE), 1);
    }

    function testMultipleFeeAssetsHaveIndependentLedgers() public {
        editions[0].mint(ALICE, 1);
        FanoutTestToken second = new FanoutTestToken();
        token.mint(address(fanout), 1880000);
        second.mint(address(fanout), 3760000);
        _claim(0, 1, ALICE);
        assertEq(fanout.claimable(address(second), 0, 1), 2);
        assertEq(fanout.claimed(address(second), 0, 1), 0);
    }

    function testFullFiftyNftBatchAndWrongOwnerRollBackTogether() public {
        uint8[] memory indexes = new uint8[](50);
        uint256[] memory ids = new uint256[](50);
        uint256 expected;
        for (uint256 i; i < 50; ++i) {
            indexes[i] = uint8(i % 7); ids[i] = i / 7 + 1;
            editions[indexes[i]].mint(ALICE, ids[i]); expected += fanout.weight(indexes[i]);
        }
        token.mint(address(fanout), 1880000);
        vm.prank(ALICE); editions[indexes[49]].transferFrom(ALICE, BOB, ids[49]);
        vm.prank(ALICE); vm.expectRevert(); fanout.claim(address(token), indexes, ids);
        assertEq(fanout.claimed(address(token), 0, 1), 0); assertEq(token.balanceOf(ALICE), 0);
        vm.prank(BOB); editions[indexes[49]].transferFrom(BOB, ALICE, ids[49]);
        vm.prank(ALICE); fanout.claim(address(token), indexes, ids);
        assertEq(token.balanceOf(ALICE), expected);
    }

    function testMaximumTokenUnitsUseFullPrecisionWithoutViewOverflow() public {
        editions[6].mint(ALICE, 1);
        token.mint(address(fanout), type(uint256).max);
        fanout.harvest(address(token));
        assertEq(fanout.claimable(address(token), 6, 1), type(uint256).max / 18800);
        _claim(6, 1, ALICE);
        assertEq(token.balanceOf(ALICE), type(uint256).max / 18800);
    }

    function testReentrantTokenCannotHarvestDuringClaim() public {
        editions[6].mint(ALICE, 1);
        token.mint(address(fanout), 1880000);
        token.configure(address(fanout), 1);
        _claim(6, 1, ALICE);
        assertTrue(token.reentryBlocked());
        assertEq(token.balanceOf(ALICE), 100);
    }

    function testDeflationaryPayoutAndNegativeRebaseFailWithoutForgivingDebt() public {
        editions[6].mint(ALICE, 1);
        token.mint(address(fanout), 1880000);
        fanout.harvest(address(token));
        token.configure(address(fanout), 2);
        vm.expectRevert();
        _claim(6, 1, ALICE);
        assertEq(fanout.claimed(address(token), 6, 1), 0);
        assertEq(token.balanceOf(address(fanout)), 1880000);
        token.burn(address(fanout), 1);
        vm.expectRevert();
        fanout.harvest(address(token));
    }

    function testFuzzInterleavedClaimsPreserveAssetConservation(uint128 first, uint128 second) public {
        uint256 a = bound(first, 1, 1e30);
        uint256 b = bound(second, 1, 1e30);
        for (uint8 i; i < 7; ++i) {
            editions[i].mint(ALICE, 1);
        }
        token.mint(address(fanout), a);
        for (uint8 i; i < 7; ++i) {
            _claim(i, 1, ALICE);
        }
        token.mint(address(fanout), b);
        uint256 expected;
        for (uint8 i; i < 7; ++i) {
            _claim(i, 1, ALICE);
            expected += (a + b) * fanout.weight(i) / 1880000;
        }
        assertEq(token.balanceOf(ALICE), expected);
        assertEq(token.balanceOf(address(fanout)) + expected, a + b);
        (uint256 received, uint256 paid, uint256 balance) = fanout.distributions(address(token));
        assertEq(received, a + b);
        assertEq(paid, expected);
        assertEq(balance, received - paid);
    }
}
