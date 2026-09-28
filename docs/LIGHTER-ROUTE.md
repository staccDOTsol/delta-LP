# Replacing the empty stock-borrow dependency

## Decision and evidence

The NVDA/USDG Morpho vault is deployed on Robinhood Chain, but both checked
NVDA-loan/USDG-collateral markets have zero available NVDA. This blocks a funded
borrow hedge unless a lender supplies the market. A deployed contract is not an
operating strategy.

Lighter's Robinhood instance is the next candidate for the hedge and separate
leveraged long/short products. It is a separate instance from Lighter Core, with its
own liquidity, contracts, and sequencer. Official integration documentation:
https://docs.robinhood.com/chain/lighter-domains/

At approximately 2026-09-28 03:57 UTC, its public order books showed about $1.7M
per side within 10 bps for ETH, $0.5M for SPY, and $0.2M for NVDA. These are transient
observations from at most 100 displayed levels, not guaranteed executable depth.
The homepage reads fresh data and does not use those snapshots as live prices.

Read-only sources:
- https://api.rh.lighter.xyz/api/v1/orderBookDetails
- https://api.rh.lighter.xyz/api/v1/orderBookOrders?market_id=0&limit=100
- SDK with a Robinhood endpoint profile: https://github.com/elliottech/lighter-python/tree/v1.1.4

## Implemented

- Live market identity, trading status, bid/ask, and depth checks for ETH, NVDA, SPY.
- 3×/5×/10× directional order-size estimates with integer amount arithmetic,
  venue precision/minimum checks, bounded price tolerance, and stale-quote rejection.
- Public on-chain state for the existing vault, including deposit gate, receipt
  supply, LP liquidity, and available NVDA borrowing supply.
- Explicit non-executable estimates. No backend signing key, API trading credential,
  or transaction submission is exposed by the web deployment.
- Oil-subscription signup, verification, points, and referrals remain a separate flow.

## Work required before execution

This is not a funded launch or an implemented Lighter adapter. Capital alone does
not remove the remaining engineering work:

1. Define and test account custody, signer permissions, funding and recovery.
   The existing vault has immutable Morpho dependencies and cannot switch venues.
2. Implement asynchronous hedge submission, partial-fill reconciliation, bounded
   unhedged exposure, timeouts, cancellation, and close/recovery flows. Submission
   acknowledgement must never be interpreted as a fill.
3. For LP receipts, account for on-chain LP inventory plus Lighter collateral,
   realized/unrealized PnL, funding, and pending transfers without double counting.
   Define how account state is authenticated before any NAV-based mint/redemption.
4. Implement and test keeper operation, margin/health controls, slippage limits,
   and exits, including unavailable API/sequencer and liquidation scenarios.
5. Obtain a concrete pilot capital limit, fund that amount, and verify open, resize,
   close, and withdrawal with real receipts before making a public execution claim.

A directional 3× long or short is not a delta-neutral position. Perp margin leverage
also is not automatically the same as total LP-strategy leverage. Product labels
must define their exposure denominator before execution is introduced.
