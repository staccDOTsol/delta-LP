# NFT integration status — September 28, 2026

The confirmed launch is four editions: $1/$2/$5/$10, each capped at 10,000 NFTs.
The fixed fee pool covers 40,000 IDs and total denomination weight 180,000.
$20/$50/$100 originals remain local for a possible later release; they are not
recipients of this launch's fee pool. Their upload was stopped without deleting
the partial journal or source files.

## Published assets

All 40,000 launch images and metadata are published and remotely verified.
`artifacts/nft-publication/editions.json` contains the four completed records;
`public/nft-editions.json` contains the public catalog, previews and provenance.

The publisher checks every local PNG's CRCs and decompression, source hashes,
and trait uniqueness. Every public metadata body is fetched and hash-checked;
every image is checked for size/type, with eleven downloaded hash samples per
edition. Source artwork and metadata remain unchanged. Public JSON uses actual
image URLs instead of placeholder IPFS paths. Hosting is versioned Vercel Blob,
not a claim of permanent decentralized storage.

## Contract state

The v4 core is deployed on Robinhood Chain (4663); actual transaction receipts
and runtime hashes are in `evm/deployments/4663-tokenized-v4.json`.

- NeutralVault: `0x385d37788a63a205df8044cf7cF6a59CC740159A`.
- Weighted NFT fanout: `0x5D38705D0c40c814CF2Eeb67d9ECD885cd9708FC`.
- Split controller: `0xae3600b13a2F894f81F6565DD207492601B2Ce3E`.
- Split router: `0x0264C6739483f80285B4e6ebd342B22b3785A9F0`.

Root confirmed 102 Solidity tests and 153 application tests passing, with 17
environment-dependent application tests skipped. The fanout includes 13 tests
for four-edition accounting, ownership, cumulative rounding, and conservation.
The adapter's 12 fork tests pass. Funded test cases use synthetic local inventory
and mocked NAV: they do not prove a funded production lifecycle.

`nft/prepare-deployment.mjs --version=v4` prepared the unsigned 30-call
four-collection deployment/configuration plan at
`artifacts/nft-deployment/unsigned.json`. Its complete isolated local fork
simulation PASSED: 30 successful calls, 17,699,482 gas, all four collections
configured and paused, final fee registry bound to the correct addresses.
The plan hash and expected runtime hashes are in
`artifacts/nft-deployment/fork-simulation.json`. Root has the bundle for its sole
mainnet transaction writer. No second signer is started by the NFT task.

The plan deploys one inventory adapter and four paused editions; it sets their
metadata, provenance, SeaDrop configuration and adapter permissions, then
permanently registers the four fee recipients. CREATE2 predictions alone are
not deployment proof. Both the adapter and collections remain paused.

## Economics and funding

Member entry/exit fees are 3%/6%, divided equally between Wizards and the weighted
NFT pool. See [the exact fanout interface](NFT-FANOUT-INTERFACE.md) for fixed
entitlements, unminted reserves, owner claims and rounding.

NFT primary allocation remains 10% OpenSea / 1% direct Wizards / 89% DN. The
3% DN entry fee inside that 89% leaves 86.33% of gross backing before conversion
and execution costs. Secondary royalty is 10% to direct Wizards. Those specific
Wizards-only flows use the existing direct router, not the split house router.

`DnInventoryAdapter` delivers already-activated vault receipts into each NFT's
ERC-6551 account. Its fixed ETH/USDG swap route, finite quotes and budget,
code-hash bindings, fresh NAV/delta checks and per-NFT minimum delivery checks
must all pass. Pending replenishment is not sellable receipt inventory.
Donating initial inventory gives no LP withdrawal claim. The reserve cannot
withdraw receipts already delivered to NFT accounts.

The prepared vault has zero receipt supply. Initial receipt inventory and a
validated funded venue lifecycle remain live dependencies. No capital transfer,
swap, trade, reserve seed or paid mint has been performed by this task.

## Verification and opening

After the software bundle is broadcast, save actual creation transaction hashes
and run `nft/verify-collections.mjs --transactions=path.json`. It checks live
bytecode against the successful fork, collection bindings and source verification.
Source submission alone is not confirmed verification.

Mint opening additionally needs actual inventory, fresh bounded quotes, exact
ETH sale prices/schedule and per-wallet limits, followed by operator activation.
OpenSea supports Robinhood Chain, but collection indexing and custom-drop
compatibility still require direct verification; SeaDrop configuration alone is
not evidence of an OpenSea listing or an open mint.

Root owns the shared website, RPC configuration, keeper and sole deployment
signer. Server RPC secrets must remain outside browser bundles and public docs.
