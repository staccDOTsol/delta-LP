# Pooled delta-neutral receipt

> September 28 fee revision: the replacement uses **3% entry / 6% exit**, split **50% Wizards / 50% seven NFT collections**, weighted by mint tier. The pinned live v3 addresses below retain their original 2%/4% policy until replacement. See [replacement implementation and operator steps](REPLACEMENT-FEES.md).

The ETH receipt vault is deployed on Robinhood Chain (4663) at
`0xe9AE3aEb63680960995978ee6c33E68B57c00688`. Its controller is
`0xB8B04378E9291a735E9552f7a8a5593Bca6529FD`. See the immutable
[deployment journal](../evm/deployments/4663-tokenized-v3.json) and the
[all-tier registry](../evm/deployments/4663-neutral-v3-registry.json).

Deployment is not evidence of a funded trading launch. Entries remain closed;
the operator must bootstrap the contract-owned Lighter accounts and operate the
reporter/keeper. The [keeper runbook](KEEPER.md) provides the implemented service,
read-only check and explicit owner startup procedure. The app reads these flags and balances directly from pinned
contract bytecode. No mainnet strategy collateral or order was submitted during
deployment. The oil subscription waitlist remains separate.

## What one entry does

1. The wallet approves the exact USDG amount if necessary, then calls `enter`.
   This is one application action and may require two wallet confirmations.
2. Cash remains separately accounted pending cash. It earns no LP fees and has
   no receipt yet. Only its payer can cancel during collection.
3. At the 2,000 USDG batch threshold the keeper starts one isolated allocation.
   The initial ETH family has every integer tier from 1 through 50, each with
   distinct long and short member tokens and custody contracts. Each paired leg
   receives an equal allocation; no small tier is silently omitted.
4. The controller atomically issues all member claims, charging the 2% entry fee.
   This does not establish that venue funding or orders have executed.
5. The operator funds and reconciles venue accounts, places bounded orders, and
   reconciles actual fills or cancelled remainders. Reports older than 60 seconds
   or accounts with unresolved controller actions cannot activate liquidity.
6. `activate` creates/adds actual full-range V4 liquidity in every paired pool.
   Pool prices must be near the member NAV ratio, position targets must be
   reconciled, and aggregate residual dollar delta must be at most 0.5% of NAV.
   The vault then mints one ERC-20 receipt to each depositor automatically.

Later epochs exclude pending cash and the new allocation escrow from existing
holders' NAV. New receipts are priced against the actual incremental value added
by activation. Existing shares are not rebased or arbitrarily diluted.

The vault accepts at most 32 distinct payers per pending epoch, bounding activation
gas. A full batch may still require participants to increase their deposits to
meet the threshold. There is no promised activation time. Individual receipt
minimums can stop activation; the payer may lower the minimum or recover claims.

The pair pools use a 0.3% swap fee and full-range ticks -887220 to 887220. Other
member/major V4 pools remain separately permissionless. Actual LP inventory,
uncollected pool fees, idle member claims, and reconciled venue exposure determine
the receipt's NAV and delta. The delta check is an activation condition, not a
promise that subsequent trades or price moves keep delta within that bound.

## Recovery and exits

- Before allocation, the payer can refund their cash without a house fee.
- Before member issuance, any participating payer can cancel the entire atomic
  batch. Each participant then has a full cash refund to the original payer.
- After issuance but before activation, each payer can recover their proportional
  member tokens or request USDG redemption through their own exit escrow.
- A receipt exit burns the requested shares and removes their proportional V4
  liquidity. It collects accrued pool fees and transfers the user's share of idle
  assets to an exit escrow. Pending entrants' cash is excluded.
- Member redemption requests are queued permissionlessly in bounded batches of
  at most 20 members, with long/short boundaries kept together. This avoids a
  transaction containing 100 redemptions. `queue` is resumable and visible in the UI.
- The keeper reduces venue positions, withdraws collateral, reconciles the result,
  and settles each member redemption. Only then can the escrow pay its recorded
  receiver. It charges 4% once on member redemption and on any local USDG that did
  not pass through a member redemption.
- The minimum USDG payout guards `finish`; it does not undo already-settled member
  redemptions or guarantee their execution prices. The owner may lower it or
  explicitly recover the available cash and unsettled claims in kind.
- A stalled reporter does not prevent removal of LP inventory and in-kind
  recovery. A fully cash-settled exit still depends on the venue and keeper.
  Expired unqueued requests can have their queue deadline extended; already-queued
  expired core requests must be recovered in kind and resubmitted.

All house fees go directly to the existing 8,010-share Wizards fanout at
`0x1b88A6c6516FD2918905186F21Bb9F5CaA1a15c8`. Ordinary member and receipt
transfers have no house transfer tax. Trades still pay their pool's swap fee.

## Leverage and valuation

The controller uses the reconciled venue initial margin setting, not an assumed
default. At the highest tier it permits at most a 2% reduction from nominal target
to maintain 1% collateral headroom and rounding allowance. A materially wrong
margin setting or insufficiently funded account remains blocked. Thus “50x” is
a target/up-to tier, not a guarantee of exactly 50.000x actual exposure.

Reports are trusted operator valuations, not cryptographic proofs of venue equity.
Activity requests a family check; it does not atomically fill an external order.
The keeper now checks controller action history, corresponding venue transactions,
account watermarks and actual positions. Independent mark validation, sustained
operation and funded matching-engine validation remain launch requirements.

## Verification

The September 28 suite passed 70 Solidity tests and 134 Node tests; 17 opt-in
database tests were skipped. The new receipt suite uses the real Robinhood V4
manager and fanout on a local fork at block 74587543, with simulated Lighter fills.
It covers receipt issuance, later-entry dilution protection, real V4 swaps,
mispriced-pool rejection, full/partial exits, pending-cash isolation, cancellation,
stale-reporter in-kind recovery, slippage rollback and all 50 paired tiers.

With all 50 tiers and the maximum 32 participants, measured activation used
30,082,448 EVM gas and an exit request used 16,350,090 gas. Redemption queue batches
were below 10 million gas. Actual chain gas estimation, transaction acceptance,
execution costs and economic outcomes remain separate from this fork benchmark.

The browser stores a public pending-transaction journal before wallet submission.
An ambiguous response blocks resubmission until its exact hash, sender, nonce,
destination and calldata are reconciled. Keys and wallet signatures are not stored.

Run `npm run check` and `cd evm && forge test -vv`. Source verification records
are next to the deployment journal. None of these tests establishes a profitable
APY or immunity from liquidation.
