// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface ITransferRebalance {
    function onMemberTransfer(uint256 seriesId, address from, address to, uint256 amount) external;
    function counterparts(uint256 seriesId) external view returns (uint256[] memory);
}

/// One fungible claim on one controller-managed leverage/direction series.
/// Transfers synchronously notify the controller. They do not promise a venue fill.
contract MemberToken is ERC20 {
    address public immutable controller;
    uint256 public immutable seriesId;

    error OnlyController();

    constructor(string memory name_, string memory symbol_, uint256 seriesId_, address controller_)
        ERC20(name_, symbol_)
    {
        require(controller_ != address(0));
        controller = controller_;
        seriesId = seriesId_;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != controller) revert OnlyController();
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        if (msg.sender != controller) revert OnlyController();
        _burn(from, amount);
    }

    function counterparties() external view returns (uint256[] memory) {
        return ITransferRebalance(controller).counterparts(seriesId);
    }

    function _update(address from, address to, uint256 amount) internal override {
        super._update(from, to, amount);
        // Includes mint, burn, transfer, transferFrom and AMM transfers. No venue
        // calls or iteration over other holders/tiers occurs in an ERC20 transfer.
        ITransferRebalance(controller).onMemberTransfer(seriesId, from, to, amount);
    }
}
