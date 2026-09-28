# Robinhood v6 replacement — 2026-09-28

The v6 deployment replaces the immutable v5 NFT and fee stack. The v5 NFTs lacked OpenSea Studio's `multiConfigure`; republishing their saved drafts cannot add that function. Local precedents were `nft-range/src/omni/OmniNft.sol`, `src/rh/RhMoneyGames.sol`, and the idempotent SeaDrop configuration fix in `nft-range` commit `85b9c0e`.

## On-chain configuration

- ETH 1–50×, both directions: 100 registered member tokens and custody contracts.
- Member fees: 3% mint / 6% redeem, no transfer tax.
- House fees: 50% Wizards, 50% four NFT editions, weights 1/2/5/10; 40,000 IDs and total weight 180,000.
- NFT primary mint: 10% OpenSea, 1% Wizards, 89% swaps into pooled USDG. Mint contributions build toward the collective 2,000 USDG threshold; no creator seed is required.
- Replacement contracts are configured but initially paused/closed. Deployment does not activate a sale or trading.

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

To activate paid mints, run `npm run nft:fly-launch` interactively from the updated repository. It verifies the v6 addresses/hashes, presents current fixed-ETH prices and swap bounds, and asks the operator to accept a lifetime gas budget. It starts only the NFT quote/sale service, not funded Lighter strategy execution. The wallet can enable refundable v6 deposits separately through the site's coordinator control. Use the new OpenSea collection pages above; old Studio drafts belong to v5. Studio payout must remain each new NFT contract itself.

Canonical manifests: `evm/deployments/4663-tokenized-v6.json`, `4663-neutral-v6-registry.json`, `4663-nft-v6.json`. Current application bindings and NFT runtime pins are generated together by `evm/scripts/publish-stack-bindings.mjs --version=v6` after chain checks. Do not run this initial-promotion tool again after accepting funds; it intentionally requires the new vault to be closed and empty.
