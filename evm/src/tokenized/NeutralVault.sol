// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {MemberController} from "./MemberController.sol";
import {MemberV4Hook} from "./MemberV4Hook.sol";
import {NeutralAllocation, NeutralExit, NeutralEscrowFactory} from "./NeutralEscrows.sol";

/// One fungible receipt for all matched full-range V4 positions in a family.
/// Pending deposits are separate cash/claims, never advertised as active DN shares.
/// Venue NAV remains dependent on the controller's trusted reporter.
contract NeutralVault is ERC20, ReentrancyGuard, IUnlockCallback {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    uint256 private constant Q96 = 1 << 96;
    uint256 private constant Q128 = 1 << 128;
    uint256 public constant MAX_DEPOSITORS = 32;
    uint256 public constant MAX_DELTA_BPS = 50; // 0.5% of NAV, not gross leveraged notional
    int24 public constant LOWER = -887220;
    int24 public constant UPPER = 887220;

    struct Pair { uint256 longId; uint256 shortId; PoolKey key; }
    struct Deposit { uint256 assets; uint256 minimumShares; address receiver; bool listed; }
    enum Phase { Collecting, Allocating, Refundable }
    MemberController public immutable controller;
    MemberV4Hook public immutable hook;
    NeutralEscrowFactory public immutable escrows;
    IPoolManager public immutable manager;
    IERC20 public immutable asset;
    bytes32 public immutable group;
    uint8 public immutable tiers;
    uint256 public immutable minimumBatchAssets;
    bool public configured;
    bool public entriesOpen;
    Phase public phase;
    uint256 public epoch = 1;
    uint256 public pendingAssets;
    uint256 public reservedCash;
    NeutralAllocation public allocation;
    mapping(address => Deposit) public deposits;
    mapping(address => address[]) private userExits;
    address[] private depositors;
    uint256[] private ids;
    Pair[] private pairs;
    bytes32 private unlockHash;

    event Entered(uint256 indexed epoch, address indexed owner, address receiver, uint256 assets, uint256 minimumShares);
    event AllocationStarted(uint256 indexed epoch, address allocation, uint256 firstRequest, uint256 assets);
    event Activated(uint256 indexed epoch, uint256 assets, uint256 receiptShares);
    event Refunded(uint256 indexed epoch, address indexed owner, uint256 assets);
    event PendingRecovered(uint256 indexed epoch, address indexed owner, address exitEscrow);
    event ExitRequested(address indexed owner, address indexed receiver, uint256 shares, address exitEscrow);
    error Unready();

    modifier onlyCoordinator() { require(msg.sender == controller.keeper()); _; }
    constructor(MemberController c, MemberV4Hook h, NeutralEscrowFactory f, bytes32 g, uint8 maxTier, uint256 minimumAssets)
        ERC20("deltaLP neutral pool receipt", "dlpDN")
    {
        require(address(h.controller()) == address(c) && address(f.controller()) == address(c));
        require(maxTier != 0 && maxTier <= 50 && minimumAssets >= uint256(maxTier) * 2e6 && g != bytes32(0));
        controller = c; hook = h; escrows = f; manager = h.manager(); asset = c.usdg();
        group = g; tiers = maxTier; minimumBatchAssets = minimumAssets;
    }

    /// Freeze membership to every paired tier, in the controller's allocation order.
    function configure() external onlyCoordinator {
        require(!configured);
        uint256[] memory family = controller.family(group);
        require(family.length == uint256(tiers) * 2, "Incomplete family");
        uint256 seen;
        for (uint256 i; i < family.length; ++i) {
            MemberController.Member memory m = controller.memberState(family[i]);
            if (m.short) continue;
            require(m.leverage <= tiers && (seen & (1 << m.leverage)) == 0);
            seen |= 1 << m.leverage;
            uint256 opposite = controller.registeredSeries(keccak256(abi.encode(group, m.leverage, true)));
            MemberController.Member memory s = controller.memberState(opposite);
            require(s.short && s.group == group && s.market == m.market && s.sizeDecimals == m.sizeDecimals);
            address a = address(m.token); address b = address(s.token);
            PoolKey memory key = PoolKey(Currency.wrap(a < b ? a : b), Currency.wrap(a < b ? b : a), 3000, 60, IHooks(address(hook)));
            if (hook.poolGroups(key.toId()) == bytes32(0)) hook.registerPool(key);
            pairs.push(Pair(family[i], opposite, key)); ids.push(family[i]); ids.push(opposite);
        }
        require(pairs.length == tiers);
        configured = true;
    }
    function setEntriesOpen(bool open) external onlyCoordinator { require(configured); entriesOpen = open; }
    function memberIds() external view returns (uint256[] memory) { return ids; }
    function depositorAddresses() external view returns (address[] memory) { return depositors; }
    function pair(uint256 index) external view returns (Pair memory) { return pairs[index]; }
    function exitCount(address account) external view returns (uint256) { return userExits[account].length; }
    function exitAt(address account, uint256 index) external view returns (address) { return userExits[account][index]; }

    /// One application action; wallet approval is separate on wallets without batching.
    function enter(uint256 assets, uint256 minimumShares, address receiver, uint64 deadline) external nonReentrant {
        require(entriesOpen && phase == Phase.Collecting && receiver != address(0) && assets >= 10_000 && minimumShares != 0 && deadline >= block.timestamp);
        require(pendingAssets + assets <= 1e18);
        Deposit storage d = deposits[msg.sender];
        if (!d.listed) { require(depositors.length < MAX_DEPOSITORS); depositors.push(msg.sender); d.listed = true; }
        if (d.assets != 0) require(d.receiver == receiver);
        uint256 beforeBalance = asset.balanceOf(address(this));
        asset.safeTransferFrom(msg.sender, address(this), assets);
        require(asset.balanceOf(address(this)) - beforeBalance == assets);
        d.assets += assets; d.minimumShares += minimumShares; d.receiver = receiver;
        pendingAssets += assets; reservedCash += assets;
        emit Entered(epoch, msg.sender, receiver, assets, minimumShares);
    }
    function lowerMinimum(uint256 minimum) external {
        Deposit storage d = deposits[msg.sender];
        require(d.assets != 0 && minimum != 0 && minimum <= d.minimumShares); d.minimumShares = minimum;
    }
    function refund(address account) public nonReentrant {
        require(phase != Phase.Allocating);
        require(msg.sender == account || phase == Phase.Refundable, "Only depositor can cancel");
        Deposit memory d = deposits[account]; require(d.assets != 0);
        deposits[account].assets = 0; deposits[account].minimumShares = 0;
        pendingAssets -= d.assets; reservedCash -= d.assets;
        asset.safeTransfer(account, d.assets);
        emit Refunded(epoch, account, d.assets);
        if (pendingAssets == 0) _reset();
    }
    function startAllocation(uint256[] calldata minimumMemberShares, uint64 deadline) external onlyCoordinator nonReentrant {
        require(entriesOpen && phase == Phase.Collecting && pendingAssets >= minimumBatchAssets && minimumMemberShares.length == ids.length);
        require(controller.family(group).length == ids.length, "Family changed");
        phase = Phase.Allocating;
        allocation = escrows.allocation(group, ids);
        reservedCash = 0;
        asset.safeTransfer(address(allocation), pendingAssets);
        allocation.start(minimumMemberShares, deadline);
        emit AllocationStarted(epoch, address(allocation), allocation.firstRequest(), pendingAssets);
    }
    /// A depositor can cancel an unissued atomic batch; every participant then has
    /// a full USDG refund. This cannot unwind already-issued member claims silently.
    function cancelAllocation() external nonReentrant {
        require(phase == Phase.Allocating && deposits[msg.sender].assets != 0);
        allocation.cancel(); phase = Phase.Refundable; reservedCash = pendingAssets;
    }
    function recoverPending(bool asUSDG, uint256 minimumAssets, uint64 deadline) external nonReentrant returns (address exitEscrow) {
        require(phase == Phase.Allocating && allocation.settled());
        Deposit memory d = deposits[msg.sender]; require(d.assets != 0);
        deposits[msg.sender].assets = 0; deposits[msg.sender].minimumShares = 0;
        if (asUSDG) {
            NeutralExit recovery = escrows.exit(msg.sender, msg.sender, minimumAssets, ids);
            allocation.release(address(recovery), d.assets, pendingAssets);
            recovery.start(deadline); exitEscrow = address(recovery);
            userExits[msg.sender].push(exitEscrow);
        } else { allocation.release(msg.sender, d.assets, pendingAssets); }
        pendingAssets -= d.assets;
        emit PendingRecovered(epoch, msg.sender, exitEscrow);
        if (pendingAssets == 0) _reset();
    }

    /// No receipt before real reconciled exposure AND actual V4 liquidity exist.
    function activate() external nonReentrant {
        require(phase == Phase.Allocating && allocation.settled());
        uint256 supply = totalSupply();
        (uint256 beforeValue,,) = portfolio();
        require(supply == 0 || beforeValue != 0, "Depleted basket");
        allocation.release(address(this), 1, 1);
        _unlock(0, 0, 0);
        (uint256 afterValue, int256 delta,) = portfolio();
        require(afterValue > beforeValue);
        require(_abs(delta) * 10_000 <= afterValue * MAX_DELTA_BPS, "Unmatched exposure");
        uint256 addedValue = afterValue - beforeValue;
        uint256 receiptShares = supply == 0 ? afterValue * 1e12 : Math.mulDiv(addedValue, supply, beforeValue);
        // An incoming batch cannot be advertised as active at near-zero backing.
        require(addedValue >= Math.mulDiv(pendingAssets, 9700, 10_000), "Execution loss limit");
        for (uint256 i; i < depositors.length; ++i) {
            Deposit memory d = deposits[depositors[i]];
            if (d.assets == 0) continue;
            uint256 shares = Math.mulDiv(receiptShares, d.assets, pendingAssets);
            require(shares >= d.minimumShares, "Receipt minimum");
            _mint(d.receiver, shares);
        }
        emit Activated(epoch, addedValue, totalSupply() - supply);
        _reset();
    }

    function requestExit(uint256 shares, uint256 minimumAssets, address receiver, uint64 deadline)
        external nonReentrant returns (address exitEscrow)
    {
        require(shares != 0 && shares <= balanceOf(msg.sender) && receiver != address(0) && deadline > block.timestamp);
        uint256 supply = totalSupply();
        // Collect fees before calculating the user's fraction of idle token balances.
        _unlock(1, 0, 0);
        uint256[] memory idle = new uint256[](ids.length);
        for (uint256 i; i < ids.length; ++i) idle[i] = IERC20(controller.memberToken(ids[i])).balanceOf(address(this));
        uint256 cash = asset.balanceOf(address(this)) - reservedCash;
        _burn(msg.sender, shares);
        _unlock(2, shares, supply);
        NeutralExit recovery = escrows.exit(msg.sender, receiver, minimumAssets, ids);
        for (uint256 i; i < ids.length; ++i) {
            IERC20 token = IERC20(controller.memberToken(ids[i]));
            uint256 amount = token.balanceOf(address(this)) - idle[i] + Math.mulDiv(idle[i], shares, supply);
            if (amount != 0) token.safeTransfer(address(recovery), amount);
        }
        uint256 amountCash = Math.mulDiv(cash, shares, supply);
        if (amountCash != 0) asset.safeTransfer(address(recovery), amountCash);
        recovery.start(deadline); exitEscrow = address(recovery);
        userExits[msg.sender].push(exitEscrow);
        emit ExitRequested(msg.sender, receiver, shares, exitEscrow);
    }

    function portfolio() public view returns (uint256 value, int256 delta, uint256 gross) {
        value = asset.balanceOf(address(this)) - reservedCash;
        for (uint256 i; i < pairs.length; ++i) {
            Pair storage p = pairs[i];
            (uint256 amount0, uint256 amount1,) = _inventory(p.key);
            address a = Currency.unwrap(p.key.currency0);
            amount0 += IERC20(a).balanceOf(address(this));
            amount1 += IERC20(Currency.unwrap(p.key.currency1)).balanceOf(address(this));
            if (amount0 == 0 && amount1 == 0) continue;
            MemberController.Member memory l = _fresh(p.longId);
            MemberController.Member memory s = _fresh(p.shortId);
            (uint256 vl, int256 dl) = _claim(l, address(l.token) == a ? amount0 : amount1);
            (uint256 vs, int256 ds) = _claim(s, address(s.token) == a ? amount0 : amount1);
            value += vl + vs; delta += dl + ds; gross += _abs(dl) + _abs(ds);
        }
    }
    function _claim(MemberController.Member memory m, uint256 balance) private view returns (uint256 value, int256 delta) {
        if (balance == 0) return (0, 0);
        uint256 supply = m.token.totalSupply(); require(supply != 0);
        value = Math.mulDiv(m.nav, balance, supply);
        uint256 notional = Math.mulDiv(_abs(m.position), m.mark, 10 ** m.sizeDecimals);
        uint256 exposure = Math.mulDiv(notional, balance, supply);
        delta = m.short ? -int256(exposure) : int256(exposure);
    }
    function _fresh(uint256 id) private view returns (MemberController.Member memory m) {
        m = controller.memberState(id);
        if (m.reportSequence == 0 || m.requestedAction != m.confirmedAction || block.timestamp - m.observedAt > 60 || m.nav == 0) revert Unready();
    }
    function _inventory(PoolKey memory key) private view returns (uint256 amount0, uint256 amount1, uint128 liquidity) {
        (uint160 sqrtPrice,,,) = manager.getSlot0(key.toId());
        if (sqrtPrice == 0) return (0, 0, 0);
        uint256 last0; uint256 last1;
        (liquidity, last0, last1) = manager.getPositionInfo(key.toId(), address(this), LOWER, UPPER, bytes32(0));
        if (liquidity == 0) return (0, 0, 0);
        uint160 lower = TickMath.getSqrtPriceAtTick(LOWER); uint160 upper = TickMath.getSqrtPriceAtTick(UPPER);
        uint160 price = sqrtPrice < lower ? lower : sqrtPrice > upper ? upper : sqrtPrice;
        amount0 = SqrtPriceMath.getAmount0Delta(price, upper, liquidity, false);
        amount1 = SqrtPriceMath.getAmount1Delta(lower, price, liquidity, false);
        (uint256 growth0, uint256 growth1) = manager.getFeeGrowthInside(key.toId(), LOWER, UPPER);
        unchecked { growth0 -= last0; growth1 -= last1; }
        amount0 += Math.mulDiv(growth0, liquidity, Q128); amount1 += Math.mulDiv(growth1, liquidity, Q128);
    }
    function _unlock(uint8 kind, uint256 numerator, uint256 denominator) private {
        bytes memory data = abi.encode(kind, numerator, denominator);
        require(unlockHash == bytes32(0)); unlockHash = keccak256(data);
        manager.unlock(data); unlockHash = bytes32(0);
    }
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager) && unlockHash != bytes32(0) && keccak256(data) == unlockHash);
        (uint8 kind, uint256 numerator, uint256 denominator) = abi.decode(data, (uint8, uint256, uint256));
        for (uint256 i; i < pairs.length; ++i) {
            Pair storage p = pairs[i]; PoolKey memory key = p.key;
            (,, uint128 held) = _inventory(key);
            int256 change;
            if (kind == 0) {
                MemberController.Member memory l = _fresh(p.longId); MemberController.Member memory s = _fresh(p.shortId);
                (, , bool longNeeded) = controller.target(p.longId); (, , bool shortNeeded) = controller.target(p.shortId);
                require(!longNeeded && !shortNeeded && l.position > 0 && s.position < 0, "Positions not ready");
                uint256 p0 = Math.mulDiv(l.nav, Q128, l.token.totalSupply()); uint256 p1 = Math.mulDiv(s.nav, Q128, s.token.totalSupply());
                if (Currency.unwrap(key.currency0) != address(l.token)) (p0, p1) = (p1, p0);
                uint256 fair = Math.sqrt(Math.mulDiv(p0, 1 << 192, p1)); require(fair > TickMath.MIN_SQRT_PRICE && fair < TickMath.MAX_SQRT_PRICE);
                (uint160 price,,,) = manager.getSlot0(key.toId());
                if (price == 0) { manager.initialize(key, uint160(fair)); price = uint160(fair); }
                // 0.1% on sqrt price: at most approximately 0.2% on token price.
                uint256 distance = price > fair ? price - fair : fair - price;
                require(distance * 10_000 <= fair * 10, "Pool price differs from NAV");
                uint256 b0 = IERC20(Currency.unwrap(key.currency0)).balanceOf(address(this));
                uint256 b1 = IERC20(Currency.unwrap(key.currency1)).balanceOf(address(this));
                uint256 add = Math.min(Math.mulDiv(b0, price, Q96), Math.mulDiv(b1, Q96, price));
                require(add != 0 && add + held <= uint256(uint128(type(int128).max)));
                change = int256(add);
            } else if (kind == 2) { change = -int256(Math.mulDiv(held, numerator, denominator)); }
            if (held == 0 && change == 0) continue;
            (BalanceDelta amounts,) = manager.modifyLiquidity(key, IPoolManager.ModifyLiquidityParams(LOWER, UPPER, change, bytes32(0)), "");
            _settle(key.currency0, amounts.amount0()); _settle(key.currency1, amounts.amount1());
        }
        return "";
    }
    function _settle(Currency currency, int128 amount) private {
        if (amount < 0) { manager.sync(currency); IERC20(Currency.unwrap(currency)).safeTransfer(address(manager), uint256(-int256(amount))); manager.settle(); }
        else if (amount > 0) manager.take(currency, address(this), uint256(uint128(amount)));
    }
    function _reset() private {
        for (uint256 i; i < depositors.length; ++i) delete deposits[depositors[i]];
        delete depositors; pendingAssets = 0; reservedCash = 0; allocation = NeutralAllocation(address(0)); phase = Phase.Collecting; ++epoch;
    }
    function _abs(int256 n) private pure returns (uint256) { return uint256(n < 0 ? -n : n); }
    function _update(address from, address to, uint256 amount) internal override {
        super._update(from, to, amount);
        if (configured) controller.requestGroupCheck(group);
    }
}
