# Robinhood v6 replacement — 2026-09-28

The v6 deployment replaces the immutable v5 NFT and fee stack. The v5 NFTs lacked OpenSea Studio's `multiConfigure`; republishing their saved drafts cannot add that function. Local precedents were `nft-range/src/omni/OmniNft.sol`, `src/rh/RhMoneyGames.sol`, and the idempotent SeaDrop configuration fix in `nft-range` commit `85b9c0e`.

## On-chain configuration

- ETH 1–50×, both directions: 100 registered member tokens and custody contracts.
- Member fees: 3% mint / 6% redeem, no transfer tax.
- House fees: 50% Wizards, 50% four NFT editions, weights 1/2/5/10; 40,000 IDs and total weight 180,000.
- NFT primary mint: 10% OpenSea, 1% Wizards, 89% swaps into pooled USDG. Mint contributions build toward the collective 2,000 USDG threshold; no creator seed is required.
- Deployed initially paused/closed. The user subsequently activated the NFT sale worker and enabled DN deposits; current status is recorded below. Funded strategy execution remains separate.

| Component | Address |
| --- | --- |
| WeightedNftFeeFanout | [0x0D06A5981107629Fadf2e8104c9979afF78E9Dc6](https://robin.etherscan.io/address/0x0D06A5981107629Fadf2e8104c9979afF78E9Dc6#code) |
| SplitHouseFeeRouter | [0x28E833384b720Ad0A428935cAe8d5b49fa62A1c0](https://robin.etherscan.io/address/0x28E833384b720Ad0A428935cAe8d5b49fa62A1c0#code) |
| SplitFeeMemberController | [0xA79017035c9Fe045c797581321b6F36f554c55b2](https://robin.etherscan.io/address/0xA79017035c9Fe045c797581321b6F36f554c55b2#code) |
| NeutralVault | [0x19Bc982b4387c21e0D146b365e033dF5F14f6C85](https://robin.etherscan.io/address/0x19Bc982b4387c21e0D146b365e033dF5F14f6C85#code) |
| NFT contribution adapter | 0xE454667569852d99BeB0C19c7275fAbCc2874104 |
| $1 edition | [0x97E78A8aEEEb79076dBfbaBB23F016be7c354F41](https://opensea.io/collection/money-doubler-1-265020144) |
| $2 edition | [0xd301a76601F27c682F64062b4A254fd7aed601Ea](https://opensea.io/collection/money-doubler-2-658160246) |
| $5 edition | [0xa6D443b39fE77B8e1013482d300994cA84B5635C](https://opensea.io/collection/money-doubler-5-638625887) |
| $10 edition | [0xcF07E0A91EDECCf9aA377BF8d451d50D8f998131](https://opensea.io/collection/money-doubler-10-411012397) |

## Activation snapshot — September 28, 2026, 10:35 UTC

The user completed `npm run nft:fly-launch`. Fly machine `807d42cee2d348` is healthy in `execution` / `nft-sale` mode, maintaining fresh swap quotes. All four editions and the contribution adapter are unpaused. The production site shows **Mint open**; read-only `eth_call` simulations of one mint in each edition passed with a synthetic payer balance override. No paid mint was broadcast by these checks.

DN entries are also open: block `74729779` shows 0.93 / 2,000 USDG pending and zero receipts. This worker runs the NFT sale only; funded Lighter execution and receipt activation remain separate. OpenSea indexes all four collections, but its drop API still returns 404, so marketplace checkout publication is not confirmed. Direct minting is available at [deltalp.fun/#nft-editions](https://deltalp.fun/#nft-editions).

Public evidence: `evm/deployments/4663-nft-v6-activation.json`. The initial deployment manifests retain their original paused/empty snapshot labels; they are not live status feeds.

## Verification

- All 30 NFT deployment/configuration transactions confirmed; runtime hashes match the simulated bundle. The fee registry was finalized with the new addresses and cannot be changed.
- All four editions indexed by OpenSea; each emitted `MaxSupplyUpdated(10000)` at creation. An indexed collection is not a published drop.
- 56 NFT Solidity tests pass, including ten Studio/migration regressions: actual captured unsigned Studio payload, repeat configuration, public/signed mint accounting, stale quotes, fixed fees and v5 deposit refund.
- The actual v6 CREATE2 bundle passed a local fork mint of each edition with zero DN receipt inventory. Each NFT received real fork USDG credit in the same contribution escrow; after NFT transfer, its new owner successfully withdrew the pending cash.
- Application check: 168 passed, 17 database-dependent tests skipped. No production mint or trade was executed by these tests.
- Etherscan and Sourcify submission/confirmation states are recorded separately in deployment JSON; a pending submission is not verified source.

## Existing deposit and operator migration

The user's 3 USDG stays in v5 vault `0x3D4Ee6D147AF67371073e74206D6d49e64960f9c`. The site exposes **Recover funds from the previous vault → Connect wallet → Cancel & refund**. Recovery uses pinned v5 bytecode/controller; this client rejects new entries to that vault. Nothing was moved automatically.

The worker uses `/data/keeper-v6`; the v5 journal remains preserved. The former worker stopped because another confirmed transaction advanced its owner nonce outside its journal. Never run the deployment signer and execution worker concurrently. Observation mode does not sign and may run during inspection. Reusing an old journal without reconciling transactions is not a nonce repair.

The user activated paid mints with `npm run nft:fly-launch` from the updated repository. No repeat launch is needed while the worker is healthy. For a future operator restart, the same interactive launcher is available. It verifies the v6 addresses/hashes, presents current fixed-ETH prices and swap bounds, and asks the operator to accept a lifetime gas budget. It starts only the NFT quote/sale service, not funded Lighter strategy execution. The wallet can enable refundable v6 deposits separately through the site's coordinator control. Use the new OpenSea collection pages above; old Studio drafts belong to v5. Studio payout must remain each new NFT contract itself.

Canonical manifests: `evm/deployments/4663-tokenized-v6.json`, `4663-neutral-v6-registry.json`, `4663-nft-v6.json`. Current application bindings and NFT runtime pins are generated together by `evm/scripts/publish-stack-bindings.mjs --version=v6` after chain checks. Do not run this initial-promotion tool again after accepting funds; it intentionally requires the new vault to be closed and empty.

## Source-verification retries

Sourcify returned 500/503, timeouts and rate limits during this deployment. Successful matches and accepted jobs are preserved in `4663-neutral-v6-sourcify.json`; partial failures do not invalidate confirmed on-chain receipts. The Etherscan fallback validates each recorded creation argument and live runtime hash before submission:

```sh
node --env-file=.env.explorer.local evm/scripts/verify-neutral-members-explorer.mjs --version=v6 --submit-only
```

`--submit-only` preserves accepted jobs and retries only missing/failed submissions. Omit it to check accepted jobs. `pending` means queued, never verified. API credentials stay in the ignored environment file.
