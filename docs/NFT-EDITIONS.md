# NFT-owned contributions and delta-neutral accounts

Status: the mint-funded implementation and the exact 30-call deployment bundle passed Robinhood fork tests. The v6 DN vault and 100 members are deployed. All four NFT collections and their contribution adapter are deployed and configured. At 10:35 UTC on September 28, the user-activated NFT sale worker was healthy, all four mints were open, and read-only live mint simulations passed. DN deposits were open with 0.93 USDG pending and zero receipts. All 40,000 launch assets are published and URL-verified.

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

The v6 vault measures its activation loss bound after the 3% entry fee, allowing up to 1% additional execution loss. This fixes the old empty vault's incompatibility between a 3% entry charge and a gross 97% activation minimum. Receipt issuance still requires the position, price and delta checks.

## Deployment and activation

All 30 deployment/configuration transactions succeeded, using 0.000525854666942 ETH. The fee registry is permanently bound to the following four collections:

| Component | Robinhood address |
| --- | --- |
| Pending contribution adapter | `0xE454667569852d99BeB0C19c7275fAbCc2874104` |
| $1 collection | `0x97E78A8aEEEb79076dBfbaBB23F016be7c354F41` |
| $2 collection | `0xd301a76601F27c682F64062b4A254fd7aed601Ea` |
| $5 collection | `0xa6D443b39fE77B8e1013482d300994cA84B5635C` |
| $10 collection | `0xcF07E0A91EDECCf9aA377BF8d451d50D8f998131` |

All four v6 collections are indexed on OpenSea. Studio recognizes their 10,000 supply and the replacement supports the actual `multiConfigure` transaction. Paid sale activation is complete; OpenSea marketplace drop publication remains unconfirmed and separate. The site offers direct SeaDrop minting. Source verification requests and confirmed matches are recorded in the deployment reports. See [the v6 replacement record](V6-REPLACEMENT.md) for canonical addresses, tests and operator steps.

Actual transaction/runtime hashes are in `evm/deployments/4663-nft-v6.json`; core and all 100 member pairs are in `4663-tokenized-v6.json` and `4663-neutral-v6-registry.json`. The old v5 vault retains its refundable 3 USDG user deposit; the site exposes its recovery controls.

The operator configured ETH stage prices/timing and wallet limits and activated fresh bounded swap quotes. The keeper must keep those quotes fresh; minting fails closed when they expire. Marketplace publication checks remain separate. No prefunded receipt inventory is required. Vault entry/keeper activation is a separate operational step; the website must display pending contributions until actual allocation completes.

## Evidence and limits

- The replacement NFT suite passes 56 Solidity tests, including ten Studio/migration tests. Application build/runtime checks pass with 168 Node tests and 17 database integration tests skipped.
- Focused tests cover first mint with zero receipt supply, actual SeaDrop payment, USDG conservation, multiple editions sharing a batch, NFT transfer followed by the new owner's withdrawal, and rollback on quote/slippage failure.
- The exact prepared deployment was simulated as 30 successful calls. A second local-fork script then minted all four editions through those exact contracts, checked their shared USDG escrow, and withdrew one NFT's contribution through its real ERC-6551 account.
- Root vault/batch tests cover proportional actual receipt delivery, cash refunds, stalled allocation recovery, paginated member claims and rounding conservation. Venue fills in these tests are fixtures; these are not funded mainnet trading results.

No APY, dollar peg or immunity to liquidation is implied. A running keeper, available liquidity and continuous reconciliation remain necessary.
