# NFT-owned contributions and delta-neutral accounts

Status: the mint-funded implementation and the exact 30-call deployment bundle passed Robinhood fork tests. The corrected v5 DN vault and 100 members are deployed. All four NFT collections and their contribution adapter are deployed and configured, with mints paused. All 40,000 launch assets are published and URL-verified.

## Mint proceeds build the pool

The creator does **not** have to supply 2,000 USDG or donate existing DN receipts. Minting contributes toward the pooled activation threshold:

1. A buyer pays ETH through canonical SeaDrop. OpenSea receives 10% and the Wizards router receives 1% of the gross mint.
2. `DnPendingAdapter` swaps the remaining ETH to real USDG through the pinned Robinhood Uniswap v4 pool. A fresh bounded quote and per-NFT minimum protect this conversion; failure reverts the whole mint.
3. `NftContributionBatch` holds the USDG and records each NFT account's contribution. Multiple editions share the same collecting batch. Pending cash is **not** a DN receipt and earns no strategy fees.
4. Once batch contributions plus public vault deposits reach 2,000 USDG and vault entries are open, anyone may call `queue()`. The keeper plans this call when all members are idle; only explicit execution mode sends it. The whole NFT batch occupies one vault depositor slot.
5. The operator reconciles the venue positions, settles member issuance and creates the required liquidity. Only successful vault activation issues actual DN receipts.
6. Anyone may deliver each proportional receipt claim to its fixed NFT account. The current NFT owner controls that account.

The threshold is a pooled minimum allocation size, not a minimum individual mint and not a creator seed requirement. Reaching it alone does not prove trading has completed. Lighter execution remains asynchronous and requires the operating reporter/keeper.

## Four editions and ownership

There are 10,000 NFTs each at target mint prices of $1, $2, $5 and $10: 40,000 total. Dollar prices are targets; SeaDrop charges an ETH amount set for each stage. These are cartoon art editions, not currency or dollar redemption promises. The $20/$50/$100 source art is retained for a possible later release and receives no share of this launch's fee pool.

Every NFT has a deterministic ERC-6551 account on Robinhood Chain (4663), using the canonical registry `0x000000006551c19487814612e58FE06813775758` and Tokenbound AccountV3 `0x41C8f39463A868d3A88af00cd0fe7102F30E44eC`. Ownership and execution are tested against their actual deployed code.

Transferring the NFT transfers control of its account, its pending contribution and any assets held there. The creator cannot sweep those contributions. Before a batch is queued, the NFT account may withdraw its own pending USDG. After activation, it may manage or withdraw its actual receipts. Already paid OpenSea and Wizards mint fees are not refunded.

Buying an NFT does **not** guarantee its original contribution or holdings remain. The owner may already have withdrawn them or approved spenders. A purchase interface must inspect current account balances, contribution state and approvals. ERC-6551 alone does not enforce a buyer's minimum portfolio value.

## Fees

| Destination | Gross mint percentage | $10 target example |
| --- | ---: | ---: |
| OpenSea | 10% | $1.00 |
| Wizards primary fee | 1% | $0.10 |
| ETH converted toward pending USDG | 89% | $8.90 before swap costs |
| Strategy entry fee when allocated | 3% of contributed USDG | $0.267 before swap costs |
| Illustrative backing after allocation | 86.33% | $8.633 before swap costs |

The replacement member controller charges 3% entry / 6% exit. These house fees split 50/50 between Homecoming's 8,010 Wizard shares and the four NFT collections. NFT tier weights are 1/2/5/10 with total weight 180,000. Unminted IDs retain reserved entitlements; early holders do not divide the entire NFT half among themselves. Member transfers are untaxed and AMMs have their own swap fees.

The separate 1% primary mint fee and requested 10% secondary royalty go entirely to the existing Wizards router, which wraps native ETH to WETH for the fanout at `0x1b88A6c6516FD2918905186F21Bb9F5CaA1a15c8`. Secondary payment depends on marketplace enforcement. NFT resale is not a DN redemption.

## Recovery and settlement

`NftContributionBatch` has no owner or arbitrary sweep. Claims always pay the originally credited NFT account. Once queued, the funds are subject to the vault's allocation cycle. After a one-day recovery delay, anyone can recover a stalled batch: unallocated funds return as USDG; already issued member claims recover in kind. In-kind delivery is paginated, at most 20 member tokens per call. A cash refund cannot be mislabelled as successful DN activation.

The corrected v5 vault measures its activation loss bound after the 3% entry fee, allowing up to 1% additional execution loss. This fixes the old empty vault's incompatibility between a 3% entry charge and a gross 97% activation minimum. Receipt issuance still requires the position, price and delta checks.

## Deployment and activation

All 30 deployment/configuration transactions succeeded, using 0.000395971166982 ETH. The fee registry is permanently bound to the following four collections:

| Component | Robinhood address |
| --- | --- |
| Pending contribution adapter | `0x7518E5121A2841568dDE5A81eec8C962EcfCc0C5` |
| $1 collection | `0xa8dC97388FD0919A654bc05E21034afaafd1FF43` |
| $2 collection | `0x95fc6306d95F8264Ad6cc5336FB8df7e58BCbb7A` |
| $5 collection | `0xA09255F0D9cF94475369A962B3Df6Fd7ac926761` |
| $10 collection | `0xDa66c3e243D15813E6810c0370823A67b1497672` |

All five NFT/adapter contracts have matching creation and runtime source verification on Sourcify. All four collections are indexed on OpenSea; mint drops are not yet published, and Etherscan verification jobs remain queued. Actual transaction hashes and runtime hashes are in `evm/deployments/4663-nft-v5.json`. The canonical replacement receipt is `0x3D4Ee6D147AF67371073e74206D6d49e64960f9c`. It reuses the v4 controller, hook, fee router, factory and all 100 deployed members. See `evm/deployments/4663-tokenized-v5.json` and `4663-neutral-v5-registry.json`.

`nft/prepare-deployment.mjs --version=v5` produces the pending-contribution bundle. `evm/scripts/deploy-nft-bundle.mjs --version=v5` independently reconstructs every allowed zero-value deployment/configuration call and compares the fork simulation hash. The broadcast option deploys paused contracts; it never mints, transfers strategy collateral, opens a sale or trades. The superseded inventory adapter is retained only as historical code and is not used by this launch.

Before paid mints open, the operator must configure ETH stage prices/timing and wallet limits, supply fresh bounded swap quotes, and complete the marketplace checks. No prefunded receipt inventory is required. Vault entry/keeper activation is a separate operational step; the website must display pending contributions until actual allocation completes.

## Evidence and limits

- The complete Solidity suite passes 128 tests. The application build/runtime checks pass with 157 Node tests and 17 database integration tests skipped.
- Focused tests cover first mint with zero receipt supply, actual SeaDrop payment, USDG conservation, multiple editions sharing a batch, NFT transfer followed by the new owner's withdrawal, and rollback on quote/slippage failure.
- The exact prepared deployment was simulated as 30 successful calls. A second local-fork script then minted two editions through those exact contracts, checked their shared USDG escrow, and withdrew one NFT's contribution through its real ERC-6551 account.
- Root vault/batch tests cover proportional actual receipt delivery, cash refunds, stalled allocation recovery, paginated member claims and rounding conservation. Venue fills in these tests are fixtures; these are not funded mainnet trading results.

No APY, dollar peg or immunity to liquidation is implied. A running keeper, available liquidity and continuous reconciliation remain necessary.
