# NFT launch integration — September28,2026

The user confirmed four editions ($1/$2/$5/$10),40,000 NFTs, and explicitly said
mint proceeds contribute toward the strategy's2,000USDG batch. They do not have
2,000USDG to prefund. The launch must work without a creator-funded receipt reserve.

## Assets are complete

All40,000 launch image/metadata pairs are published and verified. The publisher
checks every local PNG's CRCs/decompression and source hashes; every public
metadata body is fetched and hash-checked, every PNG checked for type/size, and
11full PNG downloads per edition hash-checked. Originals are unchanged.
`artifacts/nft-publication/editions.json` records completion and
`public/nft-editions.json` provides public catalog/provenance/preview URLs.
$20/$50/$100 remain local for possible later use and are excluded from the fee pool.

## Confirmed funding design

`DnPendingSeaDropEdition` routes mint proceeds through `DnPendingAdapter` into
real ETH/USDG swaps. `NftContributionBatch` credits actual USDG to each fixed
ERC6551account's contribution. It is pending cash, not invested DN shares.
Before queueing, the NFT account can withdraw its own contribution. An NFT
transfer changes who controls that same account and claim. Primary sale fees
already paid are not refunded by a pending-cash withdrawal.

One batch is one vault payer/receiver, avoiding the32depositor-per-epoch limit.
Permissionless queueing starts once the batch and existing vault pending assets
meet the collective threshold. New mints can use a fresh collecting escrow.
After activation, permissionless claims send real canonical receipts only to the
fixed NFT accounts. Cash refunds and in-kind recovery are separate outcomes;
24-hour timeout recovery and bounded member-asset claims preserve user ownership.
The adapter never creates an IOU and labels it canonical DN shares.

`contributedAssets(account)` is the contribution weight/history after settlement,
not proof of current pending cash. The UI must read batch.state and claimedAsset.

Primary split:10%OpenSea /1%Wizards /89%pending strategy cash. The strategy later
charges3%entry/6%exit, with house fees split50/50between Wizards and the fixed
four-edition NFT pool. Secondary royalty10%goes directly to Wizards. Ordinary
member transfers remain untaxed.

## Validation and deployment state

The pending adapter/collection has13passing local-fork tests:
`/tmp/delta-pending-nft-tests.log`. They prove first mint with ZERO DN supply;
actual SeaDrop/pool/USDG accounting; exact primary fees; pooling across editions;
withdrawal after ownership transfer; minimum/slippage atomic rollback;20-NFT
cash conservation and escrow rollover. The rollover transition mocks vault.entry;
actual batch lifecycle is tested separately. These are not mainnet venue trades.

Root reports8batch tests passing, including256-run conservation, one-payer
aggregation, refunded-cash detection, delayed cancellation and100-member recovery
in20-token pages. Root is fixing the vault's fee-aware activation loss bound and
will deploy the corrected empty receipt while reusing the100deployed members,
controller, hook and four-recipient fanout.

No NFT deployment calls were broadcast. Fanout remains unconfigured at
`0x5D38705D0c40c814CF2Eeb67d9ECD885cd9708FC`. The original atomic inventory-backed
30-call plan/simulation is archived as superseded; it must not be broadcast.
A new pending-mode plan requires the final corrected receipt address/hash and
must pass the complete local-fork simulation before root's sole signer submits it.
No competing signer, funded trade, capital deposit or paid mainnet mint is started
by this task. Network gas is distinct from strategy seed capital.

## Ownership and next steps

Root owns NftContributionBatch/tests, vault changes, keeper, website, shared RPC
configuration and the only deployment signer. This NFT task owns pending adapter,
collection, their tests, publication/deployment/verification tooling and these docs.

New prepare/simulate/verify scripts require launchMode:pending-contribution. The
CREATE2 namespace is deltaLP:nft:pending:v1:. The old mode is explicitly rejected.
Once the corrected vault is deployed: prepare actual plan, fork all configuration
calls, let root broadcast, then check live bytecode/configuration and source with
actual creation transaction hashes. Check OpenSea indexing/drop status separately.

Opening still needs fresh bounded USDG6-per-ETH swap quotes, actual fixed-wei mint
prices/schedule, clear pending/refund UI and operator activation. There is no
existing-share-inventory requirement. Actual venue investment/receipt issuance
requires its separate execution lifecycle once contributions reach the threshold.

See [the runbook](../nft/README.md) and [the fixed fanout interface](NFT-FANOUT-INTERFACE.md).
