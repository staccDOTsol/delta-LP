# NFT-owned delta-neutral accounts

Status: collection integration implemented; not deployed, not accepting mints. The production native-ETH-to-DN receipt adapter is not implemented. Fork tests use a clearly named test adapter, so they do not establish live strategy execution or yield.

## Editions and ownership

Seven separate collections have 10,000 NFTs each: $1, $2, $5, $10, $20, $50 and $100 target mint prices. Total supply is 70,000. These are cartoon art editions, not currency or dollar redemption promises. The artwork job is separate; the existing `~/10k` collection must not be overwritten.

Every NFT has a deterministic ERC-6551 account on Robinhood Chain (4663). That account receives the DN receipt. The holder of the NFT controls the account; the creator and fee recipients do not own its strategy shares. Transferring the NFT changes account authority without moving the receipt balances. There is no NFT burn requirement and no permanent protocol ownership of backing.

The implementation uses the canonical registry (`0x000000006551c19487814612e58FE06813775758`) and directly delegates its ERC-1167 account to Tokenbound AccountV3 (`0x41C8f39463A868d3A88af00cd0fe7102F30E44eC`). It does not introduce a second upgradeable AccountProxy or require an initialization transaction. Account ownership and execution through this composition are covered against actual deployed code in fork tests.

An owner can withdraw assets or approve spenders. Buying the NFT therefore does **not** guarantee that its original backing is still present. A production purchase UI must read current account balances, permissions and outstanding approvals. Binding a purchase to a minimum balance/account state requires an additional marketplace settlement check; ERC-6551 alone does not provide that. Direct transfers into an NFT's own account are rejected, but arbitrary indirect ownership cycles are not exhaustively prevented.

## Revised fee split

The user accepted OpenSea's primary fee after the original 1%/99% proposal. The implemented split of **gross mint proceeds** is:

| Destination | Gross percentage | Example: $100 target mint |
|---|---:|---:|
| OpenSea | 10% | $10 |
| Wizards mint fee | 1% | $1 |
| DN funding route | 89% | $89 |
| DN entry fee, taken from the preceding 89% | 2.67% | $2.67 |
| DN backing before swap costs | 86.33% | $86.33 |

The replacement policy is 3% DN entry / 6% DN exit, pending deployment. Its house fees split 50/50 between Wizards and the seven NFT collections, weighted 1/2/5/10/20/50/100 by mint tier. Including the separate 1% primary fee, Wizards receive 2.335% of gross mint in this illustration; the NFT distributor receives 1.335%. The existing v3 contracts still use 2%/4% until the replacement is deployed. Actual strategy conversion, receipt units, rounding and costs must be quoted by the production adapter. NFT resale itself is not a DN redemption. Member-token transfers remain untaxed; AMMs choose their own swap fees.

The secondary royalty is 10% of the sale price, designated entirely to the Wizards fee router. ERC-2981 specifies a requested royalty; it does not force every marketplace to pay. ERC-721C/Seaport enforcement and OpenSea publication are separate launch work, not claimed complete here.

Wizards means the 8,010-share fanout at `0x1b88A6c6516FD2918905186F21Bb9F5CaA1a15c8`. Its native ETH rejection is handled by `HouseFeeRouter`, which wraps ETH into WETH. ERC-20 royalties sent to that router can be permissionlessly flushed only to the same fanout. The old 10,000-share pot is not the new fee destination.

## Atomic mint settlement

`DnSeaDropEdition` is a public-stage SeaDrop-compatible ERC-721 with a fixed 10,000 cap, batch limit 20, fixed primary recipients and fixed royalty policy. It has no administrator mint, principal withdrawal or adapter replacement. Metadata is frozen after the first mint.

1. Configure the canonical SeaDrop contract (`0x00005EA00Ac477B1030CE78506496e8C2dE24bf5`) with 1,000 fee bps and its sole allowed recipient, OpenSea (`0x0000a26b00c1F0DF003000390027140000fAa719`). The creator payout is the collection itself.
2. SeaDrop calls `mintSeaDrop`. The collection reserves supply, deploys the bound accounts and mints NFTs. Pending settlement blocks NFT transfers and configuration changes.
3. SeaDrop sends its 10% fee, then sends the remaining ETH to the collection.
4. The collection checks the exact payout against the recorded gross mint, sends 1% of gross to the Wizards router and routes the remainder through its immutable `IDnMintAdapter`.
5. Each account must receive its own minimum number of actual receipt tokens, checked through balance changes. An expired execution quote, unavailable adapter, missing receiver funds, or failed conversion reverts the entire mint, including fees and account creation in that transaction.

SeaDrop rounds its fee down. The collection also rounds the Wizards mint fee down, then splits the remaining wei across accounts as evenly as possible. It leaves no ordinary mint proceeds stranded in the collection. Alternate allowlist, signed and token-gated stages are deliberately disabled because their independent fee/price parameters are not part of this accounting path.

The owner may pause mints, configure public-stage timing, and update future prices while paused. An execution quote has a maximum 30-minute lifetime and specifies the minimum receipt units per ETH after entry fees. A nonzero quote and an adapter reporting ready are necessary checks, not independent proof of DN solvency. The actual adapter and receipt implementation must be validated before deployment.

## Remaining production work

- A pooled native-ETH DN adapter with bounded swaps, actual matched exposure, redeemable basket receipts, fee accounting and a tested unwind. Small NFTs must hold proportional pooled shares; $0.89 cannot independently open every leverage pair above venue order minimums.
- Reconcile Lighter execution and liquidity before issuing spendable DN shares. The collection's atomic receipt delivery does not make Lighter orders synchronously fill. Use already-backed liquidity or a separately disclosed pending-deposit product; never label pending cash an executed DN position.
- Validate the account implementation/dependency code hashes in deployment tooling; finish asset-aware NFT purchase checks, account UI, and marketplace royalty configuration.
- Finalize all seven art folders, upload durable metadata, record provenance, and choose ETH prices and sale schedule. SeaDrop stores fixed wei per stage; USD face values are targets and move with ETH/USD until repriced. `nftEditionQuote` rejects stale quote inputs but is not an oracle.
- Deploy seven reviewed collections with the actual immutable adapter/receipt, verify source, publish through OpenSea, and test its real mint transaction against a fork before opening sales.

No funded mainnet trade or NFT mint was performed for this integration. No APY, immunity to liquidation, or dollar peg is implied.

## Verification

`forge test --match-path 'test/nft/*.t.sol' -vv` exercises the actual Robinhood SeaDrop, ERC-6551 registry, Tokenbound AccountV3, WETH and Wizards fanout on a local fork. The adapter is a test double. Tests cover splits, per-account funding, transfer of ownership, old-owner rejection, failure rollback, partial receipt rejection, quote expiry, fixed fee destinations, cap, mint callback ordering, native royalties, metadata freeze, and fuzzed wei conservation.

`node --import tsx --test tests/nft-editions.test.ts` checks the seven editions, revised split, price/batch bounds, rounding and stale ETH/USD quote rejection.

References: [ERC-6551](https://eips.ethereum.org/EIPS/eip-6551), [Tokenbound deployments](https://docs.tokenbound.org/contracts/deployments), [SeaDrop](https://docs.opensea.io/docs/seadrop), [OpenSea primary fees](https://support.opensea.io/en/articles/8867057-set-your-drop-earnings), [creator-fee enforcement](https://docs.opensea.io/docs/creator-fee-enforcement).
