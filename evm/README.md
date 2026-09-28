# dlp-evm — the same receipt on Robinhood Chain (4663)

`DlpVault` = tight-range **Uniswap v3** stock/USDG LP + **Morpho Blue** borrow hedge, one ERC‑20
receipt minted/burned at NAV, rebalanced as one object behind a phase machine. Solidity port of the
Solana vault (`dlp/`), same guards, same crank shape.

**Fork-tested against Robinhood Chain mainnet state** (real NVDA stock token, USDG, the live
NVDA/USDG 0.05 % v3 pool, Morpho Blue + AdaptiveCurveIRM, Chainlink RHNVDA/USD + USDG/USD):

```
deposit 10,000 USDG → 10,000 dlpNVDA
begin → hedge(+6,000 USDG collateral, borrow 10.96 NVDA)  health 1.52
swap: sell all NVDA → end() reverts DeltaTooLarge ✓ → buy back
place ±60 ticks (2,000 USDG + 10.95 NVDA) → end()  NAV 0.99975
withdraw 1,000 shares → 999.75 USDG ; over-withdraw → InsufficientIdleQuote ✓
weekend mode (real, stale Chainlink) → fair price = pool TWAP, mode=1, dev 0 bps ✓
begin → hedge(repay all by shares, withdraw collateral) → end()  flat
withdraw → user ends 99,997.31 of 100,000 USDG (−0.027 %, ≈ all the deliberate sell/buy-back)
```
`forge test --match-contract RobinhoodForkTest -vv` (≈16 s; the public RPC keeps ~2k blocks of
state, so the test pins to `latest`).

## What the recon says (docs/RECON-robinhood-chain.md, 1,200 lines, on-chain verified)

- **Aave, Compound v3, Euler, Fluid, Silo, Dolomite, Spark: not deployed.** Lending on 4663 is
  Morpho Blue (`0x9D53…1010`, 284 markets) and Morpho Midnight.
- Morpho markets are overwhelmingly *USDG‑loan / stock‑collateral* (Robinhood Earn). The mirror we
  need — **stock‑loan / USDG‑collateral** — exists for NVDA, SPY, AAPL, GOOGL, TSLA at 62.5 % LLTV,
  with **zero supply**. Nobody lends stock tokens yet. The hedge is mechanically live; the lending
  side is a product to bootstrap (idle stock tokens earn nothing on-chain today; the borrow rate
  from delta-neutral LPs is the securities-lending yield).
- **Perps**: Lighter RH (zk app-rollup, $95 M USDG in its 4663 custody contract, NVDA $5.6 M OI,
  SPY $49 M) — a contract can own the L1 account and use priority ops (`createOrder`,
  `cancelAllOrders`, `withdraw`) but fills are **asynchronous**. Arcus (dYdX-style, off-chain API)
  and Meridian are off-chain. Arcus pTokens are ERC‑4626 shorts but only for HOOD/GME/GLD/SPCX/BTC,
  no 1× NVDA/SPY short.
- **Uniswap v3 + v4** both deployed; stock liquidity is split (v3 deeper for NVDA/QQQ/GLD/GOOGL/AAPL,
  v4 deeper for SPY/META/TSLA/MSTR/PLTR). NVDA/USDG 0.05 % v3: $5.8 M TVL, ~$800 K per ±1 %.
- **Oracles go dark on weekends** (Chainlink equity feeds 24/5, no L2 sequencer feed, Pyth Core
  absent). The AMM is the only 24/7 stock mark ⇒ `FairPrice` = Chainlink when fresh, pool TWAP
  otherwise; Morpho liquidations use the frozen Friday price.
- **Issuer controls**: stock tokens are ERC‑8056 beacon proxies with a default‑open blocklist
  (contracts can hold them, evidenced by $58 M in the v4 PoolManager) — but `adminBurn`, pause and
  beacon upgrade are held by EOAs. That is issuer/censorship risk the receipt inherits.
- Nobody has shipped a hedged stock‑LP receipt on 4663 (Subway is pre-launch, SandCastle/MD LP
  deployed empty LP‑as‑collateral wrappers).

## Contracts

| file | what |
|---|---|
| `src/DlpVault.sol` | receipt ERC‑20, phase machine, NAV deposit/withdraw (same-block `sync()`), crank `begin/swap/hedge/place/end`, guards |
| `src/libraries/FairPrice.sol` | Chainlink→sqrtPriceX96 with TWAP fallback, deviation, base↔quote |
| `src/PairOracle.sol` | Morpho `IOracle` for a stock‑loan/USDG‑collateral market from two Chainlink USD feeds |
| `test/RobinhoodFork.t.sol` | the cycle above on a 4663 fork |

Addresses used (all [LIVE]): NVDA `0xd0601CE1…9EEC`, USDG `0x5fc5360D…d168`, pool
`0xd4EB2120…14a3`, NPM `0x73991a25…E0D3`, Morpho `0x9D53d5E3…1010`, IRM `0x2BD3d596…0fa1`,
feeds `0x379EC4f7…9F15` / `0x61B7e565…9aD2`.

## Guards (same as the Solana version)

same-block Sync for every user op · fair value at the oracle/TWAP, never the pool tick · delta
`|lpBase + idleBase − debt| ≤ max(eps·gross, dust)` · Morpho health
`collateral·price·lltv / debt ≥ minHealth` after every hedge op and at End · price-deviation flag
blocks deposits *and* withdrawals (NAV unreliable) · under-health blocks deposits only · swap
notional cap · optional per-epoch mint/burn caps · hedge op order add‑collateral → repay → borrow →
withdraw‑collateral.

## Not done

- Uniswap **v4** leg (PositionManager actions + unlock callback; needed for SPY/META/TSLA depth).
- **Lighter** hedge adapter (async: vault owns the L1 account, keeper API key trades, priority ops
  as fallback). The vault core already tolerates a lagging hedge via `eps`/health; the adapter is
  the missing file.
- Stock-lending vault (supply stock tokens to the Morpho stock‑loan markets) — the other half of
  the flywheel.
- Withdrawal queue; single rotatable crank; no session/weekend haircut on Morpho collateral
  (see Vigil in the recon for the pattern).

## Closed launch deployment

NVDA/USDG vault `0x32C47683D0E41DAc58A750fccb7200ad031D3993` is deployed on chain 4663,
with deposits disabled and no user funds. The source has an exact-match verification on
Sourcify. See [`deployments/4663.json`](deployments/4663.json) and
[the launch runbook](../docs/LAUNCH.md). Borrow liquidity was zero at deployment.

`scripts/preflight.mjs` checks dependencies and liquidity; `scripts/deploy.mjs` defaults
to gas simulation and requires `--broadcast` to deploy. Run both from the repository root.
Atomic `depositWithSync` / `withdrawWithSync` entry points support ordinary wallet transactions.
