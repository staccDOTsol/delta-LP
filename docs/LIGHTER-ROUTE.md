# Robinhood Lighter execution

The browser adapter replaces the homepage's non-executable order calculator for
directional ETH, NVDA, and SPY trades. Oil subscriptions remain a separate waitlist.
The existing Morpho vault is immutable and remains closed; this adapter does not
turn it into an ETH LP/perpetual vault.

## Source and network identity

- L1: Robinhood Chain **4663**, USDG with 6 decimals.
- Lighter signing domain: **466324**, API `https://api.rh.lighter.xyz`.
- Lighter contract: `0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d`.
- USDG: `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`; asset index **3**, perps route **0**.
- Official domain documentation: https://docs.robinhood.com/chain/lighter-domains/
- Official browser signer source: https://github.com/elliottech/lighter-ts
- Vendored WASM/runtime revision: `d0493ae8c3499e94c1810d1256f317a6bbff6c20`.
  `public/vendor/lighter/manifest.json` records SHA-256 digests and source paths.
  The browser verifies the WASM digest before initializing it. MIT notice retained.

`strategy/execution.ts` contains decimal/tick conversion, order planning and
receipt validation. `web/trading/client.ts` implements wallet/venue calls and
pending transaction recovery. `TradingPanel.tsx` renders the user's review step.

## User flow

1. Connect a browser wallet to Robinhood Chain. The in-app browser without a wallet
   provider shows instructions to open the site in a wallet browser.
2. Deposit the amount the user selects. Approval is limited to that amount. The
   exact deposit call is simulated before the wallet prompt. First deposit creates
   the Lighter account. An L1 receipt alone is not reported as credited collateral.
3. Authorize a browser trading key. A wallet signature derives a reproducible key;
   no seed, private key, signature, or auth token is saved in localStorage or sent to
   the deltaLP backend. Reconnect with the same wallet/domain to recover the key.
   API slot 42 is dedicated to this client; an occupied nonmatching slot is never
   overwritten. Revocation uses a separate wallet signature. Closing the page alone
   does **not** revoke the registered key; use the revoke control or Lighter UI.
4. Select long/short, market, leverage, and collateral input. Review sets isolated
   margin when needed, then reads a fresh book. 3× rounds conservatively to 3334
   basis points of initial margin. Sizing reserves 1% for fees and rounding.
5. Confirm the displayed order within 10 seconds. The actual signed order is a
   limit IOC with a 10 bps price bound, not an unbounded market order. Fractional
   tick quantities, stale quotes, foreign accounts, changed positions, and stale
   margin settings fail before send. User wallet/network is checked again.
6. Success requires a matching terminal order **and** the expected position.
   A submission acknowledgement or successful transaction alone is not a fill.
   Partial fills retain their actual residual exposure and cancel the remainder.
7. Review close signs the exact position size with `reduce_only`. It supports
   residual quantities below the minimum for opening a new position.
8. Once flat with no pending orders, request USDG withdrawal to the account owner's
   wallet. The UI distinguishes venue acceptance from final wallet settlement.

## Crash/retry behavior

A public pending transaction record is committed to localStorage before submission.
Web Locks prevent two tabs from submitting concurrently. After a timeout, a reload,
or a lost HTTP response, the client reconciles the original transaction hash and
client-order ID; it never re-signs or resends automatically. New orders are blocked
until the pending record resolves. Storage failure aborts before the network write.
Do not clear browser storage while a transaction is pending. If its state cannot be
reconciled, use the linked Lighter UI to inspect/cancel/close the position.

An L1 deposit whose wallet transport never returns a hash remains ambiguous and
blocks another deposit. Inspect the wallet transaction history before recovery;
do not blindly repeat the transfer. Withdrawal confirmation is asynchronous.

## Verification and current limits

Automated tests cover 3×/5×/10× sizing in both directions, precision, stale data,
account isolation, balances, quote expiry, partial fills, identity/price mismatch,
margin changes, storage failure, a lost response after acceptance, and restart
recovery without duplicate sends. Offline tests run the actual vendored WASM to
verify signed IOC/reduce-only fields, 3334 bps margin, USDG withdrawal units, and
separation between signing domains. No tests submit a real trade.

Public venue market reads and mobile rendering are checked separately. A funded
mainnet open/close/withdraw round trip remains unverified. These checks are not an
audit. The UI's initial collateral input is a sizing budget, not a guarantee that
funding fees, liquidation losses or venue-calculated margin can never exceed it.
Use a dedicated classic-mode master account; shared exposures, unified collateral,
and public pools require different risk accounting and are rejected by this version.

## Delta-neutral LP work still required

The existing NVDA/Morpho deployment cannot hot-switch its debt venue. An ETH LP hedge
requires separate custody and state accounting: authenticated Lighter equity, LP
inventory, funding/PnL, pending transfers, rebalance/timeout recovery and receipt
mint/redemption rules. A filled short on its own is not proof of a working neutral
LP strategy. The deployed vault remains closed and empty until that work is complete.
