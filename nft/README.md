# Four-edition mint-proceeds-funded launch

The launch is $1/$2/$5/$10, each capped at 10,000 NFTs. Higher tiers are retained
locally and excluded from the fixed 180,000-weight fee pool. Run commands from
the repository root. Credentials stay in ignored environment files.

## Funding model

A mint does not need existing DN shares or an operator-funded reserve. The
`DnPendingSeaDropEdition` receives SeaDrop's creator payment, pays the fixed
Wizards portion, and passes the strategy portion to `DnPendingAdapter`. A bounded
ETH/USDG swap converts actual sale proceeds into USDG. `NftContributionBatch`
credits that cash to a claim controlled by each NFT's ERC-6551 account.

The initial state is **pending USDG contribution**, not invested DN shares. The
cash is held in the batch escrow, with its withdrawal/claim rights bound to the
NFT account. Transferring the NFT transfers control of that same account and its
rights. The current owner can withdraw their contribution before the batch queues;
the OpenSea/Wizards sale fees already paid are not refunded by that withdrawal.

Permissionless `queue()` aggregates contributions into one vault payer/receiver
when they and any existing pending vault deposits meet the strategy batch
threshold. The current 2,000 USDG threshold is a collective investment threshold,
not an upfront bill for the creator or a minimum per NFT buyer. New mints can
collect in a fresh escrow while the previous batch settles.

Actual canonical DN shares can be delivered to the fixed NFT accounts only after
vault activation produces them. Cash refunds and in-kind recovery remain distinct
outcomes; permissionless claim callers cannot redirect proceeds. The batch has a
24-hour recovery delay after queueing, and in-kind member claims are paginated.
No adapter-issued IOU is presented as canonical DN shares. Investment execution
and future NAV remain dependent on the venue/keeper, and receipt issuance is not
promised to happen within a fixed time or at a guaranteed return.

Primary fees remain 10% OpenSea / 1% Wizards / 89% pending strategy funding.
The strategy's 3% entry fee occurs later when invested; it is not charged again
as an extra tax on the pending cash credit. Secondary royalties remain 10% to
Wizards. Member 3%/6% house fees are split 50/50 between Wizards and the NFT pool.

The old `DnInventoryAdapter` and `DnSeaDropEdition` implement a different, atomic
inventory-backed design. They are retained as historical tested software and are
not the confirmed launch path. The old unsigned bundle is marked superseded;
its original plan/simulation are retained under
`artifacts/nft-deployment/superseded-inventory/` and must not be broadcast.

## Assets

All 40,000 launch image/metadata pairs have been published and verified. Original
art is read from `NFT_ART_ROOT` (default `/Users/stacc/10k`) without overwriting it.

```sh
NFT_UPLOAD_CONCURRENCY=96 node --env-file=.env.local nft/publish-assets.mjs
```

The publisher checks local PNG CRCs/decompression and source hashes, enforces
10,000 distinct trait combinations per edition, and uses versioned public paths.
Every public metadata body is fetched and hash-checked, every image is checked
for type/size, and eleven full image downloads per edition are hash-checked.
Token metadata uses extensionless IDs matching the collection's `tokenURI`.
Vercel Blob hosting requires the hosting account to remain available; provenance
and versioned URLs are not a promise of permanent decentralized storage.

Completed records are in `artifacts/nft-publication/editions.json`; the public
catalog is `public/nft-editions.json`. The append-only upload journal enables
resuming without overwriting immutable paths. Never remove a live publisher lock.

## Prepare, simulate and verify

The v5 bundle is deployed and paused. Source matches on Sourcify; all four
collections are indexed on OpenSea, with no published drop returned. See
`evm/deployments/4663-nft-v5-verification.json` and the remaining inputs in
[SALE-SETUP.md](SALE-SETUP.md). The preparation commands below document the tested
deployment; do not regenerate or redeploy the frozen bundle to open a sale.

For preparing a replacement deployment after its vault has been recorded:

```sh
node --env-file=.env.local nft/prepare-deployment.mjs --version=v5
```

Alternatively use `--target=path.json` with chainId4663 plus actual receipt and
weightedFanout addresses/runtime hashes. The tool checks deployed dependencies,
3%/6% fees, four-edition count/weight, the unconfigured fanout and its initializer.
It emits an explicit `launchMode: pending-contribution` plan containing zero-value
software/configuration calls for one pending adapter and four paused collections.
It configures metadata, provenance, adapter permissions and the permanent fee
registry. It includes no paid mint, financial deposit, trade or sale-opening call.

Start an isolated Anvil fork on loopback port9557, then run:

```sh
node nft/simulate-deployment.mjs
node nft/simulate-pending-mint.mjs
```

The script rejects remote endpoints, checks chain/client identity, simulates the
complete plan, and records plan/runtime hashes and configuration checks. The
impersonation balance is local test ETH only. Submit the reviewed bundle through
the deployment task's sole transaction writer; do not compete with the keeper.
The second script uses the actual simulated CREATE2 addresses to mint two editions
with zero DN supply, verify real USDG pooling, transfer one NFT and withdraw its
pending cash through the new owner's account. Those mint/withdrawal transactions
exist only on the isolated fork; their report is not evidence of mainnet sales.

After broadcast, save actual address-to-creation-tx hashes and run:

```sh
node --env-file=.env.local nft/verify-collections.mjs --transactions=path.json
node --env-file=.env.explorer.local nft/verify-explorer.mjs --version=v5
node --env-file=.env.local --env-file=.env.nft-opensea.local nft/check-opensea.mjs
```

Source verification compares live runtime with the tested fork and checks actual
configuration. Source submission is not confirmed verification. The OpenSea
check separately records indexing, actual collection URLs when returned, drop
state, pauses, vault supply and current batch contributions. An API 404 is not
indexed; authentication errors are not indexing proof. Temporary OpenSea keys
expire after seven days.

`verify-explorer.mjs` submits standard JSON and constructor arguments to Etherscan
using `ETHERSCAN_API_KEY` from the ignored environment file. It checks the
deployed plan hash and successful transactions, records accepted jobs separately
from confirmed verification, and never signs. The five current submissions are
queued; Sourcify source matching is complete.

Opening a pending-funded sale still requires fresh bounded swap quotes, fixed-wei
prices/schedule and per-wallet limits, clear pending/refund disclosures, and
operator activation. Quotes are USDG6 per ETH, not receipt-share units. Dollar
denominations are price targets rather than permanent ETH prices or dollar pegs.
OpenSea indexing/custom-drop compatibility is verified separately from SeaDrop
protocol compatibility. An indexed contract alone does not establish an open sale.
Use [sale-inputs.template.json](sale-inputs.template.json) for unsigned operator
values. Quote expiry/cap means a one-time opening cannot sustain a sale; an
ongoing owner-operated quote refresh process remains to be configured.
