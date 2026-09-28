# Tokenized Lighter members and V4 markets

Status: experimental core contracts deployed on Robinhood mainnet; **tokenized trading is not live**.
Deployment: [transaction and bytecode manifest](../evm/deployments/4663-tokenized-v1.json).
The controller has zero registered members and no funded accounts.
The site reads `/api/strategies/tokenized` to verify the four deployed runtime-code hashes.
All four have matching creation and runtime source on Sourcify; see the
[verification record](../evm/deployments/4663-tokenized-v1-sourcify.json).
Etherscan's separate verification submissions remain pending.

| Contract | Robinhood mainnet address |
| --- | --- |
| Controller | `0x5231bc96BfdDD9982c0464ECEcAEA640c9F70a08` |
| Member factory | `0xff73D192FCb5fFEb1E6E9316175a5d9f84d50247` |
| V4 activity hook | `0x72385de34b845bB5Ac3ea88df6d6D8B013b5a540` |
| Wizards fee router | `0xd28aD2F603D46e8081C9Df475ce2362d02601E11` |

These contracts do not upgrade the deployed NVDA/Morpho vault. The public trading UI
still accesses the visitor's own Lighter account and does not mint these tokens.

## Product and fee policy

A controller coordinates a family of strategy ERC20s for each underlying. A member
has one direction and leverage tier, its own backing ledger, and a separate
contract-owned Lighter account. Separate accounts keep opposite positions from
netting away at the venue. Tokens expose the opposite-direction members of their family.

Neutral allocation divides a deposit equally between long and short at every enabled,
matched tier. It does not silently drop a tier when the deposit is too small. This is
an allocation queue whose member claims now settle or cancel as one transaction. A failed
leg rolls back all issuance and fees. This does **not** make venue fills atomic or create
a neutral LP receipt.
Registry configuration must match actual venue leverage, precision and order-size limits;
the Solidity bounds alone are not a venue capability check.

| Operation | House fee | Recipient |
| --- | --- | --- |
| Settle a mint | 2% of gross USDG deposited | Homecoming 8,010-share fanout |
| Settle a redemption | 4% of gross USDG claim | Same fanout |
| Ordinary transfer / transferFrom | 0 | None |
| V4 swap / liquidity add / liquidity remove | No extra house tax from this hook | Pool swap fees follow V4 accounting |
| Cancel an unsettled primary request | 0 | Escrow returned to requester |

The fanout is fixed at `0x1b88A6c6516FD2918905186F21Bb9F5CaA1a15c8` on chain 4663.
Construction checks its `tokenCount() == 8010` and Homecoming collection identity.
The legacy 10,000-share pot is not a destination for these fees. Transfers fund the pot;
`harvest(token)` updates the fanout's distribution accounting. Claims stay in its existing
holder-claim mechanism. `HouseFeeRouter` additionally supports ETH-to-WETH routing and
permissionless flushing to that one destination; it has no owner or recipient setter.

Fees use integer floor rounding in USDG's six decimals. Mint and redeem minima are
checked against net output. With unchanged NAV, 100 USDG mints 98 USDG of backing;
redeeming that claim returns 94.08 USDG, with 5.92 USDG total sent to Wizards.

## V4 integration

`MemberV4Hook` attaches to ordinary V4 concentrated-liquidity pools. It neither replaces
the pricing curve nor takes a token delta. Anyone may register and initialize:

- Two genuine controller members with matching underlying, market and leverage,
  and opposite directions.
- One genuine member against an ERC20 quote such as USDG or WETH, or native ETH.

Pool creators choose the static swap fee and tick spacing. Different fee pools may
compete. This version deliberately has no dynamic-fee policy; it rejects the dynamic
flag and 100%-fee configurations. A permitted quote is not an endorsement of its issuer
or token mechanics. Fee-on-transfer/rebasing quotes require separate compatibility work.

Every member mint, burn, transfer and transferFrom increments the family's check sequence.
V4 uses flash accounting and ERC-6909 claims, so **not every swap causes an ERC20 transfer**.
The hook therefore also notifies the controller after swaps and liquidity changes.
No external trade or iteration through every holder runs inside the unlocked PoolManager.
The hook address must encode exactly `beforeInitialize`, `afterAddLiquidity`,
`afterRemoveLiquidity`, and `afterSwap` permissions (low 14 bits `0x2540`). Its constructor
validates those permissions. Only its immutable PoolManager may invoke callbacks.

Tests use Robinhood PoolManager `0x8366a39CC670B4001A1121B8F6A443A643e40951` on a local fork.
The dependency is pinned to official Uniswap v4-core tag `v4.0.0`, commit
`e50237c43811bd9b526eff40f26772152a42daba`. Test routers are Uniswap test helpers;
they are not production routers and must not be deployed as user-facing adapters.

## Accounting and venue actions

`MemberController` separates pending deposit escrow, each member's local cash,
reported venue equity, token supply, and actual confirmed position. Pending deposits
cannot fund another member's venue account. Donations do not change NAV or mint claims.
Redemptions cannot spend another member's cash. Existing shares at zero NAV block new
issuance rather than pricing new deposits against a depleted denominator.

The reporter is a **trusted valuation role**. Its evidence hash is an audit pointer,
not a proof of correct Lighter equity. Reports must have increasing sequences, the current
action nonce, the right position direction, and an observation no older than 60 seconds.
Mint/redeem settlement additionally requires a report observed at or after the request.

Venue deposits, withdrawals, order submissions and collected withdrawals advance an action
nonce and block pricing until reconciled. Each custody contract also records the end of
the actual L1 priority queue; reconciliation fails until the venue execution count reaches it. Withdrawal collection invalidates the old report
so the same assets cannot remain counted in both local cash and reported venue equity.
Lighter account binding checks the venue's actual L1 owner-to-account mapping.

Rebalance targets derive from NAV, leverage and mark, reduced proportionally for shares
queued for redemption. This lets the keeper close exposure before withdrawing cash.
Cancelling an exit restores its target without burning shares. Settlement cannot pay a
redemption that leaves exposure above the remaining backing target. Orders have a bounded
limit price. Increasing exposure also checks the reported initial margin fraction against
venue equity with 1% headroom. The L1 order method does not configure leverage: a default
2x venue margin setting must not be used to claim a functioning 3x/5x/10x strategy.
The L1 priority route can rest or partially fill: submission is never reported as a fill.
The reporter must establish executed transfers and reconciled fills/cancelled remainders
before unlocking pricing. These contracts do not independently prove that reconciliation.

## Neutrality and the source of returns

The intended advantage is market-making income with reduced underlying direction risk.
Matched labels alone do not establish neutrality. Calculate dollar delta from actual
confirmed positions, ownership fractions and current LP inventory. Pool inventory changes
after swaps; equal token counts may have different NAVs. `strategy/member-pairs.ts`
implements those exposure and fee calculations with integer arithmetic.

Equal opposing notionals in the same perpetual market largely cancel price P&L and funding.
They do not generate free funding yield. LP return must come from swap fees and any
separately substantiated revenue, less trading costs, inventory losses, gas and hedge costs.
More leverage tiers or arbitrage transactions do not by themselves prove a higher return.
Using WETH as a quote also introduces quote-asset exposure into that pool.

There is a specific volume hypothesis worth testing: with equal starting backing, an
underlying return `x` before leverage resets changes the relative member NAV price to
`(1 + L*x) / (1 - L*x)`. For small moves, its log return is approximately `2*L*x`, so local
relative-price variance scales as `4*L^2`. At 10x, a 1% upward underlying move makes the
long/short NAV ratio rise about 22.22%. This can create more repricing opportunities;
it does not determine realized swap volume or revenue. For comparison, a fee-free,
full-range constant-product pool repriced to those NAVs retains `sqrt(1 - (L*x)^2)` of
its starting value: about a 0.5013% loss in that example, before leverage resets.
Both legs must remain positive for this illustration. Concentrated ranges, live
rebalancing, funding, fee bands and trader demand require a richer model. The site's
interactive sensitivity table shows both amplification and the illustrative cost.

Entry and exit fees require approximately 6.2925% growth on the 98% invested backing just
to recover the original deposit. For a one-year hold, if backing grows by `r` after all
strategy costs but before the primary fees, investor return is `0.98 * (1 + r) * 0.96 - 1`.
No APY target, market-beating comparison, or no-liquidation claim has been established.

## Remaining work before a funded launch

- The hook currently requests a family check; it does not synchronously execute venue
  fills or the proposed cross-member supply/counterparty-clearing algorithm.
- Proportional rebasing of every balance and supply leaves proportional backing and
  external delta unchanged. A supply-adjustment rule needs explicit value-conservation,
  dilution and AMM-inventory accounting before implementation.
- Operate the reporter/keeper, including persistent action evidence, retry recovery and
  freshness monitoring. `strategy/member-reconciliation.ts` validates unsigned report
  candidates against account identity, exact amounts, priority execution, pending orders,
  market settings and an evidence watermark. It does not run a signing service.
- Complete contract-owned account bootstrap and margin configuration. No API key is
  currently installed for these accounts, and the custody ABI deliberately cannot
  register one. Default venue margin can therefore block higher target leverage.
- Complete independent mark validation, liquidity constraints and an emergency unwind
  policy. Integer sizing, order minimums and opening-margin headroom now have tests. Frequent rebalancing cannot guarantee
  that a venue position avoids liquidation during gaps or outages.
- Complete coordinated pending-leg recovery, neutral LP ownership/NAV/redemption, the
  supply-clearing rule, and production wallet/router integration. Atomic claim issuance
  and full-batch cancellation are implemented; matching-engine atomicity is not.
- Stress-test net returns under actual volume, spread, funding, adverse selection,
  price paths and execution delays. Validate with a reviewed, bounded funded round trip.

Unit/fuzz tests cover accounting conservation, fees, unauthorized calls, partial-fill
reconciliation, stale state and losses. Fork tests exercise real V4 swaps (including
ERC-6909-only settlement), WETH quotes, Lighter's L1 queue and the real Wizards fanout.
They do not prove live matching-engine execution or economic profitability.
The combined lifecycle test runs neutral claim issuance, actual V4 liquidity and a
swap, a simulated price move and venue rebalances, liquidity removal, position closes,
withdrawal reconciliation, redemption, and real fanout harvesting. It accounts for
V4's residual share dust rather than assuming every LP share can be recovered exactly.
Lighter fills in that test remain a model; it is not a live execution or persistent
delta-neutrality proof. A separate boundary case allocates and settles all 100 members
across 50 paired integer leverage tiers without omission.

Run from the repository root:

```sh
npm run build
npm test
forge test --root evm -vv
```

References: [V4 PoolManager and flash accounting](https://developers.uniswap.org/docs/protocols/v4/concepts/poolmanager),
[V4 hooks](https://developers.uniswap.org/docs/protocols/v4/concepts/hooks),
[Lighter order/transaction streams](https://apidocs.lighter.xyz/docs/websocket-reference).

## Deployment and operator commands

- `node evm/scripts/deploy-members.mjs`: simulate the first undeployed dependency.
- `node evm/scripts/deploy-members.mjs --broadcast`: resume the saved empty-core deployment.
  Does not create members, enable deposits, transfer USDG, trade or seed pools. Signed
  creation transactions are journaled under ignored `artifacts/` before broadcast.
- `ETHERSCAN_API_KEY=... node evm/scripts/verify-members.mjs`: submit source verification
  or check saved verification requests; the key is never saved in deployment manifests.
- `node --import tsx evm/scripts/plan-member-families.ts`: read the live venue registry and
  write unsigned creation calls for every supported integer ETH/NVDA/SPY leverage tier.
  The plan includes all tiers and an indicative equal-allocation minimum, before execution
  buffers. It does not create or enable any member.

The controller runtime is 17,494 bytes after extracting child creation into `MemberFactory`.
The V4 hook's deployed address has the required low bits `0x2540`. Source-verification
status is recorded separately from transaction success; a pending explorer job is not
reported as verified.
