# Open collection and minting

The four collections and v5 vault are deployed. Deployment alone does not enable paid minting or deposits.

## USDG deposits

At https://deltalp.fun, connect the current coordinator wallet. The DN panel displays **Enable deposits** when that wallet controls the vault and entries are closed. Confirm its zero-value `setEntriesOpen(true)` transaction. The vault itself checks configuration and fee-recipient readiness. This enables collection only; it does not start Lighter trading.

The 2,000 USDG threshold applies to allocation, not individual deposits. While collecting, each depositor can cancel and recover their USDG. An NFT mint contributes to the same eventual pooled activation through its contribution batch. Do not run manual coordinator transactions concurrently with the signing worker: they share an EOA nonce sequence.

## Four NFT sales

Run this yourself in an interactive terminal:

```sh
cd /Users/stacc/delta-LP
npm run nft:fly-launch
```

The launcher verifies deployed bytecode and ownership, obtains executable ETH/USDG quotes, and presents fixed ETH prices for the $1/$2/$5/$10 targets. It proposes a 30-day sale, 10,000 per-wallet limit (20 per transaction), 1% swap tolerance, and a 10% reference-rate drift bound. Review the printed values; they are not guarantees of dollar value. It saves `artifacts/keeper-v5/nft-launch-review.json` before asking you to type `OPEN MINT`. You can stop, edit that review, copy it to `config.json`, then relaunch. A positive lifetime gas budget is required and includes previously recorded v5 gas spending.

After your confirmation, the launcher stages the key and settings in Fly encrypted secrets and rolls the single worker. It configures four sales, refreshes five funding quotes, enables the adapter, then enables the four editions. Confirmed phases are observed before dependent transactions. This uses the existing v5 journal and persistent volume. No creator seed USDG or receipt tokens are required. The launcher does not buy an NFT.

The worker refreshes quotes with a ten-minute lifetime about five minutes before expiry. Capacity is at most the unsold NFT inventory's remaining 89% strategy allocation. Two actual pool quotes cover a one-NFT minimum and maximum $10 batch. Failed/stale quotes and reference-rate drift produce no replacement quote; mints stop when the previous quote expires. Prices remain fixed in ETH. Review and explicitly pause/reconfigure an existing sale if repricing is needed.

`nft:fly-launch` runs NFT-only operation. To enable actual DN allocation and trading as well, run `npm run keeper:fly-launch`, retain the saved NFT settings, and review its separate capital/order limits. It switches the same worker and journal to combined operation. Do not start a second keeper on another host. The existing v3 journal is not the v5 journal and must remain intact.

## Website and confirmation

The NFT panel reads the selected collection's pause flag, fixed price, supply, wallet limit, quote lifetime, and remaining funding capacity. A wallet mint simulates the real SeaDrop call before presenting a transaction. Unknown submissions remain in browser storage and require reconciliation by hash before another mint. No server key can buy on a visitor's behalf.

Minting directly on deltaLP uses the canonical SeaDrop contract and does not depend on OpenSea publishing a drop page. OpenSea indexing is separate from mint availability.

## Verification

`npx tsx --test tests/nft-sale.test.ts` validates phase ordering, amount rounding, capacity, mint gates, pinned call destinations and quote freshness. `node --import tsx nft/simulate-sale.ts` requires a local Anvil fork on 127.0.0.1:9557; it refuses remote execution and never loads a signing key.

The local-fork integration check mints all four editions through deployed SeaDrop, verifies actual USDG contributions in one shared escrow, transfers an NFT and recovers its cash with the new holder, rejects the former holder, accepts and refunds a 3 USDG direct vault deposit, and rejects an expired-quote mint without creating another NFT. These checks do not represent a paid mainnet mint or active mainnet trading.
