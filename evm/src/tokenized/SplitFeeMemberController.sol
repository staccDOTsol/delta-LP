// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MemberController} from "./MemberController.sol";
import {ILighterL1} from "./LighterSeriesAccount.sol";
import {SplitHouseFeeRouter} from "./SplitHouseFeeRouter.sol";

/// New immutable 3% / 6% policy; never changes the live v3 controller in place.
contract SplitFeeMemberController is MemberController {
    using SafeERC20 for IERC20;
    SplitHouseFeeRouter public immutable feeRouter;

    constructor(IERC20 asset, ILighterL1 venue, address admin, address reporter_, address keeper_, SplitHouseFeeRouter router)
        MemberController(asset, venue, admin, reporter_, keeper_)
    {
        require(address(router).code.length != 0, "Fee router missing");
        require(router.FANOUT() == 0x1b88A6c6516FD2918905186F21Bb9F5CaA1a15c8, "Wizards mismatch");
        feeRouter = router;
    }

    function ENTRY_FEE_BPS() public pure override returns (uint256) { return 300; }
    function EXIT_FEE_BPS() public pure override returns (uint256) { return 600; }
    function FEE_FANOUT() public view override returns (address) { return address(feeRouter); }
    function feesReady() public view override returns (bool) { return feeRouter.nftFanout().configured(); }
    function _payHouseFee(uint256 amount) internal override {
        usdg.forceApprove(address(feeRouter), amount);
        feeRouter.pay(usdg, amount);
        usdg.forceApprove(address(feeRouter), 0);
    }
}
