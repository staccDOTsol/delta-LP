# deltaLP dependency handoff

> September 28 fee revision: the replacement uses **3% entry / 6% exit**, split **50% Wizards / 50% seven NFT collections**, weighted by mint tier. The pinned live v3 addresses below retain their original 2%/4% policy until replacement. See [replacement implementation and operator steps](REPLACEMENT-FEES.md).

Prepared 2026-09-28, against `codex/fuel-platform` at `3eb3fd3` in
`/Users/stacc/delta-LP`. [PR #1](https://github.com/staccDOTsol/delta-LP/pull/1)
contains the implementation. This document is an integration handoff, not a
declaration that funded trading or NFT sales are ready.

## Current readiness

- The v3 contracts and all 100 ETH member tokens/custodies are deployed on
  Robinhood Chain, chain ID **4663**. The receipt family is configured for paired
  long/short exposure at every integer tier from 1 through 50.
- The site is deployed at [deltalp.fun](https://deltalp.fun/).
- At block **74631306**, observed 2026-09-28 **07:50:17 UTC**, the public receipt
  state showed `entriesOpen=false`, `phase=0`, `pendingAssets=0`, `totalSupply=0`,
  and `readyToActivate=false`. No funded receipt lifecycle is established.
- The owner activated the Fly worker. Startup logs at 07:49 UTC show
  `mode=execution`, followed by repeated `Another writer is using the keeper
  account` failures and process restarts. This is a nonce-guard failure; the log
  alone does not establish whether there is another writer or lagging RPC nonce
  visibility. A briefly passing health check is not proof of a stable worker.
- Fly app: `delta-lp-keeper`; Machine: `807d42cee2d348`; region: `yyz`; persistent
  volume: `vol_4y82kx6yx0x0p19r`, mounted at `/data`. The background worker needs
  no public HTTP service or public IP. The owner's rollout image is
  `sha256:71faf2564d6dbaa1c527e5fbf5197a7bbd5ba7d8d227f010e1b662758a9414f5`.
- The earlier [Fly deployment record](deployments/fly-keeper-2026-09-28.json)
  describes the initial observation deployment, not this later activation.
- Latest local validation: **141 Node tests pass**, 17 opt-in DB tests skipped;
  TypeScript/Vite build and native Node ESM startup pass. The prior contract suite
  passed 70 Solidity unit/fuzz/fork tests. Forked Lighter fills are simulated.

Re-read live status before enabling a dependent feature; the snapshot above is
dated evidence, not a permanent readiness flag.

## Canonical contracts and source

| Component | Robinhood Chain address |
| --- | --- |
| DN receipt / NeutralVault | `0xe9AE3aEb63680960995978ee6c33E68B57c00688` |
| MemberController | `0xB8B04378E9291a735E9552f7a8a5593Bca6529FD` |
| MemberFactory | `0xe740806027CD13c0fA2c5181654b8FD5384b363B` |
| MemberV4Hook | `0x9715Cf2ec10ab69a40381550Bf58793FcD416540` |
| NeutralEscrowFactory | `0x5D021517AAD69E90a112a5987a59E54E0af87416` |
| HouseFeeRouter | `0xBfac70063f04e116F5a509cC746BEeb2F053467D` |
| Wizards 8,010-share fanout | `0x1b88A6c6516FD2918905186F21Bb9F5CaA1a15c8` |
| USDG, 6 decimals | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |
| Lighter L1 entry point | `0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d` |
| Uniswap v4 PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |

- Public RPC: `https://rpc.mainnet.chain.robinhood.com`.
- Lighter API: `https://api.rh.lighter.xyz`; its signing domain is **466324**,
  distinct from the EVM chain ID. Do not use Ethereum's ordinary Lighter instance.
- Deployment manifests and runtime hashes:
  `evm/deployments/4663-tokenized-v3.json`,
  `evm/deployments/4663-neutral-v3-registry.json`,
  `strategy/member-deployment.ts`, `strategy/neutral-deployment.ts`.
- Receipt/allocation/exit ABIs: `strategy/neutral-abi.ts`; controller/operator
  ABIs: `keeper/abi.ts`; deployed source: `evm/src/tokenized/`.
- All six core contracts and 200 child token/custody contracts have matching
  creation/runtime source on Sourcify. Etherscan submissions were pending at the
  last verification check; do not relabel them verified there without checking.

## Read interfaces and receipt semantics

`GET https://deltalp.fun/api/strategies/neutral` returns `{chainId, vaults}`.
Each vault includes its address, block, observation time, configuration, entry
flag, epoch, phase, pending assets, batch minimum, receipt supply, NAV, delta,
gross exposure, allocation settlement and activation status. Monetary values
are integer strings in their contract units. `GET /api/strategies/tokenized`
provides the member-stack state. Neither endpoint is a transaction executor.

The receipt vault accepts USDG. `enter(assets, minimumShares, receiver, deadline)`
records **pending cash**, not immediately minted ERC-20 shares. USDG approval is
separate. A pooled batch requires **2,000 USDG**, with at most **32 distinct
payers** per epoch. Payer records are keyed by `msg.sender`; repeated deposits
from one payer in an epoch must use the same receiver. An NFT adapter cannot
simply call `enter` repeatedly with different tokenbound receivers.

The allocation gives equal capital to all 100 legs, issues the member claims,
then relies on reconciled venue funding, execution and V4 liquidity activation.
Only successful `activate` mints spendable receipt shares. Price receipts from
actual NAV and supply; do not assume one receipt equals one USDG. Cash redemption
is also a queued process. See [NEUTRAL-RECEIPT.md](NEUTRAL-RECEIPT.md) for refunds,
claim recovery, exit escrows and minimum-payout semantics.

House fees are **2% at member mint / 4% at redemption**, directed to the current
Wizards fanout through the house fee route. Member/receipt transfers are untaxed.
Paired V4 pools use a 0.3% swap fee. The legacy Wizards pot is not the new fee
destination. NFT resale is not automatically a DN redemption.

## NFT / SeaDrop consumer

The existing integration is in `evm/src/nft/`, `strategy/nft-editions.ts` and
[NFT-EDITIONS.md](NFT-EDITIONS.md). The seven collections and production native
ETH adapter are **not deployed**. The production adapter is still missing.
Tests use a named test double and do not establish native ETH conversion into
funded DN exposure.

`IDnMintAdapter` requires `receiptToken()`, `ready()`, and payable
`depositNative(receivers, assets, minShares)`. The collection requires actual
receipt balance increases at each ERC-6551 account in the same mint transaction.
The async vault cannot directly fulfill that interface on a fresh deposit.
An adapter needs already-backed receipt inventory/liquidity with exact settlement,
or a separately designed pending-deposit product with changed mint semantics.
Do not mint unbacked receipts or treat an order acknowledgment as receipt backing.

The accepted NFT mint split is 10% OpenSea, 1% Wizards, 89% to the DN route;
the DN entry fee applies inside that 89%. The 10% secondary royalty is designated
to Wizards; marketplace enforcement is separate. NFT holders control their
ERC-6551 accounts and can remove assets. Selling the NFT changes account control.

Latest art update from the NFT task: seven local folders under `/Users/stacc/10k/`
for 1, 2, 5, 10, 20, 50 and 100, each with 10,000 assets and metadata rows. Public
hosting, URL validation and provenance still need verification. Preserve these
folders. The earlier pause on publishing/mints is not lifted by this handoff.

## NFT tooling / arbitrage consumer

Treat these NFTs as accounts with a changing portfolio, not a fixed denomination
or guaranteed backing amount. Inspect actual account assets and permissions,
and bind any quoted minimum backing to settlement if that guarantee is offered.
ERC-6551 ownership alone does not enforce it. Bridging a collection does not
automatically bridge or synchronize its Robinhood receipt inventory.

Consume this as an integration reference for already-authorized tooling work;
it does not authorize live trades, collection listings or a new trading strategy.

## Operational ownership and remaining launch work

The reporter/keeper EOA is `0x26E8134eCC3af5cCE32f34B03E7BD2f318B25158`.
There must be a single transaction writer. Dependent agents should use public
readers and local/fork tests, without reusing its signing key, starting another
keeper, clearing journals, or changing immutable contracts. The current nonce
failure must be reconciled before declaring stable operations.

Source at `3eb3fd3` accepts scientific notation, grouped numbers and explicit
`unlimited` for the per-member equity ceiling. It retains separate order/gas
limits, exact integer parsing, and reductions above a finite capital cap.
[KEEPER.md](KEEPER.md) documents owner-operated activation and journal recovery.

Outstanding launch evidence: stable bootstrap and reporter/keeper operation,
venue funding, actual fills/cancellations, all-tier activation, proportional
receipt accounting and a completed cash exit. Independent mark validation and
sustained 100-account reporting throughput are also unproven. Arbitrary
cross-member supply clearing is not implemented. Rebalances use async venue
execution; no risk-free return, APY or liquidation immunity is established.

Integration agents can work on reader bindings, fork tests and the adapter design
while these dependencies are unresolved. Preserve other in-progress work in the
shared repository and use isolated checkouts for concurrent implementation.
