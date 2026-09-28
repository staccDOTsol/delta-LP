// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IFeeFanout, IWrappedEther} from "./HouseFeeRouter.sol";

interface IWeightedNftFeeFanout {
    function configured() external view returns (bool);
    function tokenCount() external view returns (uint256);
    function totalWeight() external view returns (uint256);
    function harvest(address token) external;
}

/// Replacement house-fee router. NFT primary fees/royalties may still use the
/// separate legacy Wizards-only router; this router handles deltaLP house fees.
contract SplitHouseFeeRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;
    address public constant FANOUT = 0x1b88A6c6516FD2918905186F21Bb9F5CaA1a15c8;
    address public constant HOMECOMING = 0x7c165Ae6E7BFD939Fee1ACA99Ca5aeDf85c52dD4;
    IWrappedEther public constant WETH = IWrappedEther(0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73);
    IWeightedNftFeeFanout public immutable nftFanout;
    mapping(address => bool) public oddCarry;
    event HouseFeeSplit(address indexed source, address indexed token, uint256 wizards, uint256 nfts);

    constructor(IWeightedNftFeeFanout recipient) {
        require(block.chainid == 4663, "Robinhood only");
        require(IFeeFanout(FANOUT).tokenCount() == 8010 && IFeeFanout(FANOUT).collection() == HOMECOMING,
            "Wizards identity mismatch");
        require(address(WETH).code.length != 0 && address(recipient).code.length != 0, "Missing dependency");
        require(recipient.tokenCount() == 70_000 && recipient.totalWeight() == 1_880_000, "NFT weights mismatch");
        nftFanout = recipient;
    }

    function pay(IERC20 token, uint256 amount) external nonReentrant {
        require(amount != 0, "Zero fee");
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        require(token.balanceOf(address(this)) - beforeBalance == amount, "Unsupported transfer tax");
        _split(msg.sender, token, amount);
    }

    function payNative() external payable nonReentrant { _native(msg.sender, msg.value); }
    receive() external payable nonReentrant { _native(msg.sender, msg.value); }
    function _native(address source, uint256 amount) private {
        require(amount != 0, "Zero fee");
        uint256 beforeBalance = WETH.balanceOf(address(this));
        WETH.deposit{value: amount}();
        require(WETH.balanceOf(address(this)) - beforeBalance == amount, "WETH amount mismatch");
        _split(source, IERC20(address(WETH)), amount);
    }

    function flush(IERC20 token) external nonReentrant {
        uint256 amount = token.balanceOf(address(this));
        if (amount != 0) _split(address(this), token, amount);
    }

    function _split(address source, IERC20 token, uint256 amount) private {
        require(nftFanout.configured(), "NFT collections not configured");
        uint256 wizards = amount / 2;
        if (amount % 2 != 0) {
            if (oddCarry[address(token)]) ++wizards;
            oddCarry[address(token)] = !oddCarry[address(token)];
        }
        _send(token, FANOUT, wizards);
        _send(token, address(nftFanout), amount - wizards);
        emit HouseFeeSplit(source, address(token), wizards, amount - wizards);
    }

    function _send(IERC20 token, address to, uint256 amount) private {
        if (amount == 0) return;
        uint256 beforeBalance = token.balanceOf(to);
        token.safeTransfer(to, amount);
        require(token.balanceOf(to) - beforeBalance == amount, "Unsupported transfer tax");
    }

    function harvest(address token) external {
        IFeeFanout(FANOUT).harvest(token);
        nftFanout.harvest(token);
    }
}
