# Four-edition publication and deployment

Run commands from the repository root. Original art is read from the four
denomination folders under `NFT_ART_ROOT` (default `/Users/stacc/10k`). The scripts
never overwrite those originals. Credentials come from ignored environment files.

## Publish

```sh
NFT_UPLOAD_CONCURRENCY=96 node --env-file=.env.local nft/publish-assets.mjs
```

The publisher checks every PNG's chunk CRCs and decompression, hashes original
PNG/JSON bytes, and enforces 10,000 distinct trait combinations per edition.
It writes public images and JSON metadata into versioned paths. Token metadata
uses extensionless decimal IDs because the collection's `tokenURI` appends the
ID to `baseURI`. No random Blob suffix is added and overwrites are rejected.

Every token metadata body is fetched publicly and hash-checked; every referenced
PNG is HEAD-checked for type and size. Eleven image samples per edition are also
downloaded and hash-checked. This is not a claim that every remote PNG was fully
downloaded. The original local PNG hashes and exact URLs are in each public
manifest. Blob hosting still requires its account/storage to remain available;
versioned paths and provenance hashes are not a promise of permanent IPFS storage.

`artifacts/nft-publication/editions.json` contains only completed, verified editions.
`uploaded.jsonl` is an append-only resume journal. An interrupted upload checks
content at an already-existing immutable path rather than overwriting it.
Completed editions retain their original verification time when resumed.
Do not remove `publisher.lock` while its PID is alive.

## Prepare the paused collections

After the replacement stack exists and all four publications finish:

```sh
node --env-file=.env.local nft/prepare-deployment.mjs --version=v4
```

Alternatively, `--target=path.json` accepts:

```json
{
  "chainId": 4663,
  "receipt": {"address": "ACTUAL_ADDRESS", "runtimeCodeHash": "ACTUAL_HASH"},
  "weightedFanout": {"address": "ACTUAL_ADDRESS", "runtimeCodeHash": "ACTUAL_HASH"}
}
```

Placeholders are not deployable targets. The builder reads and pins actual
code, checks the 3%/6% policy and fanout, and requires the unconfigured fanout's
initializer to be the collection operator. It keeps the separate Wizards-only
router for the NFT's 1% primary fee and 10% secondary royalty.

The resulting `artifacts/nft-deployment/unsigned.json` contains only zero-value
CREATE2 deployment/configuration calldata: one receipt-inventory adapter, four
10,000-piece collections, metadata, provenance, adapter permissions and one-time
registration of the four addresses. Both adapter and collections remain paused.
It contains no seed deposit, trade, approval, mint, or sale-opening call.

## Verify on a local fork, then on chain

Start an isolated Anvil fork on loopback port 9557 and run:

```sh
node nft/simulate-deployment.mjs
```

The simulation script rejects non-loopback endpoints and checks Anvil/chain
identity before impersonation. It runs the complete plan and checks actual
configuration, metadata, source-derived runtime hashes and finalized fanout order.
The simulated balance is local test ETH only.

After the operator's single transaction writer broadcasts the reviewed software
plan, save an address-to-creation-transaction-hash JSON mapping and run:

```sh
node --env-file=.env.local nft/verify-collections.mjs --transactions=path.json
```

This matches runtime against the successful fork simulation, checks collection
bindings, and submits source to Sourcify. Run again to read verification results;
submission is not verification. Do not use a second signing process alongside
the keeper EOA.

## Funding and sales are separate

`DnInventoryAdapter` sells existing activated receipts. A donor must understand
that `donateInventory` contributes irrevocable protocol inventory; it creates no
LP withdrawal claim. No user-held NFT receipts can be pulled back by the reserve.

Sale ETH is exchanged on the fixed native ETH/USDG v4 pool. The selected receipt's
live NAV/supply determines output, bounded by the collection's minimum receipt
quote, the adapter's USDG minimum, receipt-price cap, inventory balance, finite
15-minute quote and aggregate native sales budget. The controller's entry fee is
reserved in the quote and is paid only upon later replenishment issuance. This
does not levy a second receipt transfer tax.

Replenishment queues cash with one fixed adapter payer/receiver. The queued cash
does not increase sellable inventory. Vault activation must mint real receipts
before those receipts can support another NFT sale. Reserve price/execution losses
can exhaust capacity and close minting; constant capital availability is not
promised. Initial inventory and a validated funded venue lifecycle are still live
launch dependencies.

Opening requires actual inventory, fresh bounded quotes, explicit fixed-wei
SeaDrop prices/schedule and per-wallet limits, followed by operator unpausing.
Dollar denominations are targets, not permanently fixed ETH prices or redemption
guarantees. OpenSea indexing/custom mint compatibility and royalty enforcement
must be verified separately from protocol-compatible contract deployment.

The fixed 40k fee entitlement policy, current-owner claims and unminted reserves
are documented in [NFT-FANOUT-INTERFACE](../docs/NFT-FANOUT-INTERFACE.md).

The $20/$50/$100 art is retained locally for a possible later release. Those
editions are not registered recipients in this launch and cannot dilute its
fixed 180,000-weight denominator. The partial $20 upload journal is retained; no
higher-tier collection has been configured by this task.
