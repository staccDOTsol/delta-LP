# deltaLP — public integration handoff

> Current deployment is **v6**: 3% entry / 6% exit, 50% Wizards / 50% four NFT collections weighted 1/2/5/10. Use [the current v6 addresses and operator record](V6-REPLACEMENT.md) and `4663-tokenized-v6.json` for integrations. Live NFT-sale activation and mint simulations were checked at 10:35 UTC on September 28; funded trading remains separate.

**Updated:** September 28, 2026
**Network:** Robinhood Chain, chain ID **4663**
**Website:** [deltalp.fun](https://deltalp.fun/)
**Source:** [staccDOTsol/delta-LP](https://github.com/staccDOTsol/delta-LP)
**Implementation branch:** `codex/fuel-platform`
**Pull request:** [#1](https://github.com/staccDOTsol/delta-LP/pull/1)

## What this stack provides

deltaLP represents individual leveraged long and short strategies as ERC-20
member tokens. Each member has isolated custody and its own Lighter account.
The initial ETH family contains **100 members**: a long and a short at every
integer leverage tier from **1× through 50×**.

A pooled delta-neutral vault allocates equally across those members, combines
matching long/short tokens in Uniswap v4 pools, and issues an ERC-20 receipt after
the positions and liquidity have been reconciled and activated.

The design gives directional traders individual exposure, liquidity providers
paired pools, and downstream applications a common receipt asset. Realized
returns depend on trading activity, LP inventory, funding, execution costs and
operating performance. Delta neutrality is a managed exposure target; it is not
a guarantee of profit or immunity from liquidation.

## Readiness

- The v6 contracts and all 100 member tokens/custodies are deployed, configured for 50 matched tiers. The website and public status endpoints use v6.
- The user activated the NFT sale worker on Fly. At 10:35 UTC on September 28, all four collections and the contribution adapter were unpaused, quotes were fresh, and one read-only mint simulation per edition passed. Simulations used a synthetic funded payer; no real paid mint was broadcast.
- DN entries are open. At block **74729779**, the vault held **0.93 / 2,000 USDG** pending and had zero receipts.
- A funded deposit → venue execution → receipt activation → cash redemption lifecycle has **not yet been validated end to end**. The current `nft-sale` worker does not run funded Lighter strategies.
- All four collections are indexed by OpenSea. Its drop API still returned 404 at the snapshot, so OpenSea checkout publication is not confirmed. Direct SeaDrop minting is available on the site.
- Oil subscriptions remain a separate waitlist product.

See `evm/deployments/4663-nft-v6-activation.json` for timestamped evidence. Recheck the live endpoints before integrating; activation does not establish investment performance.

## Canonical contract addresses

All addresses below are on Robinhood Chain, **4663**.

| Component | Address |
| --- | --- |
| DN receipt / NeutralVault | `0x19Bc982b4387c21e0D146b365e033dF5F14f6C85` |
| MemberController | `0xA79017035c9Fe045c797581321b6F36f554c55b2` |
| MemberFactory | `0x7cC2c4F5E3626D136D4Caa1476996F20E45E186b` |
| MemberV4Hook | `0xcA196659d69DA75F7ccDEBe5A913be1ae5D8e540` |
| NeutralEscrowFactory | `0x6Cd0FCA62Cd246dce867424214cd1EbDcb851EB6` |
| SplitHouseFeeRouter | `0x28E833384b720Ad0A428935cAe8d5b49fa62A1c0` |
| WeightedNftFeeFanout | `0x0D06A5981107629Fadf2e8104c9979afF78E9Dc6` |
| Wizards 8,010-share fanout | `0x1b88A6c6516FD2918905186F21Bb9F5CaA1a15c8` |
| USDG — 6 decimals | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |
| Lighter L1 entry point | `0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d` |
| Uniswap v4 PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |

Public RPC: `https://rpc.mainnet.chain.robinhood.com`
Lighter API: `https://api.rh.lighter.xyz`
Lighter signing domain: **466324**, distinct from the EVM chain ID.

Use the deployment manifests and recorded runtime hashes to check contract
identity. All 200 child source-verification submissions have been accepted by
Etherscan and remain queued at this snapshot. Sourcify confirmed 17 child matches
before intermittent service failures. Source status is recorded separately from
confirmed deployment receipts; queued does not mean verified.

## Source and read interfaces

Relevant repository paths:

- `evm/deployments/4663-tokenized-v6.json`
- `evm/deployments/4663-neutral-v6-registry.json`
- `strategy/member-deployment.ts` and `strategy/neutral-deployment.ts`
- `strategy/neutral-abi.ts` for receipt, allocation and exit interfaces
- `keeper/abi.ts` for controller interfaces
- `evm/src/tokenized/` for the deployed contracts
- `evm/src/nft/` for the NFT integration and adapter boundary

The [neutral status endpoint](https://deltalp.fun/api/strategies/neutral) returns
`{chainId, vaults}`. Each vault includes its address, block, observation time,
configuration, entry flag, epoch, phase, pending assets, batch minimum, receipt
supply, NAV, delta, gross exposure and allocation/activation status.

The [tokenized status endpoint](https://deltalp.fun/api/strategies/tokenized)
provides member-stack state. Monetary values are integer strings in the relevant
contract units. These endpoints report state; they do not execute transactions.

## Deposits, receipts and exits

1. A wallet approves USDG, then calls
   `enter(assets, minimumShares, receiver, deadline)`.
2. The vault records pending cash. A deposit does not immediately mint receipt
   tokens or establish an executed DN position.
3. Allocation begins at **2,000 USDG pooled per batch**, with at most **32 distinct
   payers** per epoch. Capital is split equally across all 100 members.
4. Member claims are issued, then their venue accounts are funded, orders are
   executed or cancelled, and actual positions are reconciled.
5. Successful activation adds the matching v4 liquidity and mints receipts.
   Activation checks positions, pool pricing, deposit minimums and residual delta.
6. Cash exits require queued member redemptions, position reductions, venue
   withdrawals and settlement. Recovery paths also support in-kind claims.

Pending cash is kept separate from existing receipt holders' NAV. Receipt value
depends on actual portfolio NAV and supply; one receipt is not promised to equal
one USDG.

The payer is `msg.sender`. Repeated deposits by one payer in an epoch must use the
same receiver. An adapter cannot simply call `enter` repeatedly with different
NFT account receivers from one payer.

Transfers and swaps request family checks. External venue execution is
asynchronous; an ERC-20 transfer does not guarantee a completed rebalance inside
the same transaction. Activation's delta bound does not guarantee that subsequent
market moves or swaps preserve that bound.

## Fees and Wizards

- **2% entry fee** at member claim issuance.
- **4% exit fee** at redemption, with exit accounting designed to avoid charging
  the same redeemed assets twice.
- House fees route to the **8,010-share Wizards fanout** listed above.
- Ordinary member and receipt transfers have no house transfer tax.
- The paired v4 pools use a **0.3% swap fee**. Other pools set their own swap fees.
- Native ETH routed through HouseFeeRouter is wrapped into WETH for the fanout.

Wizards participate through protocol fee revenue. Traders and receipt holders
retain their own economic exposure; their returns are not guaranteed by the fee
distribution. The legacy fanout pot is not the new fee destination.

## NFT / SeaDrop integration

The planned editions each contain 10,000 NFTs at target mint-price denominations
of $1, $2, $5 and $10. These are art denominations, not dollar
redemption promises. Each NFT controls an ERC-6551 account that owns its DN assets.

The accepted gross mint allocation is:

| Destination | Share of gross mint |
| --- | --- |
| OpenSea | 10% |
| Wizards mint fee | 1% |
| DN funding route | 89% |

The replacement 3% DN entry fee applies when the contributed USDG is allocated.
Before swap costs, illustrative backing is **86.33% of gross mint proceeds**. A separate
10% secondary royalty is designated to Wizards; payment depends on marketplace
enforcement. Reselling an NFT is not itself a DN redemption.

The pending-contribution adapter swaps net ETH to real USDG and credits each
NFT's fixed ERC-6551 account in `NftContributionBatch`. Multiple editions pool
these contributions toward the 2,000 USDG activation minimum. The creator does
not need to supply the capital or pre-existing receipt inventory.

The NFT account can withdraw its USDG before queueing. After allocation, actual
DN receipts can be claimed to the same account. Stalled allocations have cash
or in-kind recovery. Pending cash is not a DN position and earns no strategy
fees. The v6 vault and NFT bundle passed local fork tests; all 30 NFT
deployment/configuration calls are confirmed. The user subsequently activated
the NFT sale worker. See [NFT-EDITIONS.md](NFT-EDITIONS.md).

## NFT consumers and secondary markets

NFT holders can withdraw assets or approve spenders through their tokenbound
accounts. Buyers must inspect current account balances and permissions; original
mint backing is not guaranteed to remain present. Any promised minimum backing
needs a settlement check, not just an ERC-6551 ownership lookup.

Bridging an NFT does not automatically bridge its Robinhood receipt inventory or
synchronize account authority across chains. Chain, collection, token ID, account
implementation and asset location must be considered separately.

## Validation and remaining work

The source at `3eb3fd3` passed the production build, native Node ESM startup and
**141 Node tests**; 17 opt-in database tests were skipped. The prior contract suite
passed **70 Solidity unit/fuzz/fork tests**. The tests use actual deployed v4,
SeaDrop, ERC-6551 and fanout dependencies on local forks where relevant; venue
fills and the NFT funding adapter are simulated.

Remaining launch evidence includes stable keeper/reporting operation, funded
venue execution, cancellation and reconciliation, all-tier receipt activation,
and a completed cash redemption. Independent mark validation and sustained
100-account reporting throughput remain unproven. Arbitrary cross-member supply
clearing is not implemented.

Integrators can build readers, adapters and fork tests against the deployed
interfaces now. Enable funded consumer flows only after their actual dependencies
are validated. No APY, risk-free return or liquidation immunity is established.
