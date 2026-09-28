// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MemberToken, ITransferRebalance} from "./MemberToken.sol";
import {LighterSeriesAccount, ILighterL1} from "./LighterSeriesAccount.sol";
import {IFeeFanout} from "./HouseFeeRouter.sol";
import {MemberFactory} from "./MemberFactory.sol";

/// Experimental managed-NAV controller. The reporter is a TRUSTED valuation role,
/// not an on-chain proof of Lighter equity. Do not describe this model as trustless.
/// ERC20 transfers invoke group coordination immediately; venue fills are asynchronous.
contract MemberController is ITransferRebalance, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 public constant MAX_AGE = 60;
    uint256 public constant MAX_MEMBERS = 100;
    uint256 public constant BPS = 10_000;
    uint256 public constant SLIPPAGE_BPS = 10;
    uint256 public constant REBALANCE_BPS = 100;
    uint256 public constant ENTRY_FEE_BPS = 200;
    uint256 public constant EXIT_FEE_BPS = 400;
    address public constant FEE_FANOUT = 0x1b88A6c6516FD2918905186F21Bb9F5CaA1a15c8;

    struct Member {
        MemberToken token;
        LighterSeriesAccount custody;
        bytes32 group;
        uint16 market;
        uint8 leverage;
        uint8 sizeDecimals;
        uint8 priceDecimals;
        bool short;
        bool enabled;
        uint64 requestedAction;
        uint64 confirmedAction;
        uint64 reportSequence;
        uint64 observedAt;
        uint64 lastActionAt;
        uint256 cash;
        uint256 nav;
        uint256 mark; // USDG micro-units per whole underlying
        int256 position; // venue base ticks
        uint256 venueAvailable;
        uint256 redeemShares;
        uint16 initialMarginBps;
    }

    struct Request {
        address owner;
        address receiver;
        uint256 member;
        uint256 amount;
        uint256 minimum;
        uint64 createdAt;
        uint64 deadline;
        bool redeem;
        bool completed;
    }

    struct VenueSetup {
        bytes32 publicKeyHash;
        uint16 initialMarginBps; // zero only when the owner abandons margin setup
        uint64 generation;
        bool pending;
    }

    struct Report {
        uint64 sequence;
        uint64 action;
        uint64 observedAt;
        int256 venueEquity;
        int256 position;
        uint256 mark;
        uint256 available;
        bool ordersAndTransfersSettled;
        bytes32 evidenceHash;
        uint16 initialMarginBps;
    }

    IERC20 public immutable usdg;
    ILighterL1 public immutable lighter;
    address public immutable reporter;
    address public immutable keeper;
    MemberFactory public immutable factory;
    uint256 public memberCount;
    uint256 public requestCount;
    uint256 public escrowAssets;
    mapping(uint256 => Member) public members;
    mapping(address => uint256) public memberIds;
    mapping(uint256 => Request) public requests;
    mapping(bytes32 => uint256[]) private groupMembers;
    mapping(bytes32 => uint64) public groupRequested;
    mapping(bytes32 => uint64) public groupChecked;
    mapping(bytes32 => uint256) public registeredSeries;
    mapping(uint256 => uint256) public requestBatch;
    mapping(uint256 => uint256) public batchSize;
    mapping(uint256 => VenueSetup) public venueSetup;

    event MemberCreated(
        uint256 indexed member, bytes32 indexed group, address token, address custody, uint8 leverage, bool short
    );
    event GroupRebalanceRequested(
        bytes32 indexed group, uint64 sequence, uint256 indexed member, address from, address to, uint256 amount
    );
    event GroupChecked(bytes32 indexed group, uint64 sequence);
    event GroupCheckRequested(bytes32 indexed group, uint64 sequence, address indexed source);
    event Requested(
        uint256 indexed request, uint256 indexed member, address indexed owner, uint256 amount, bool redeem
    );
    event RequestSettled(uint256 indexed request, uint256 assets, uint256 shares);
    event RequestCancelled(uint256 indexed request);
    event NeutralBatchRequested(uint256 indexed firstRequest, uint256 count, uint256 assets);
    event HouseFeePaid(uint256 indexed request, address indexed token, uint256 amount, bool exit);
    event VenueAction(uint256 indexed member, uint64 nonce, uint8 kind, int256 amount);
    event VenueSetupRequested(uint256 indexed member, uint64 generation, bytes32 publicKeyHash, uint16 marginBps);
    event VenueSetupConfirmed(uint256 indexed member, uint64 generation, bytes32 evidenceHash);
    event VenueMarginAbandoned(uint256 indexed member, uint64 generation);
    event Reconciled(
        uint256 indexed member, uint64 sequence, uint64 action, uint256 nav, int256 position, bytes32 evidenceHash
    );

    error NotAuthorized();
    error InvalidMember();
    error PendingOrStale();
    error InvalidReport();
    error InvalidRequest();
    error InsufficientCash();
    error Slippage();

    modifier onlyKeeper() {
        if (msg.sender != keeper) revert NotAuthorized();
        _;
    }

    constructor(IERC20 asset, ILighterL1 venue, address admin, address reporter_, address keeper_) Ownable(admin) {
        require(
            address(asset).code.length != 0 && address(venue).code.length != 0 && reporter_ != address(0)
                && keeper_ != address(0)
        );
        require(
            block.chainid == 4663 && IFeeFanout(FEE_FANOUT).tokenCount() == 8010
                && IFeeFanout(FEE_FANOUT).collection() == 0x7c165Ae6E7BFD939Fee1ACA99Ca5aeDf85c52dD4
        );
        usdg = asset;
        lighter = venue;
        reporter = reporter_;
        keeper = keeper_;
        factory = new MemberFactory(asset, venue);
    }

    function createMember(
        bytes32 group,
        uint16 market,
        uint8 leverage,
        bool short,
        uint8 sizeDecimals,
        uint8 priceDecimals,
        string calldata name,
        string calldata symbol
    ) external onlyOwner returns (uint256 id) {
        require(group != bytes32(0) && leverage >= 1 && leverage <= 50 && sizeDecimals <= 12 && priceDecimals <= 6);
        uint256[] storage siblings = groupMembers[group];
        require(siblings.length < MAX_MEMBERS);
        bytes32 key = keccak256(abi.encode(group, leverage, short));
        require(registeredSeries[key] == 0);
        if (siblings.length != 0) {
            Member storage first = members[siblings[0]];
            require(
                first.market == market && first.sizeDecimals == sizeDecimals && first.priceDecimals == priceDecimals
            );
        }
        id = ++memberCount;
        Member storage m = members[id];
        m.group = group;
        m.market = market;
        m.leverage = leverage;
        m.short = short;
        m.sizeDecimals = sizeDecimals;
        m.priceDecimals = priceDecimals;
        (m.token, m.custody) = factory.create(id, market, name, symbol);
        memberIds[address(m.token)] = id;
        siblings.push(id);
        registeredSeries[key] = id;
        emit MemberCreated(id, group, address(m.token), address(m.custody), leverage, short);
    }

    function memberToken(uint256 id) external view returns (address) {
        return address(_member(id).token);
    }

    function memberState(uint256 id) external view returns (Member memory) {
        return _member(id);
    }

    function family(bytes32 group) external view returns (uint256[] memory) {
        return groupMembers[group];
    }

    function counterparts(uint256 id) external view returns (uint256[] memory ids) {
        Member storage m = _member(id);
        uint256[] storage all = groupMembers[m.group];
        uint256 n;
        for (uint256 i; i < all.length; ++i) {
            if (members[all[i]].short != m.short) ++n;
        }
        ids = new uint256[](n);
        n = 0;
        for (uint256 i; i < all.length; ++i) {
            if (members[all[i]].short != m.short) ids[n++] = all[i];
        }
    }

    function setEnabled(uint256 id, bool enabled) external onlyOwner {
        if (enabled && venueSetup[id].pending) revert PendingOrStale();
        _member(id).enabled = enabled;
    }

    /// Rotation remains possible during an unresolved action or stale report.
    /// It does not erase earlier venue work: the final report must reconcile ALL
    /// orders/transfers and the custody priority watermark includes every request.
    function configureVenueKey(uint256 id, bytes calldata publicKey, uint16 marginBps) external onlyOwner nonReentrant {
        require(marginBps != 0 && marginBps <= BPS);
        Member storage m = _member(id);
        VenueSetup storage setup = venueSetup[id];
        bytes32 keyHash = keccak256(publicKey);
        require(keyHash != setup.publicKeyHash, "Key already requested");
        setup.publicKeyHash = keyHash;
        setup.initialMarginBps = marginBps;
        ++setup.generation;
        setup.pending = true;
        m.enabled = false;
        _action(id, m, 5, int256(uint256(marginBps)));
        m.custody.configureKey(publicKey);
        emit VenueSetupRequested(id, setup.generation, keyHash, marginBps);
    }

    /// If the venue refuses a margin change, allow recovery at its observed setting.
    /// This does not bypass key confirmation, unsettled actions, or reopen entries.
    function abandonVenueMargin(uint256 id) external onlyOwner {
        VenueSetup storage setup = venueSetup[id];
        require(setup.pending);
        setup.initialMarginBps = 0;
        emit VenueMarginAbandoned(id, setup.generation);
    }

    function bindAccount(uint256 id, uint48 index) external {
        if (msg.sender != reporter) revert NotAuthorized();
        _member(id).custody.bind(index);
    }

    function onMemberTransfer(uint256 id, address from, address to, uint256 amount) external {
        Member storage m = _member(id);
        if (msg.sender != address(m.token)) revert NotAuthorized();
        // Every transfer, including AMM transfers, has its own observable sequence.
        // A keeper can check the latest state without executing obsolete intermediate plans.
        emit GroupRebalanceRequested(m.group, ++groupRequested[m.group], id, from, to, amount);
    }

    /// Anyone may request a check, including a V4 hook for swaps settled entirely
    /// with flash accounting / ERC-6909 claims. This conveys no trading authority.
    function requestGroupCheck(bytes32 group) external {
        if (groupMembers[group].length == 0) revert InvalidMember();
        emit GroupCheckRequested(group, ++groupRequested[group], msg.sender);
    }

    function requestDeposit(uint256 id, uint256 assets, uint256 minShares, address receiver, uint64 deadline)
        external
        nonReentrant
        returns (uint256 request)
    {
        Member storage m = _member(id);
        if (!m.enabled || assets < 1e6 || receiver == address(0) || deadline <= block.timestamp) {
            revert InvalidRequest();
        }
        uint256 beforeBalance = usdg.balanceOf(address(this));
        usdg.safeTransferFrom(msg.sender, address(this), assets);
        require(usdg.balanceOf(address(this)) - beforeBalance == assets);
        escrowAssets += assets;
        request = _request(id, assets, minShares, receiver, deadline, false);
    }

    /// Equal USDG allocation to every enabled matched leverage tier in this family.
    /// Both legs receive exactly the same amount; indivisible remainder stays with caller.
    function requestNeutral(
        bytes32 group,
        uint256 assets,
        uint256[] calldata minimumShares,
        address receiver,
        uint64 deadline
    ) external nonReentrant returns (uint256 firstRequest, uint256 count, uint256 allocated) {
        if (receiver == address(0) || deadline <= block.timestamp) revert InvalidRequest();
        uint256[] storage all = groupMembers[group];
        uint256 pairs;
        for (uint256 i; i < all.length; ++i) {
            if (_eligiblePair(all[i])) ++pairs;
        }
        if (pairs == 0 || minimumShares.length != 2 * pairs) revert InvalidRequest();
        for (uint256 i; i < minimumShares.length; ++i) {
            if (minimumShares[i] == 0) revert InvalidRequest();
        }
        uint256 perLeg = assets / (2 * pairs);
        if (perLeg < 1e6) revert InvalidRequest();
        allocated = perLeg * 2 * pairs;
        uint256 beforeBalance = usdg.balanceOf(address(this));
        usdg.safeTransferFrom(msg.sender, address(this), allocated);
        require(usdg.balanceOf(address(this)) - beforeBalance == allocated);
        escrowAssets += allocated;
        firstRequest = requestCount + 1;
        for (uint256 i; i < all.length; ++i) {
            if (_eligiblePair(all[i])) {
                uint256 id = all[i];
                uint256 other = registeredSeries[keccak256(abi.encode(group, members[id].leverage, true))];
                requestBatch[_request(id, perLeg, minimumShares[count], receiver, deadline, false)] = firstRequest;
                requestBatch[_request(other, perLeg, minimumShares[count + 1], receiver, deadline, false)] =
                firstRequest;
                count += 2;
            }
        }
        batchSize[firstRequest] = count;
        emit NeutralBatchRequested(firstRequest, count, allocated);
    }

    function setMinimum(uint256 request, uint256 minimum) external {
        Request storage r = requests[request];
        if (r.owner != msg.sender || r.completed || minimum == 0) revert InvalidRequest();
        r.minimum = minimum;
    }

    function _eligiblePair(uint256 id) private view returns (bool) {
        Member storage m = members[id];
        uint256 other = registeredSeries[keccak256(abi.encode(m.group, m.leverage, true))];
        return !m.short && m.enabled && other != 0 && members[other].enabled;
    }

    function requestRedeem(uint256 id, uint256 shares, uint256 minAssets, address receiver, uint64 deadline)
        external
        nonReentrant
        returns (uint256 request)
    {
        Member storage m = _member(id);
        if (shares == 0 || receiver == address(0) || deadline <= block.timestamp) revert InvalidRequest();
        IERC20(address(m.token)).safeTransferFrom(msg.sender, address(this), shares);
        m.redeemShares += shares;
        request = _request(id, shares, minAssets, receiver, deadline, true);
    }

    function _request(uint256 id, uint256 amount, uint256 minimum, address receiver, uint64 deadline, bool redeem)
        private
        returns (uint256 request)
    {
        request = ++requestCount;
        requests[request] =
            Request(msg.sender, receiver, id, amount, minimum, uint64(block.timestamp), deadline, redeem, false);
        emit Requested(request, id, msg.sender, amount, redeem);
    }

    function cancelRequest(uint256 request) external nonReentrant {
        if (requestBatch[request] != 0) revert InvalidRequest();
        _cancelRequest(request);
    }

    function cancelBatch(uint256 first) external nonReentrant {
        uint256 count = batchSize[first];
        if (count == 0) revert InvalidRequest();
        for (uint256 i; i < count; ++i) {
            _cancelRequest(first + i);
        }
    }

    function _cancelRequest(uint256 request) private {
        Request storage r = requests[request];
        if (r.owner != msg.sender || r.completed) revert InvalidRequest();
        r.completed = true;
        if (r.redeem) {
            members[r.member].redeemShares -= r.amount;
            IERC20(address(members[r.member].token)).safeTransfer(r.owner, r.amount);
        } else {
            escrowAssets -= r.amount;
            usdg.safeTransfer(r.owner, r.amount);
        }
        emit RequestCancelled(request);
    }

    function settleRequest(uint256 request) external onlyKeeper nonReentrant {
        if (requestBatch[request] != 0) revert InvalidRequest();
        _settleRequest(request);
    }

    /// Atomic claim issuance, not a claim that both venue orders fill atomically.
    function settleBatch(uint256 first) external onlyKeeper nonReentrant {
        uint256 count = batchSize[first];
        if (count == 0) revert InvalidRequest();
        for (uint256 i; i < count; ++i) {
            _settleRequest(first + i);
        }
    }

    function _settleRequest(uint256 request) private {
        Request storage r = requests[request];
        if (r.owner == address(0) || r.completed || r.deadline < block.timestamp || r.minimum == 0) {
            revert InvalidRequest();
        }
        Member storage m = _member(r.member);
        _fresh(m);
        if (m.observedAt < r.createdAt) revert PendingOrStale();
        uint256 supply = m.token.totalSupply();
        uint256 assets;
        uint256 shares;
        uint256 fee;
        if (r.redeem) {
            shares = r.amount;
            assets = Math.mulDiv(shares, m.nav, supply);
            fee = Math.mulDiv(assets, EXIT_FEE_BPS, BPS);
            if (assets - fee < r.minimum) revert Slippage();
            if (assets > m.cash) revert InsufficientCash();
            uint256 remainingTarget = Math.mulDiv((m.nav - assets) * m.leverage, 10 ** m.sizeDecimals, m.mark);
            uint256 exposure = uint256(m.position < 0 ? -m.position : m.position);
            if (exposure > remainingTarget + Math.mulDiv(remainingTarget, REBALANCE_BPS, BPS)) revert PendingOrStale();
            r.completed = true;
            m.redeemShares -= shares;
            m.cash -= assets;
            m.nav -= assets;
            m.token.burn(address(this), shares);
            usdg.safeTransfer(r.receiver, assets - fee);
        } else {
            if (!m.enabled) revert InvalidRequest();
            fee = Math.mulDiv(r.amount, ENTRY_FEE_BPS, BPS);
            assets = r.amount - fee;
            if (supply == 0) {
                require(m.nav == 0);
                shares = assets * 1e12;
            } else {
                require(m.nav != 0);
                shares = Math.mulDiv(assets, supply, m.nav);
            }
            if (shares == 0 || shares < r.minimum) revert Slippage();
            r.completed = true;
            escrowAssets -= r.amount;
            m.cash += assets;
            m.nav += assets;
            m.token.mint(r.receiver, shares);
        }
        if (fee != 0) usdg.safeTransfer(FEE_FANOUT, fee);
        emit HouseFeePaid(request, address(usdg), fee, r.redeem);
        emit RequestSettled(request, assets, shares);
    }

    /// The trusted reporter must reconcile every operation/fill/transfer, including
    /// cancelled remainders, before reporting a settled state. No HTTP ACK is a fill.
    function reconcile(uint256 id, Report calldata r) external {
        if (msg.sender != reporter) revert NotAuthorized();
        if (venueSetup[id].pending) revert PendingOrStale();
        _reconcile(id, r);
    }

    /// Trusted reporter attests the API's registered key and observed cross-margin
    /// setting together with the ordinary account/queue/settlement evidence.
    /// An L1 receipt or a sendTx ACK is insufficient for this report.
    function reconcileVenueSetup(uint256 id, Report calldata r, bytes32 observedKeyHash) external {
        if (msg.sender != reporter) revert NotAuthorized();
        VenueSetup storage setup = venueSetup[id];
        require(setup.pending && observedKeyHash == setup.publicKeyHash, "Venue key not confirmed");
        require(setup.initialMarginBps == 0 || r.initialMarginBps == setup.initialMarginBps, "Margin not confirmed");
        _reconcile(id, r);
        setup.pending = false;
        emit VenueSetupConfirmed(id, setup.generation, r.evidenceHash);
    }

    function _reconcile(uint256 id, Report calldata r) private {
        Member storage m = _member(id);
        if (
            !m.custody.priorityProcessed() || !r.ordersAndTransfersSettled || r.evidenceHash == bytes32(0)
                || r.sequence <= m.reportSequence || r.action != m.requestedAction || r.observedAt > block.timestamp
                || block.timestamp - r.observedAt > MAX_AGE || r.observedAt < m.lastActionAt
                || r.observedAt < m.observedAt || r.mark == 0 || r.mark > 1e18
                || r.position > int256(uint256(type(uint48).max)) || r.position < -int256(uint256(type(uint48).max))
                || r.initialMarginBps == 0 || r.initialMarginBps > BPS
        ) revert InvalidReport();
        if ((m.short && r.position > 0) || (!m.short && r.position < 0)) revert InvalidReport();
        require(m.cash <= uint256(type(int256).max));
        int256 value = int256(m.cash) + r.venueEquity;
        m.nav = value > 0 ? uint256(value) : 0;
        m.position = r.position;
        m.mark = r.mark;
        m.venueAvailable = r.available;
        m.initialMarginBps = r.initialMarginBps;
        m.reportSequence = r.sequence;
        m.confirmedAction = r.action;
        m.observedAt = r.observedAt;
        emit Reconciled(id, r.sequence, r.action, m.nav, r.position, r.evidenceHash);
    }

    function fundVenue(uint256 id, uint256 assets) external onlyKeeper nonReentrant {
        Member storage m = _member(id);
        _fresh(m);
        if (assets < 1e6 || assets > m.cash) revert InsufficientCash();
        m.cash -= assets;
        _action(id, m, 0, int256(assets));
        usdg.forceApprove(address(m.custody), assets);
        m.custody.deposit(assets);
        usdg.forceApprove(address(m.custody), 0);
    }

    function requestVenueWithdrawal(uint256 id, uint64 assets) external onlyKeeper nonReentrant {
        Member storage m = _member(id);
        _fresh(m);
        if (assets < 1e6 || assets > m.venueAvailable) revert InsufficientCash();
        _action(id, m, 1, int256(uint256(assets)));
        m.custody.withdraw(assets);
    }

    function collectVenueWithdrawal(uint256 id) external onlyKeeper nonReentrant returns (uint256 assets) {
        Member storage m = _member(id);
        assets = m.custody.collect();
        if (assets != 0) {
            m.cash += assets;
            // Cannot count the same amount both in Lighter equity and local cash.
            _action(id, m, 2, int256(assets));
        }
    }

    function target(uint256 id) public view returns (int256 desired, int256 delta, bool needed) {
        Member storage m = _member(id);
        _fresh(m);
        uint256 supply = m.token.totalSupply();
        uint256 backing = supply == 0 ? 0 : Math.mulDiv(m.nav, supply - m.redeemShares, supply);
        uint256 raw = Math.mulDiv(backing * m.leverage, 10 ** m.sizeDecimals, m.mark);
        // At the venue's maximum leverage the nominal target leaves no collateral
        // buffer. Permit at most a 2% target haircut; a wrong margin setting or a
        // materially underfunded account must still fail the opening-margin check.
        uint256 venueEquity = m.nav > m.cash ? m.nav - m.cash : 0;
        uint256 budget = Math.mulDiv(venueEquity, BPS - REBALANCE_BPS, BPS);
        uint256 capacity = budget > 1
            ? Math.mulDiv(Math.mulDiv(budget - 1, BPS, m.initialMarginBps), 10 ** m.sizeDecimals, m.mark)
            : 0;
        if (capacity < raw && capacity >= Math.mulDiv(raw, 9800, BPS, Math.Rounding.Ceil)) raw = capacity;
        require(raw <= type(uint48).max);
        desired = m.short ? -int256(raw) : int256(raw);
        delta = desired - m.position;
        uint256 magnitude = uint256(delta < 0 ? -delta : delta);
        needed = magnitude != 0 && (raw == 0 || magnitude * BPS > raw * REBALANCE_BPS);
    }

    function rebalance(uint256 id, uint32 limitPrice) external onlyKeeper nonReentrant {
        Member storage m = _member(id);
        (, int256 delta, bool needed) = target(id);
        require(needed);
        // L1 createOrder does not change the venue's initial margin setting.
        // Increasing exposure requires a reconciled setting and collateral buffer.
        if ((delta > 0 && !m.short) || (delta < 0 && m.short)) {
            uint256 venueEquity = m.nav > m.cash ? m.nav - m.cash : 0;
            (int256 desired,,) = target(id);
            uint256 notional = Math.mulDiv(
                uint256(desired < 0 ? -desired : desired), m.mark, 10 ** m.sizeDecimals, Math.Rounding.Ceil
            );
            uint256 margin = Math.mulDiv(notional, m.initialMarginBps, BPS, Math.Rounding.Ceil);
            if (margin > Math.mulDiv(venueEquity, BPS - REBALANCE_BPS, BPS)) revert InsufficientCash();
        }
        uint256 markTicks = m.mark / 10 ** (6 - m.priceDecimals);
        if (
            markTicks == 0 || limitPrice < Math.mulDiv(markTicks, BPS - SLIPPAGE_BPS, BPS, Math.Rounding.Ceil)
                || limitPrice > Math.mulDiv(markTicks, BPS + SLIPPAGE_BPS, BPS)
        ) revert Slippage();
        uint256 magnitude = uint256(delta < 0 ? -delta : delta);
        require(magnitude <= type(uint48).max);
        _action(id, m, 3, delta);
        m.custody.order(uint48(magnitude), limitPrice, delta < 0);
    }

    function cancelVenueOrders(uint256 id) external onlyKeeper nonReentrant {
        Member storage m = _member(id);
        _action(id, m, 4, 0);
        m.custody.cancelOrders();
    }

    function markGroupChecked(bytes32 group, uint64 sequence) external onlyKeeper {
        require(sequence == groupRequested[group] && groupMembers[group].length != 0);
        uint256[] storage all = groupMembers[group];
        for (uint256 i; i < all.length; ++i) {
            if (members[all[i]].token.totalSupply() != 0) {
                (,, bool needed) = target(all[i]);
                require(!needed);
            }
        }
        groupChecked[group] = sequence;
        emit GroupChecked(group, sequence);
    }

    function _action(uint256 id, Member storage m, uint8 kind, int256 amount) private {
        m.lastActionAt = uint64(block.timestamp);
        emit VenueAction(id, ++m.requestedAction, kind, amount);
    }

    function _fresh(Member storage m) private view {
        if (m.reportSequence == 0 || m.requestedAction != m.confirmedAction || block.timestamp - m.observedAt > MAX_AGE)
        {
            revert PendingOrStale();
        }
    }

    function _member(uint256 id) private view returns (Member storage m) {
        m = members[id];
        if (address(m.token) == address(0)) revert InvalidMember();
    }
}
