// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MemberToken} from "./MemberToken.sol";
import {LighterSeriesAccount, ILighterL1} from "./LighterSeriesAccount.sol";

/// Separates child creation code from the controller's EIP-170 runtime budget.
contract MemberFactory {
    address public immutable controller;
    IERC20 public immutable asset;
    ILighterL1 public immutable venue;

    constructor(IERC20 asset_, ILighterL1 venue_) {
        controller = msg.sender;
        asset = asset_;
        venue = venue_;
    }

    function create(uint256 id, uint16 market, string calldata name, string calldata symbol)
        external
        returns (MemberToken token, LighterSeriesAccount custody)
    {
        require(msg.sender == controller);
        token = new MemberToken(name, symbol, id, controller);
        custody = new LighterSeriesAccount(asset, venue, market, controller);
    }
}
