# NFT integration status — resumed September 28, 2026

The user explicitly authorized publishing the assets, verifying metadata URLs,
finishing the production DN funding integration, and deploying/configuring seven
collections. The earlier publishing pause is revoked.

## Work completed in this task

- Validated all seven original editions: 10,000 PNG/SVG/JSON records and unique
  trait combinations in each, IDs 1–10,000, and 10,000 CSV rows per edition.
- Created a public Vercel Blob store linked to the delta-lp project. No source
  artwork or original metadata has been overwritten.
- Started the resumable publisher `nft/publish-assets.mjs`. It validates every
  PNG chunk CRC and decompression, computes SHA-256 provenance, publishes versioned
  PNG and extensionless metadata URLs, GET-checks every metadata body/hash and
  HEAD-checks every image size/type. Eleven image samples per edition are also
  fetched and hash-checked. Public metadata replaces placeholder IPFS URLs.
- Completed editions are recorded in `artifacts/nft-publication/editions.json`.
  Only those records have finished remote verification. The upload journal and
  source fingerprint files are under that same ignored directory.
- Built `DnInventoryAdapter`: a fixed, code-hash-pinned receipt reserve, actual
  ETH/USDG v4 swaps with minimum output, per-NFT receipt delivery, finite quote
  lifetime and aggregate native cap, live NAV/delta checks, and no principal
  withdrawal or arbitrary router calls. NFT backing is already-activated receipt
  inventory. Pending replenishment never counts as minted receipt inventory.
- Replenishment always uses the adapter as both payer and receiver. Refunds and
  recovery return only to that reserve. Seed donors do not receive an LP claim;
  they are donating protocol inventory, not depositing into a redeemable reserve.
- NFT fork tests cover the actual deployed SeaDrop, 6551 account implementation,
  WETH/Wizards routing, ETH/USDG pool and v3 receipt transfer implementation.
  Funded adapter cases explicitly seed synthetic local inventory and mock NAV;
  they do not establish mainnet venue fills or a funded live strategy.

## Updated fees and integration interface

See [NFT fanout interface](NFT-FANOUT-INTERFACE.md). Root reports the user's new
3%/6% policy, 50/50 house-fee split, and seven denomination-weighted NFT editions.
This task now implements WeightedNftFeeFanout with fixed 70k lifetime entitlements;
11 unit/fuzz tests pass. Root owns the split router and controller changes. Existing
v3 contracts remain immutable 2%/4%, entirely to Wizards.

The adapter constructor binds `(owner, NeutralVault, expectedVaultCodeHash)` and
reads the selected controller's actual entry rate. A replacement receipt address
and its verified hash are required before a new-policy deployment. The primary
NFT 10% OpenSea / 1% Wizards / 89% DN split and 10% all-Wizards secondary royalty
have not been silently changed. A newly split house router must not accidentally
split those specifically all-Wizards flows.

## Outstanding live dependencies

Current known canonical v3 receipt is
`0xe9AE3aEb63680960995978ee6c33E68B57c00688`, with runtime hash
`0xd0d6433e5c15da98889004c7ffa9d721077404567a5740e14523faaeaa646ab1`.
At the last independently read block 74635064 its receipt supply and pending
assets were zero and entries were closed. It is not an inventory source yet.

The core task owns venue execution, fresh reports and actual all-tier activation.
A funded receipt → redemption lifecycle is still not established by this task.
No capital was transferred, swap/trade executed, reserve seeded or paid mint
performed on mainnet here. Local-fork transactions are explicitly simulations.

The operator EOA is also used by the active keeper. This task is preparing
unsigned deployment/configuration calldata and is not creating a competing
signer, resetting nonces, clearing keeper journals, or starting another website
deployment. The collection deployment needs one coordinated transaction writer.

`nft/prepare-deployment.mjs` prepares empty, paused contracts only, and requires
all seven completed publication records. It must bind the final replacement fee
stack before broadcast; the current v3 defaults are not a new-policy launch.
The distribution ABI/mint hook, final deployment/source verification and OpenSea
publication remain to be connected. No sales should be described as open merely
because artwork or empty contracts have been published.

## RPC coordination

The supplied server RPC was added to production Vercel as sensitive and to the
local environment; it passed chain-ID 4663. The browser RPC also passed chain-ID
and site-origin CORS checks. Root now owns the shared RPC reader separation and
all remaining Vercel RPC configuration. Do not expose private endpoint values in
source, browser bundles, docs, exception messages or handoff text.
