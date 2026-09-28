// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IFeeFanout {
    function tokenCount() external view returns (uint256);
    function collection() external view returns (address);
    function harvest(address token) external;
}

interface IWrappedEther is IERC20 {
    function deposit() external payable;
}

/// Routes 100% of the amount designated by a product as HOUSE fees. It does not
/// choose the fee rate, debit vault principal, or collect LP-owned earnings.
/// No owner, recipient setter, swap authority or arbitrary withdrawal path.
contract HouseFeeRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;
    address public constant FANOUT = 0x1b88A6c6516FD2918905186F21Bb9F5CaA1a15c8;
    address public constant HOMECOMING = 0x7c165Ae6E7BFD939Fee1ACA99Ca5aeDf85c52dD4;
    IWrappedEther public constant WETH = IWrappedEther(0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73);
    event HouseFeePaid(address indexed source, address indexed token, uint256 amount);

    constructor() {
        require(block.chainid == 4663, "Robinhood only");
        require(
            IFeeFanout(FANOUT).tokenCount() == 8010 && IFeeFanout(FANOUT).collection() == HOMECOMING,
            "Fanout identity mismatch"
        );
        require(address(WETH).code.length != 0, "WETH missing");
    }

    function pay(IERC20 token, uint256 amount) external nonReentrant {
        require(address(token).code.length != 0 && amount != 0, "Invalid fee");
        uint256 beforeBalance = token.balanceOf(FANOUT);
        token.safeTransferFrom(msg.sender, FANOUT, amount);
        require(token.balanceOf(FANOUT) - beforeBalance == amount, "Unsupported transfer tax");
        emit HouseFeePaid(msg.sender, address(token), amount);
    }

    function payNative() external payable nonReentrant {
        _payNative(msg.sender, msg.value);
    }

    receive() external payable nonReentrant {
        _payNative(msg.sender, msg.value);
    }

    function _payNative(address source, uint256 amount) private {
        require(amount != 0, "Zero fee");
        WETH.deposit{value: amount}();
        IERC20(address(WETH)).safeTransfer(FANOUT, amount);
        emit HouseFeePaid(source, address(WETH), amount);
    }

    /// Recover fees transferred directly to this router. Anyone may sweep, but
    /// the destination is always the 8010-share fanout, never the caller.
    function flush(IERC20 token) external nonReentrant {
        uint256 amount = token.balanceOf(address(this));
        if (amount != 0) {
            token.safeTransfer(FANOUT, amount);
            emit HouseFeePaid(address(this), address(token), amount);
        }
    }

    /// Harvest is separate so fanout accounting availability cannot block a swap.
    function harvest(address token) external {
        IFeeFanout(FANOUT).harvest(token);
    }
}
