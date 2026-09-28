# deltaLP — public integration handoff

> September 28 fee revision: the replacement uses **3% entry / 6% exit**, split **50% Wizards / 50% four NFT collections**, weighted by mint tier. The v5 replacement receipt and all 100 members are deployed; the historical v3 addresses below retain their original 2%/4% policy. Use `4663-tokenized-v5.json` for new integrations. NFT mint proceeds now accumulate toward the pooled 2,000 USDG threshold; no creator seed inventory is required. See [replacement implementation and operator steps](REPLACEMENT-FEES.md).

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

- The v3 contracts and all 100 member tokens/custodies are deployed. The receipt
  family is configured for all 50 matched tiers.
- The website and public status endpoints are deployed.
- A funded deposit → venue execution → receipt activation → cash redemption
  lifecycle has **not yet been validated end to end**. Stable keeper operation
  remains a launch dependency.
- The public snapshot at block **74631306**, September 28, 2026 at **07:50:17 UTC**,
  showed closed entries, zero pending assets and zero receipt supply. Check the
  current endpoints before enabling any integration.
- The production native-ETH NFT funding adapter and four NFT collections are
  **not deployed**. Their contract integration exists, with remaining work below.
- Oil subscriptions remain a separate waitlist product.

Deployment and configuration are available integration milestones. They do not
establish funded trading readiness or proven investment performance.

## Canonical contract addresses

All addresses below are on Robinhood Chain, **4663**.

| Component | Address |
| --- | --- |
| DN receipt / NeutralVault | `0xe9AE3aEb63680960995978ee6c33E68B57c00688` |
| MemberController | `0xB8B04378E9291a735E9552f7a8a5593Bca6529FD` |
| MemberFactory | `0xe740806027CD13c0fA2c5181654b8FD5384b363B` |
| MemberV4Hook | `0x9715Cf2ec10ab69a40381550Bf58793FcD416540` |
| NeutralEscrowFactory | `0x5D021517AAD69E90a112a5987a59E54E0af87416` |
| HouseFeeRouter | `0xBfac70063f04e116F5a509cC746BEeb2F053467D` |
| Wizards 8,010-share fanout | `0x1b88A6c6516FD2918905186F21Bb9F5CaA1a15c8` |
| USDG — 6 decimals | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |
| Lighter L1 entry point | `0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d` |
| Uniswap v4 PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |

Public RPC: `https://rpc.mainnet.chain.robinhood.com`
Lighter API: `https://api.rh.lighter.xyz`
Lighter signing domain: **466324**, distinct from the EVM chain ID.

Use the deployment manifests and recorded runtime hashes to check contract
identity. The six core contracts and 200 token/custody children have matching
creation/runtime source on Sourcify. Etherscan submissions were still pending at
the last verification check.

## Source and read interfaces

Relevant repository paths:

- `evm/deployments/4663-tokenized-v3.json`
- `evm/deployments/4663-neutral-v3-registry.json`
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
fees. The deployed v5 vault and prepared NFT bundle passed local fork tests;
All 30 NFT deployment/configuration calls are confirmed; mints remain paused. See [NFT-EDITIONS.md](NFT-EDITIONS.md).

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
