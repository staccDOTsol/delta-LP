# Robinhood Chain (4663) — recon dossier for a delta-neutral tokenized-stock LP vault

Snapshot: 2026-09-26 04:55–05:30 UTC, blocks ≈ 72,814,000 – 72,828,000 (Saturday; US equity markets closed since Fri 20:00 ET).
Every number carries a tag:

- **[LIVE]**: read on-chain via `eth_call`, `eth_getCode`, `eth_getStorageAt` or `eth_getLogs` (block given where it matters). **[LIVE-L1]** means read on Ethereum mainnet (publicnode).
- **[DOCS]**: taken from documentation or an official registry (named inline).
- **[UNVERIFIED]**: from an off-chain API, an aggregator (DefiLlama) or a news source, or inferred. The source is named inline, e.g. `[UNVERIFIED: Lighter API]`. Off-chain venue APIs were read live, but those numbers are not on-chain state.

Method notes. I enumerated Uniswap v3 `PoolCreated` (436,362 pools) and v4 `Initialize` (895,598 pools) from block 0 through the official RPC. That RPC caps a query at 10,000 matched logs and times out after about 2.4 s, so the scan split ranges adaptively. The RPC serves logs from genesis but only recent state, so every state read is at `latest`. I read state through Multicall3 `0xcA11…CA11` (bulk reads were routed to `robinhood-rpc.publicnode.com`). Scripts `01_…`–`18_…` and `99_build_tables.py`, plus every JSON dump, are in `/home/claude/evm/recon/`, indexed in §10.

---

## 0. Findings that shape the build

1. **No on-chain source of stock borrow liquidity exists.** Morpho Blue has 18 markets whose *loan* asset is a stock token. Twelve hold 0 supply; the other six hold dust (≤0.052 SPCX, supplied by "ORBIT Develop" test vaults) [LIVE]. No other lending venue on 4663 lets you borrow a stock token. Aave, Compound v3, Euler v2, Fluid, Silo, Dolomite and SparkLend are not deployed (§1.5). A "borrow the stock" hedge means seeding your own Morpho stock-loan market, i.e. becoming the lender of last resort to yourself.
2. **Short exposure lives on perps that are matched off-chain.** The perp venues are:
   - **Lighter RH**: a zk app-rollup whose L1 contract is on Robinhood Chain, holding $95.2M USDG [LIVE]. It has 57 perps with $217.6M OI, SPY $48.9M and QQQ $35.5M [UNVERIFIED: Lighter API], and 0% fees.
   - **Arcus**: a dYdX-Labs hybrid CLOB with an appchain and custody on 4663. It lists 36 online RWA perps (30 equities, 2 indices, 4 commodities) with $7.4M RWA OI [UNVERIFIED: Arcus API].
   - **Meridian**: off-chain matching, mPerps on SPY and QQQ.

   Lighter is the only one where a contract can hold custody *and* place orders through a documented on-chain entrypoint. The implementation exposes L1 priority ops `deposit`, `createOrder(uint48,uint16,uint48,uint32,uint8,uint8)`, `cancelAllOrders`, `withdraw`, `changePubKey` and `performDesert`, with `PRIORITY_EXPIRATION = 1,209,600` [LIVE]. So a vault can be the L1 owner of its Lighter account, delegate a trade-only API key to a keeper, and keep an on-chain fallback path. That path is asynchronous, not atomic. Arcus's docs mention on-chain "forced trades" and "forced withdrawals" only as escape paths; normal trading goes through its Ed25519-signed API [DOCS].
3. **The only composable ERC-20 shorts are Arcus pTokens.** These are ERC-4626 over a managed perp account, denominated in USDG. Shorts exist only for HOOD 3x, GME 5x, GLD 5x, SPCX 3x/5x and BTC 1x/3x, with total NAV ≈ $0.66M [LIVE]. There is **no 1x short on SPY, QQQ, NVDA or TSLA.**
4. **Stock liquidity is split across v3 and v4 and is thin relative to TVL.** Deepest pools by ±1% depth (min side) [LIVE @ 72,827,502]:
   - v4 SPY/USDG 0.30%: $845K
   - v3 NVDA/USDG 0.05%: $798K
   - v3 SGOV/USDG 0.30%: $753K
   - v4 META/USDG 0.30%: $377K
   - v3 SPCX/USDG 0.05%: $275K
   - v3 GLD/USDG 0.30%: $220K
   - v3 QQQ/USDG 0.05%: $176K

   Most names have less than $100K per 1%. v3 is deeper for NVDA, SPCX, GLD, QQQ, GOOGL, AAPL, MU, MSFT and AMZN. v4 is deeper for SPY, META, TSLA, MSTR, PLTR, COIN, AMD, INTC and TSM (§3.4).
5. **The oracles go dark on weekends while the AMM keeps trading.**
   - The 35 Chainlink "Robinhood X / USD" feeds cover only 35 of the 204 stock tokens. They are 24/5, 8 decimals, 86,400 s heartbeat and 0.5% deviation. They carry no weekend heartbeat, and at read time they were 5–13 h stale going into a roughly 49–52 h weekend gap [LIVE] [DOCS].
   - Chainlink publishes no L2 sequencer-uptime feed for 4663 [DOCS].
   - Pyth Core is not deployed; only the Pyth Pro (Lazer) verifier is [LIVE] [DOCS].
   - API3 has six dAPIs and none cover equities. Stork is deployed but idle [LIVE].

   On weekends the only live stock marks are AMM pools and perp marks, and the perp marks are banded around Friday's VWAP (§4, §2).
6. **Issuer controls reach into any vault that holds stock tokens.**
   - `adminBurn(from, amount)` can burn any holder's balance and ignores pause and blocklist checks.
   - Beacon upgrades, the registry-wide pause and the blocklist are all held by **EOAs** [LIVE].
   - The blocklist is checked on `msg.sender`, `from` and `to`.
   - `oraclePaused()` is advisory: it freezes Chainlink during corporate actions.

   Treat all of this as issuer-credit and censorship risk in the vault's accounting (§5).
7. **The same product is already being built, but nothing is live.** EthWiz/**Subway** is designed as `xAMC`, an LP vault token, plus `hAMC`, which hedges on Lighter RH with the vault as L1 account owner. Its README says "Status: pre-launch research and contracts. Nothing is deployed". It issued a NO-GO on its first three pairs and found 18 names hedgeable. SandCastle and "MD LP" deployed LP-NFT-as-Morpho-collateral wrappers with "borrow SPY" markets, but they hold 0 supply. Vigil (testnet only) and Fables (live) handle session and weekend risk on the lending and fee side. **No live hedged LP receipt on stock tokens exists on 4663** (§8).

---

## 1. Lending / borrow venues

### 1.1 Morpho Blue — core

| item | value |
|---|---|
| Morpho Blue | `0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010` (15,582 B) [LIVE] [DOCS: docs.morpho.org/addresses] |
| owner / feeRecipient | owner `0x060595638692de6ccd47ca04094f1772d3d39728` [LIVE] |
| enabled IRMs | `0x0` and AdaptiveCurveIRM `0x2BD3d5965B26B51814AC95127B2b80dD6CcC0fa1` [LIVE: EnableIrm logs] |
| enabled LLTVs | 0, 0.385, 0.625, 0.77, 0.86, 0.915, 0.945, 0.965, 0.98 [LIVE: EnableLltv logs] |
| markets | 284 (`CreateMarket`, 0 new after block 72.70M) [LIVE] |
| MorphoChainlinkOracleV2Factory | `0xB7c16F6F8cF531447Bf27Ca7220f981E79C9cdF2`: 139 of 274 market oracles were created by it [LIVE] |
| VaultV2Factory | `0x0FBad98595b0186dA120E41f77C102beb49f803c` [LIVE][DOCS] |
| MorphoVaultV1AdapterFactory / MarketV1AdapterV2Factory | `0x7a91222F3f7B927bB8fb624593Ca86e111C2F85e` / `0x79370Ed003CE325C088E530d5e8655c99c2993e1` [LIVE][DOCS] |
| MorphoRegistry / PublicAllocator | `0xe785a2eFD384BA7B95BaEd3851BC76aeD67C676f` / `0xCe5c1aFa115fF8b1D6913509bfc79D9AE08CC857` [LIVE][DOCS] |
| Bundler3 / GeneralAdapter1 / VaultBundlesV1 | `0x6478e9393d4C5bB4d53ee881d1DE78786A0344a6` / `0xc5E188541D107e8B79e43478bDE365F1406665D6` / `0xcC108538f36242D6E0d6B9255f6D9Ccd137D70Fe` [LIVE][DOCS] |
| Midnight (fixed-rate) | `0x6120765Ba5336150BbdDdD0Cd9108B5bFD369632` (24,557 B) [LIVE][DOCS] |
| MetaMorpho (Vault V1) | **none**: the Morpho API returns 0 V1 vaults for chainId 4663, and the docs list no V1 factory for Robinhood [UNVERIFIED: Morpho API] [DOCS] |

### 1.2 Stock tokens as the LOAN asset (the short-hedge leg) [LIVE @ 72,823,935]

The borrow APY below is `AdaptiveCurveIRM.borrowRateView(params, market)`, annualized as exp(r·31,536,000)−1.

| market id | loan (borrowable) | collateral | LLTV | totalSupply (loan units) | totalBorrow | borrow APY (IRM) | oracle |
|---|---|---|---|---|---|---|---|
| `0xcdf90684ec73e9d5…` | SPCX | ORBIT | 0.915 | 0.049750 | 0.000000 | 0.96% | `0x637d549068c710c785a8d4c8ac6959fbe1453b3f` |
| `0x0cb0e9f9b4cd699d…` | SPCX | ORBIT | 0.915 | 0.015000 | 0.000000 | 0.84% | `0xbcdfa190ca410a8d5b71569a535e443ca9a5ec46` |
| `0x45cac3271bc6e316…` | SPCX | ORBIT | 0.915 | 0.001100 | 0.001100 | 17.68% | `0x17c387b17209c2e556d215c1dfb59617ff7df00a` |
| `0x6955094172d56779…` | SPCX | ORBIT | 0.860 | 0.000100 | 0.000000 | 0.95% | `0x17c387b17209c2e556d215c1dfb59617ff7df00a` |
| `0x58b028b9bcfc7190…` | SPCX | ORBIT | 0.915 | 0.000100 | 0.000000 | 0.99% | `0x501d37ba2e304a1f0ec02ad36f56e50bc3b840a9` |
| `0x8ae0668aca2f306a…` | SPCX | ORBIT | 0.625 | 0.000000 | 0.000000 | 0.80% | `0x675c839ae324e7e4fac1c17742b88c01f1a0a12c` |
| `0x2fdd5af0a36ab059…` | NVDA | USDG | 0.625 | 0.000000 | 0.000000 | 0.28% | `0x548196c5a7d2127ae69fbc69e2fed9686fdd7a10` |
| `0xf670348a152ced94…` | SPY | USDG | 0.625 | 0.000000 | 0.000000 | 0.28% | `0x0ca840cdaf5aa6066817ccd31ca2cc7647991135` |
| `0xb257b94f5fc1b69d…` | AAPL | USDG | 0.625 | 0.000000 | 0.000000 | 0.28% | `0x7bf2558fbc0f48d54ba9a4f55d09a3d258024125` |
| `0x9d4ceedfeead12af…` | GOOGL | USDG | 0.625 | 0.000000 | 0.000000 | 0.28% | `0xd3f293f4e093f4a9f764647ff4651644881d7d04` |
| `0x85f86f26ef02da6c…` | TSLA | USDG | 0.625 | 0.000000 | 0.000000 | 0.28% | `0x2050739e0ce165451246455943b113c900d53d77` |
| `0xfa02b9d58bb338ea…` | NVDA | USDG | 0.625 | 0.000000 | 0.000000 | 0.38% | `0x2e72230da46b888bb71d419d4e194577e43bf881` |
| `0xdfc64ba716c6b04a…` | TSLA | USDG | 0.625 | 0.000000 | 0.000000 | 0.38% | `0x3d28890c7c929c996bfb1ff581aee503986274b0` |
| `0xc6e0b157b9b0719c…` | SPY | scV4-SPY-QQQ-S | 0.770 | 0.000000 | 0.000000 | 0.63% | `0x33c12509a4c02bd4e9195fc55a3dbd2a1936b6e8` |
| `0x05d8328220ee076e…` | SPY | scV4-SPY-NVDA-S | 0.770 | 0.000000 | 0.000000 | 0.63% | `0x784427d1d95c15e005d3a5656f5b2cf8ad9859f7` |
| `0xea3d01844f641e5b…` | SPY | scV4-SPY-TSM-S | 0.770 | 0.000000 | 0.000000 | 0.63% | `0x895a94d387cf0d8d8dc3e0d6d99d5f9583781a79` |
| `0x6bdcf8f419b92c34…` | SPY | scV3-WETH-SPY-S | 0.625 | 0.000000 | 0.000000 | 0.63% | `0xb8fdfc1e751dd3b682b5332d10e084f4ecbf6a51` |
| `0x839d006743b3ee9d…` | SPY | scV3-SPY-USDG-S | 0.770 | 0.000000 | 0.000000 | 0.63% | `0x6408602e126d4e71a2a942e3705f666611d67721` |

- All 18 markets exist, but 12 have **0 supply**. The other six are SPCX-loan / ORBIT-collateral dust markets. They are supplied only by "ORBIT Develop SPCX" VaultV2 adapters: `0x83321d68…`, `0xdec836b6…`, `0x011d47f5…`, `0x9bdee14c…`, `0x31a6fabd…`, `0x37d4f179…` [LIVE: Supply logs].
- The NVDA, SPY, AAPL, GOOGL and TSLA loan markets with USDG collateral at 62.5% LLTV exist with custom, unverified oracles (1,932 B and 535 B), but nobody has supplied stock to them.
- SandCastle created five "borrow SPY against an LP token" markets: collateral `scV3-SPY-USDG-S`, `scV4-SPY-QQQ-S`, `scV4-SPY-NVDA-S`, `scV4-SPY-TSM-S` and `scV3-WETH-SPY-S`. In these the oracle is the collateral token itself (`price()`). Supply is 0 and the tokens' `totalSupply` is 0 (§8).

### 1.3 Stock tokens as COLLATERAL [LIVE @ 72,823,935]

Stock-collateral markets: 170 in total, 83 with supply > 0. The loan asset is USDG in 166 and WETH in 4.

Top 28 by supply:

| market id | collateral | loan | LLTV | supply (loan) | borrow | util | borrow APY | supply APY | oracle | oracle wiring |
|---|---|---|---|---|---|---|---|---|---|---|
| `0x9b4b47cdf7e29534…` | SPCX | USDG | 0.625 | 279,955 | 222 | 0.1% | 0.44% | 0.00% | `0x872f9d8955b34e841227a92de755cd63042ab7a5` | custom (NetNet-style, baseFeed/quoteFeed + oraclePaused guard) |
| `0xdeb4782d012d5fd3…` | AAPL | USDG | 0.625 | 238,959 | 28 | 0.0% | 0.35% | 0.00% | `0xd625d488d552775d2867194c618b945e5ddfe097` | custom (NetNet-style, baseFeed/quoteFeed + oraclePaused guard) |
| `0x7fa81b10e5d21b2e…` | GOOGL | USDG | 0.625 | 158,808 | 1 | 0.0% | 0.44% | 0.00% | `0x12ec3474d1e321e0aab065278b97fbc7eda5f424` | custom (NetNet-style, baseFeed/quoteFeed + oraclePaused guard) |
| `0x8b16891f032a93b7…` | NVDA | USDG | 0.625 | 99,941 | 902 | 0.9% | 0.41% | 0.00% | `0xed29d310cfa91778a5850538da28ed42234cb78c` | custom (NetNet-style, baseFeed/quoteFeed + oraclePaused guard) |
| `0x50bc39b5722fb563…` | SPY | USDG | 0.625 | 11,229 | 4,343 | 38.7% | 0.06% | 0.02% | `0xe8dab19184f72b5a5a9d51a6c50a1b04b0669ce7` | MCOv2: Chainlink Robinhood SPY / USD (SVR) |
| `0x66306c087add8907…` | NVDA | USDG | 0.625 | 6,579 | 417 | 6.3% | 0.03% | 0.00% | `0xc5b8a6c5fdf14f9744db1c8595f49e42ce23031a` | MCOv2: Chainlink Robinhood NVDA / USD (std) |
| `0xb41b34c5989420ad…` | TSLA | USDG | 0.625 | 6,560 | 2 | 0.0% | 0.03% | 0.00% | `0xca76875634e0b9759aa6610dc3092e92fcefe46e` | MCOv2: Chainlink Robinhood TSLA / USD (std) |
| `0x9d61e320efb766ce…` | F | USDG | 0.385 | 563 | 0 | 0.0% | 0.64% | 0.00% | `0x2ffa228cfd93bc2173537615bd4a8bd30e718a88` | MCOv2 over 'Uniswap V3 Pool Price in USD' `0x7d5513a63f984d6d7175de573cd04075d88c7e4b` |
| `0x2ab6a14c9f68d421…` | USAR | USDG | 0.385 | 125 | 0 | 0.0% | 0.03% | 0.00% | `0x199c58dc69a7f15561ae77c2f26ee1301402b70d` | MCOv2: Chainlink Robinhood USAR-USD (std) |
| `0x96d3d5f9bc842e4c…` | CRWV | USDG | 0.625 | 125 | 0 | 0.0% | 0.05% | 0.00% | `0xfc7dad09c0893d7359b946fefffede5a56c2f258` | MCOv2: Chainlink Robinhood CRWV / USD (std) |
| `0xf049167e6bf18a1b…` | NBIS | USDG | 0.625 | 125 | 0 | 0.0% | 0.04% | 0.00% | `0xad95efbcf91af709a7bf8cb6ee5f99f4547187f8` | MCOv2: Chainlink Robinhood NBIS / USD (std) |
| `0x7d4313cf1b0ede39…` | LULU | USDG | 0.385 | 125 | 0 | 0.0% | 0.24% | 0.00% | `0x7c38823d907bd3e78ecdab44ee0362fd0be2d7da` | MCOv2 over 'Uniswap V3 Pool Price in USD' `0xbabe07aaab055f29d11472be6a7c68f32ca27239` |
| `0xf6f3dbe0a19e9481…` | SGOV | USDG | 0.860 | 111 | 0 | 0.0% | 0.03% | 0.00% | `0x3e349d0521e57c32cf1e3be83ec828a3ee42475d` | MCOv2: Chainlink Robinhood SGOV-USD (std) |
| `0x6c12c02536aa2783…` | GLD | USDG | 0.385 | 111 | 0 | 0.0% | 0.12% | 0.00% | `0x8cfe192c6f79ab3d32c48ed97b5aa2ba6fd3969a` | MCOv2 over 'Uniswap V3 Pool Price in USD' `0x9d380f2988fe04c58a69c3c5dc389b8587c76012` |
| `0xdd578ca54b4ef6a7…` | BABA | USDG | 0.625 | 111 | 0 | 0.0% | 0.03% | 0.00% | `0x1858735689deb5c9a0a05f5643a0807caef5a1f1` | MCOv2: Chainlink Robinhood BABA / USD (std) |
| `0x003390b057d753bd…` | RGTI | USDG | 0.625 | 110 | 0 | 0.0% | 0.03% | 0.00% | `0x4b3b07252e35635501c69118f97b4af81c0dcb12` | MCOv2: Chainlink Robinhood RGTI / USD (std) |
| `0x508b47fb12dbb874…` | COIN | USDG | 0.625 | 110 | 68 | 61.8% | 0.08% | 0.05% | `0x05dd0593082aea1f5fbbe560d0a6a4d52451e980` | MCOv2: Chainlink Robinhood COIN / USD (std) |
| `0x298e8ff9b31f22be…` | RDDT | USDG | 0.385 | 110 | 4 | 3.3% | 0.05% | 0.00% | `0xb597b9dacfd878d4af432c95a86ba73e1b0c9e42` | MCOv2 over 'Uniswap V3 Pool Price in USD' `0x3ff171e03b47e20ac279d75642cea05471d43fb4` |
| `0x3be7fe1b6b439cfe…` | DJT | USDG | 0.385 | 103 | 0 | 0.0% | 0.09% | 0.00% | `0x1865f6ea327a0d5fc6a5d83e8cc56315fee500c9` | MCOv2 over 'Uniswap V3 Pool Price in USD' `0xee9cbafa4ba4698445bb8a870c2e6a7e14ffac69` |
| `0x4edbd2f2f3b33bc5…` | SLV | USDG | 0.625 | 103 | 0 | 0.0% | 0.03% | 0.00% | `0xf9d9f865b2fbe53f507e4430ee7319890b61c415` | MCOv2: Chainlink Robinhood SLV / USD (std) |
| `0x4979137c23c8fb51…` | GME | USDG | 0.625 | 103 | 0 | 0.0% | 0.03% | 0.00% | `0x5f35bad049ef7bb69ea1fbbfa210d6b7e2ead00d` | MCOv2: Chainlink Robinhood GME / USD (SVR) |
| `0xd8b502d5c43f6e5c…` | DELL | USDG | 0.625 | 103 | 0 | 0.0% | 0.03% | 0.00% | `0x9ba289ed9eae000be5e98ee694af96a16adeb82c` | MCOv2: Chainlink Robinhood DELL-USD (std) |
| `0xb33399a677e1a211…` | COST | USDG | 0.385 | 103 | 0 | 0.0% | 0.09% | 0.00% | `0x8ae493639ac8f09bf7150fa9495c54cfc5e17ddc` | MCOv2 over 'Uniswap V3 Pool Price in USD' `0xb0c4922b8431bd145934ea87bac35f8aaacb7d7d` |
| `0x69400cfe81f2ae38…` | META | USDG | 0.625 | 101 | 0 | 0.0% | 0.03% | 0.00% | `0xf7282cd4277296d41d6fdb80e2fbd73f03881b6c` | MCOv2: Chainlink Robinhood META / USD (std) |
| `0x597227ca652ea5e8…` | SPCX | USDG | 0.385 | 101 | 3 | 3.1% | 0.03% | 0.00% | `0xe9d89df41f3ed22832cc32fd64e94a145f757315` | MCOv2: Chainlink Robinhood SPCX / USD (SVR) |
| `0x74fece475178af9e…` | SNDK | USDG | 0.625 | 101 | 4 | 3.5% | 0.03% | 0.00% | `0xacc181b6ec81b2d444967e4f69254fd436cf17d6` | MCOv2: Chainlink Robinhood SNDK / USD (std) |
| `0x4d2075836fd32183…` | AMD | USDG | 0.625 | 101 | 0 | 0.0% | 0.03% | 0.00% | `0xcf2fd48e4b5efbff49f46351aa3f25c6301a7961` | MCOv2: Chainlink Robinhood AMD / USD (std) |
| `0x9df4f54a2e46b35b…` | MU | USDG | 0.625 | 101 | 0 | 0.0% | 0.03% | 0.00% | `0x8260ca944126c871e5f8e674d143e14139b8d9df` | MCOv2: Chainlink Robinhood MU / USD (std) |

Oracle wiring (from the `morpho_oracles.json` probe of all 274 oracles):

- 147 use the MorphoChainlinkOracleV2 layout; 139 of those are factory-created.
- The rest are custom:
  - 4 are `AssetOracleAdapter`.
  - 2 are `DenarTwapOracle`.
  - 2 are `PareMorphoOracle`.
  - 1 is `LoopbackOracle`.
  - The remaining 118 are unverified [LIVE + Sourcify].
- 21 MCOv2 oracles price stocks and tokens that lack a Chainlink feed (F, LULU, GLD, RDDT, DJT, COST, …) through a Chainlink-interface adapter whose `description()` is **"Uniswap V3 Pool Price in USD"**, i.e. a pool TWAP/spot adapter. These markets sit at 38.5% LLTV [LIVE].
- One feed is **"EARN Steer SPY-QQQ Vault Share / USD"**, which prices a Steer LP-vault share (STEERUV417) as Morpho collateral. It is precedent for LP receipts as collateral [LIVE: `feed_descriptions.json`].
- The four large NetNet markets (SPCX, AAPL, GOOGL, NVDA) use a custom oracle. It has `baseFeed` = Chainlink "Robinhood X/USD" (std proxy), `quoteFeed` = USDG/USD `0x61B7…9aD2` and `MAX_QUOTE_AGE = 90000` s, and it **reverts `OraclePaused()` when the token's `oraclePaused()` is true** [LIVE]. Vigil's README describes this as "NetNet's Morpho oracles already revert on oraclePaused()".

Top suppliers [LIVE: Supply logs + `position()` + adapter `parentVault()`]:

- **NetNet Credit adapter** `0xf0eef247585b184836915e80f984246d981c55c4` supplies nearly all the USDG in the SPCX ($279,955), AAPL ($238,959), GOOGL ($158,808) and NVDA ($99,913) markets. Its parent vault is `0x99347d5F…`, token nnUSDG. Borrow utilization in those markets is ≤1%.
- **Longbow Core USDG** adapter `0xda803813…` (vault `0x026df18f…`, 96.8K USDG) supplies the SPY, NVDA, TSLA and WETH markets.
- **Longbow Frontier USDG** adapter `0x2aefbb4d…` (vault `0x65dc90cd…`, 62.3K USDG) supplies the long-tail markets.

Total stock collateral posted on Morpho is about $17K [LIVE: `balanceOf(Morpho)` over the top 40 stocks].

### 1.4 Morpho vaults ("Robinhood Earn")

VaultV2 only. The Morpho API lists 44 VaultV2s on 4663 [UNVERIFIED: Morpho API], with TVL figures from the API:

| Vault V2 | symbol | asset | totalAssets USD (API) | curator | adapter | listed |
|---|---|---|---|---|---|---|
| Steakhouse USDG `0xBeEff033F34C046626B8D0A041844C5d1A5409dd` | steakUSDG | USDG | 507,609,141 | `0x9023FBD6A08C666491A2d1648737E400cF42D2Fb` | `0x44ABc1d6cCFF2696d98890B92E2157AF242179c2` (MorphoMarketV1) | True |
| Ethena x Steakhouse USDG `0xbEeFF0fb1Dc19344A87b8479dAb60A2e16160737` | ethenaUSDG | USDG | 4,575,270 | `0x9023FBD6A08C666491A2d1648737E400cF42D2Fb` | `0x19E02D4af7FacFb2433F521BA4Ef8aF4A983E3dA` (MorphoMarketV1) | False |
| NetNet Credit `0x99347d5F70D3838763f6Bddcf80304C8aa953B57` | nnUSDG | USDG | 1,525,089 | `0x3Bb7A23316f82C0e984fA2E784846d8928a35f42` | `0xf0eeF247585b184836915e80f984246d981c55C4` (MorphoMarketV1) | False |
| Grove x Steakhouse USDG `0xBEEff039907422219Fb367e525954DDC092854d9` | groveUSDG | USDG | 99,992 | `0x622E19d6903BD4507cfc70b31d5B99535114C0FC` | `0x216235475CFDb89131e5609557C6428D33c2d986` (MorphoMarketV1) | False |
| Purinta USDG `0x37788ff0c1d4e45A7FE06BC7e71e0cc00121d0A8` | PurintaUSDG | USDG | 59,945 | `0x370EC5d1809B27F1fB18e002cf79837c46F5134c` | `0x4E707aE2013deFED0A92bd23eEB12A35cF7821F4` (MorphoMarketV1) | True |
| MEV Capital USDG `0xaED8B69FBd85aB131fAbC9312D9E0BD7A08fd5Be` | MEV-USDG | USDG | 50,999 | `0x1B6EaFf09bE2c263B9848708DD08809C44AF09EE` | `0xEd2F26D193faaDAde207baBf9C969E9727EBf002` (MorphoMarketV1) | False |
| hoodbet.fun `0xDF06045aBAE69d6e73a7F0197FED917032d22194` | hoodbet | USDG | 231 | `0x5FF989aCB81e612fb54d2BDE9C6334B4C9a8f117` | `0x67c8f80bEea78f22baA555A419a63B92cbE19e0A` (MorphoMarketV1) | False |
| MonkeyHood USDG `0x19d55f7FE2d3962796F5825CbDae2dd493Be0986` | lbmonkUSDG | USDG | 227 | `0x1bf704707e9F3f407EbC9364fDAeD08C39893770` | `0x3c46e2EB814EDc853a0Da8F22DB7b6E593084f2d` (MorphoMarketV1) | False |
| EARN `0x8046118a5B0D1BCBcbd4d5f2C9AA9eecC5bf771d` | EARNVAULT | USDG | 221 | `0x75741D131AbdD3973d6bA00f09948C15D138059d` | `0xf759161Da67Bb4BF872F9a900D2b4448DD897E3b` (MorphoMarketV1) | False |
| SandCastle USDG Vault `0x6c11450999abc0Da442cFfF54D95E6e0bC79Ac8c` | scUSDG | USDG | 101 | `0xd389c68542386DB71AB9Fb2D6Bd3f62ecCd503E5` | `0x36e38838004067BA24895BaE7b2751859af83629` (MorphoMarketV1) | False |
| SandCastle SPY Vault `0x75E4b452cA04d3c189A7112aC3215766E1feD03c` | scSPY | SPY | 100 | `0xd389c68542386DB71AB9Fb2D6Bd3f62ecCd503E5` | `0x6c81eA29F753994d9b640C9cF8919d3e72e56401` (MorphoMarketV1) | False |
| SandCastle WETH Vault `0x2F060738622B1f3e057BDA0c668e968995279753` | scWETH | WETH | 94 | `0xd389c68542386DB71AB9Fb2D6Bd3f62ecCd503E5` | `0x80D616B9af050317E76D486aF19F6F6DB3f00f29` (MorphoMarketV1) | False |
| Navi USDG - demo `0xcf3a65a3b54241577881FAa7003E4335247F3FB2` | vUSDG | USDG | 47 | `0x7B82C4f0670C0fbc1C85fC79C4A0805951B6A0C5` | `0xc9c0A05A71c4005CaBf9Dc4f90455Abaa89466AC` (MorphoMarketV1) | False |
| afk-conservative USDG `0x9F5433DCf731c37DDf74534ff4F41c32ECd97ED3` | afkcUSDG | USDG | 10 | `0x23D0E34CEEa372802244a514a112fD6A0f33971D` | `0x180168d0Fe7364CB9c3501428B27D25385193335` (MorphoMarketV1) | False |

**steakUSDG** `0xBeEff033F34C046626B8D0A041844C5d1A5409dd` reads on-chain as follows [LIVE]:

- `totalAssets` = 508,367,074 USDG; performance and management fees are 0.
- It has a single MorphoMarketV1AdapterV2, `0x44ABc1d6…`.
- Allocation:

  | collateral | USDG allocated | LLTV | util | borrow APY |
  |---|---|---|---|---|
  | USDe | 337,280,476 | 91.5% | 88.5% | 4.04% |
  | syrupUSDG | 126,210,676 | 91.5% | 89.0% | 4.07% |
  | mGLO | 31,458,032 | 91.5% | 90.5% | 5.51% |
  | spUSDG | 13,166,161 | 91.5% | 90.1% | 3.03% |

- This matches the launch description: Robinhood Earn, the USDG lending product built on Morpho with Steakhouse, Ethena, Spark and Maple [UNVERIFIED: The Block, 2026-07-01].

**Implication.** The USDG supply side is deep, above $500M. The stock-lending side is empty. A hedged-LP vault could borrow USDG against its LP receipt, but no market will lend it a stock.

### 1.5 Other lending protocols on 4663

The table covers the protocols named in the brief first, then everything else found.

| protocol | status on 4663 | evidence |
|---|---|---|
| Aave v3 / v4 | **not deployed** | @aave-dao/aave-address-book v4.70.3 (published 2026-09-26) has no Robinhood market; the Ethereum PoolAddressesProvider address has no code on 4663 [DOCS][LIVE] |
| Compound v3 (Comet) | **not deployed** | compound-finance/comet `deployments/` lists arbitrum, base, linea, mainnet, mantle, optimism, polygon, ronin, scroll and unichain [DOCS: repo HEAD 2026-06-23] |
| Euler v2 (EVC) | **not deployed** | euler-xyz/euler-interfaces `addresses/` has chain ids 1, 130, 137, 143, 146, 239, 42161, 43114, 56, 59144, 60808, 80094, 8453, 9745 and 999, but not 4663; the canonical EVC `0x0C9a…E383` has no code on 4663 [DOCS][LIVE] |
| Spark | **SparkLend not deployed.** Spark Savings is: `spUSDG` `0xde770c84FE66E063336b31737cFE9790f18c4087` (SparkVault impl `0x797c58c9…`, supply 13.97M) | [LIVE] [DOCS: DefiLlama spark-savings adapter] |
| Fluid | **not deployed** | Instadapp/fluid-contracts-public `deployments/` lists arbitrum, base, bnb, mainnet, plasma and polygon [DOCS] |
| Dolomite | **not deployed** | dolomite-margin-modules `deployments.json` chain ids are 1, 1101, 196, 3637, 42161, 5000, 5330, 56, 57073, 80094, 8453 and 11155111 [DOCS] |
| Silo v2 | **not deployed** | silo-contracts-v2 `silo-core/deployments/` does not include robinhood [DOCS] |
| Longbow | live curator on Morpho: 55 markets plus VaultV2s lbcoreUSDG and lbfrontUSDG; stocks only as collateral | [LIVE] [DOCS: DefiLlama adapter] |
| NetNet Credit (nnUSDG) | VaultV2, lends USDG against SPCX, AAPL, GOOGL and NVDA through oraclePaused-guarded oracles | [LIVE] |
| Spine Finance | USDG vault `0x38cc0dae…`; borrow controller `0xce1d096e…`; collateral is PT-NVDA-15OCT2026 `0x4bcb25fc…` (supply 645.5) | [LIVE][DOCS: DefiLlama] |
| Pendle V2 (PT/YT on stock tokens) | PT-NVDA-15OCT2026 exists | [LIVE] [UNVERIFIED: DefiLlama lists Pendle V2 at $0.45M] |
| PARE | principal tokens `pSPY-DEC27` `0x1d0d084e…` (supply 15.13) and `pSPY-MAR27` `0xe8b23dd2…` (5.30), with `PareMorphoOracle` | [LIVE] |
| Native Credit Pool | vault `0x57B8f68e…` (PMM credit for Native swap) | [LIVE code] [DOCS: DefiLlama] |
| Flock Credit, Gage, Ripe, Zona, TermMax, LayerBank, Oter, Kyros, Turret, Sharewoods, Accountable, USDAX (CDP), Solon | listed on DefiLlama with $0–4M TVL. None lends stock tokens as the borrowable asset; Gage makes P2P loans against LP NFTs, Flock lends against veNFTs | [UNVERIFIED: DefiLlama] |
| Arcus spot lending | Arcus's exchange accepts stock tokens as multi-asset collateral and lends USDG against them inside the exchange (`/v1/spot-collateral-assets`, interest payments) | [DOCS: docs.arcus.xyz] |

---

## 2. Perps / synthetic shorts

### 2.1 Lighter — Robinhood Chain instance ("Lighter Domain")

- Contract `0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d` is a proxy whose `getTarget()` implementation is `0x82de5b1161c93afdfe21ba0d5343f01cd7401d90` (zkLighter, 23,168 B). Master is `0x43cff77c…` [LIVE]. Public UI `robinhoodchain.lighter.xyz`, API `api.rh.lighter.xyz` [DOCS: docs.robinhood.com/chain/lighter-domains].
- Custody: the contract holds **95,205,358 USDG** [LIVE]. `lastAccountIndex` is 33,593, `executedBatchesCount` is 124,251 and `desertMode` is false. USDG is asset index 3 [LIVE].
- **Composability.** The following exist on-chain [LIVE: selectors]:
  - `deposit(address _to,uint16 assetIndex,uint8 routeType,uint256)`: anyone can deposit for any address.
  - `createOrder(uint48 account,uint16 market,uint48 base,uint32 price,uint8 isAsk,uint8 type)`, `cancelAllOrders(uint48)`, `withdraw(...)`, `changePubKey(...)` and `burnShares(...)`.
  - Desert-mode exits `activateDesertMode` and `performDesert`, with `PRIORITY_EXPIRATION` = 1,209,600 (14 days if the unit is seconds).

  A vault contract can therefore own a Lighter account, register a keeper API key and fall back to on-chain priority orders. Fills are asynchronous; the sequencer executes priority requests.
- Markets: 57 perps and 27 spot books (stock/USDG). The equity, index and commodity perps are below [UNVERIFIED: Lighter API `orderBookDetails`, read 05:00 UTC]:

| market | id | mark | open interest USD | 24h volume USD | max leverage | MMF |
|---|---|---|---|---|---|---|
| SPY | 26 | 771.15 | 48,899,864 | 84,686,890 | 50x | 1.2% |
| QQQ | 25 | 745.57 | 35,477,831 | 55,952,945 | 50x | 1.2% |
| XAU | 40 | 4,288.80 | 18,838,356 | 39,912,791 | 25x | 2.4% |
| ANTHROPIC | 38 | 2,130.10 | 6,248,117 | 17,674,058 | 5x | 12.0% |
| NVDA | 15 | 224.85 | 5,619,818 | 7,910,520 | 20x | 3.0% |
| XAG | 41 | 64.25 | 5,295,428 | 8,217,587 | 25x | 2.4% |
| OPENAI | 42 | 1,660.12 | 3,825,619 | 11,168,540 | 5x | 12.0% |
| SPCX | 18 | 148.70 | 2,687,840 | 4,545,510 | 20x | 3.0% |
| SNDK | 32 | 1,774.75 | 2,027,805 | 8,358,445 | 10x | 6.0% |
| GOOGL | 12 | 343.53 | 1,926,845 | 2,892,328 | 20x | 3.0% |
| CRCL | 24 | 87.71 | 1,442,474 | 3,091,973 | 10x | 6.0% |
| TSLA | 16 | 372.10 | 1,410,330 | 3,081,210 | 20x | 3.0% |
| MU | 31 | 1,082.50 | 1,386,182 | 3,760,034 | 10x | 6.0% |
| AAPL | 10 | 341.05 | 1,217,897 | 1,836,873 | 20x | 3.0% |
| META | 13 | 745.94 | 1,113,218 | 2,225,175 | 20x | 3.0% |
| AMZN | 11 | 249.79 | 1,035,573 | 1,038,402 | 10x | 6.0% |
| SKHY | 37 | 190.94 | 993,040 | 862,551 | 10x | 6.0% |
| MSFT | 14 | 517.89 | 833,850 | 1,885,213 | 20x | 3.0% |
| INTC | 30 | 123.11 | 784,871 | 2,015,686 | 10x | 6.0% |
| SGOV | 27 | 100.58 | 759,215 | 379,245 | 10x | 6.0% |
| BABA | 19 | 110.40 | 664,093 | 128,256 | 10x | 6.0% |
| COIN | 23 | 195.31 | 628,073 | 804,296 | 10x | 6.0% |
| ORCL | 17 | 137.01 | 594,349 | 335,149 | 10x | 6.0% |
| AMD | 29 | 631.16 | 560,787 | 2,401,316 | 10x | 6.0% |
| PLTR | 34 | 189.91 | 539,234 | 439,895 | 10x | 6.0% |
| SOXL | 35 | 154.93 | 502,881 | 2,206,380 | 20x | 3.0% |
| CRWV | 33 | 86.96 | 444,865 | 353,508 | 10x | 6.0% |
| SLV | 28 | 57.98 | 319,440 | 282,786 | 10x | 6.0% |
| USAR | 21 | 15.17 | 316,013 | 53,218 | 10x | 6.0% |
| USO | 22 | 150.64 | 306,967 | 478,202 | 10x | 6.0% |
| BE | 20 | 286.75 | 257,255 | 355,082 | 10x | 6.0% |
| TSM | 46 | 451.27 | 186,304 | 499,806 | 10x | 6.0% |
| IREN | 49 | 44.23 | 75,839 | 124,070 | 10x | 6.0% |
| ASTS | 47 | 61.82 | 48,902 | 77,022 | 10x | 6.0% |
| SMCI | 53 | 43.28 | 39,509 | 37,986 | 10x | 6.0% |
| SOFI | 54 | 16.65 | 38,494 | 48,548 | 10x | 6.0% |
| SHEIN | 43 | 4.57 | 28,025 | 57,467 | 5x | 12.0% |
| AMC | 56 | 2.93 | 18,666 | 135,337 | 10x | 6.0% |
| LUNR | 50 | 15.62 | 15,503 | 49,711 | 10x | 6.0% |
| QBTS | 51 | 17.38 | 11,141 | 23,483 | 10x | 6.0% |
| WULF | 55 | 15.79 | 10,801 | 13,347 | 10x | 6.0% |
| RGTI | 52 | 16.69 | 10,727 | 43,340 | 10x | 6.0% |
| CLSK | 48 | 13.96 | 7,163 | 36,489 | 10x | 6.0% |

- Fees are 0 maker / 0 taker. `trading_hours` is empty, so trading runs 24/7. SPY and QQQ spot books trade $20.2M and $0.1M per 24h [UNVERIFIED: Lighter API].

### 2.2 Arcus (dYdX Labs × Robinhood) — hybrid CLOB

- Architecture: an off-chain matching engine, a permissioned appchain validator set that commits state roots, and an "EVM rootchain" (4663) with a Checkpoint Manager and a Bridge Vault for custody plus an escape hatch [DOCS: docs.arcus.xyz/concepts/exchange-architecture].
- Orders go through REST or WS with Ed25519 API keys. A contract cannot trade synchronously.
- RWA perps track total return: dividends are paid via funding and splits are adjusted. Off-hours rules [DOCS: docs.arcus.xyz …/real-world-assets]:
  - funding is fixed at SOFR+0.5%;
  - initial margin rises (e.g. 0.10 → 0.15);
  - price bands center on the RTH-close VWAP and widen 0.5x→1x→2x→4x × IMF after a sustained one-hour clock.
- Pyth ids are used as oracle references [UNVERIFIED: Arcus API `pythId`].
- Equity, index and commodity markets [UNVERIFIED: Arcus API `/v1/markets`]:

| market | category | oracle px | OI USD | 24h vol USD | IMF (RTH / off-hours) | max lev | funding/h |
|---|---|---|---|---|---|---|---|
| HOOD-USD | EQUITIES | 118.57 | 1,058,370 | 2,152,958 | 0.1 / 0.15 | 10x | 0.00051% |
| SPY-USD | INDICES | 770.48 | 956,590 | 2,895,927 | 0.02 / 0.03 | 50x | 0.00051% |
| GLD-USD | COMMODITIES | 392.71 | 725,627 | 1,199,442 | 0.04 / 0.06 | 25x | 0.00051% |
| QQQ-USD | INDICES | 744.29 | 700,758 | 1,706,663 | 0.04 / 0.06 | 25x | 0.00051% |
| USO-USD | COMMODITIES | 151.53 | 390,970 | 366,429 | 0.05 / 0.075 | 20x | 0.00051% |
| NVDA-USD | EQUITIES | 224.55 | 371,374 | 336,917 | 0.05 / 0.075 | 20x | 0.00051% |
| SLV-USD | COMMODITIES | 57.97 | 299,647 | 386,651 | 0.04 / 0.06 | 25x | 0.00051% |
| SNDK-USD | EQUITIES | 1,772.62 | 236,698 | 1,854,235 | 0.1 / 0.15 | 10x | 0.00051% |
| GOOGL-USD | EQUITIES | 343.18 | 221,833 | 71,504 | 0.1 / 0.15 | 10x | 0.00051% |
| AMZN-USD | EQUITIES | 249.61 | 219,257 | 252,996 | 0.1 / 0.15 | 10x | 0.00051% |
| AAPL-USD | EQUITIES | 340.74 | 209,440 | 65,050 | 0.05 / 0.075 | 20x | 0.00051% |
| GME-USD | EQUITIES | 23.64 | 195,975 | 185,728 | 0.1 / 0.15 | 10x | 0.00051% |
| SPCX-USD | EQUITIES | 148.67 | 178,496 | 280,709 | 0.2 / 0.3 | 5x | 0.00051% |
| META-USD | EQUITIES | 745.35 | 175,417 | 135,812 | 0.1 / 0.15 | 10x | 0.00051% |
| TSLA-USD | EQUITIES | 371.79 | 156,510 | 23,020 | 0.1 / 0.15 | 10x | 0.00051% |
| CRCL-USD | EQUITIES | 87.67 | 133,000 | 177,959 | 0.1 / 0.15 | 10x | 0.00051% |
| MU-USD | EQUITIES | 1,081.29 | 121,671 | 88,492 | 0.1 / 0.15 | 10x | 0.00051% |
| MSFT-USD | EQUITIES | 517.56 | 103,755 | 29,413 | 0.1 / 0.15 | 10x | 0.00051% |
| AMD-USD | EQUITIES | 630.09 | 103,169 | 71,866 | 0.1 / 0.15 | 10x | 0.00051% |
| BE-USD | EQUITIES | 286.28 | 102,628 | 111,286 | 0.1 / 0.15 | 10x | 0.00051% |
| DRAM-USD | EQUITIES | 61.95 | 94,528 | 63,514 | 0.1 / 0.15 | 10x | 0.00051% |
| ORCL-USD | EQUITIES | 136.97 | 78,617 | 65,273 | 0.1 / 0.15 | 10x | 0.00051% |
| NBIS-USD | EQUITIES | 237.00 | 78,348 | 335,193 | 0.2 / 0.3 | 5x | 0.00051% |
| BABA-USD | EQUITIES | 110.30 | 76,414 | 9,073 | 0.1 / 0.15 | 10x | 0.00051% |
| PLTR-USD | EQUITIES | 189.92 | 74,706 | 21,556 | 0.1 / 0.15 | 10x | 0.00051% |
| SKHY-USD | EQUITIES | 190.89 | 60,862 | 39,610 | 0.1 / 0.15 | 10x | 0.00051% |
| INTC-USD | EQUITIES | 122.77 | 60,559 | 85,954 | 0.1 / 0.15 | 10x | 0.00051% |
| USAR-USD | EQUITIES | 15.15 | 55,908 | 10,478 | 0.1 / 0.15 | 10x | 0.00051% |
| CRWV-USD | EQUITIES | 86.97 | 53,471 | 27,179 | 0.1 / 0.15 | 10x | 0.00051% |
| CPER-USD | COMMODITIES | 40.69 | 50,179 | 8,073 | 0.1 / 0.15 | 10x | 0.00051% |
| COIN-USD | EQUITIES | 195.50 | 35,135 | 31,757 | 0.2 / 0.3 | 5x | 0.00051% |
| MRVL-USD | EQUITIES | 262.37 | 17,597 | 23,014 | 0.2 / 0.3 | 5x | 0.00051% |
| MSTR-USD | EQUITIES | 158.93 | 13,403 | 60,755 | 0.1 / 0.15 | 10x | 0.00051% |
| BOT-USD | EQUITIES | 29.12 | 10,136 | 77,938 | 0.2 / 0.3 | 5x | 0.00051% |
| MRNA-USD | EQUITIES | 197.67 | 7,588 | 183,834 | 0.1 / 0.15 | 10x | 0.00051% |
| QNT-USD | EQUITIES | 49.57 | 2,449 | 9,852 | 0.1 / 0.15 | 10x | 0.00051% |

- **pTokens.** ERC-4626 beacon proxies over a managed perp account, denominated in USDG. Factory `0x9c3663FA9ab976E67B42939486EC4966Cb41a0BB`, `pTokenCount()` = 17 [LIVE]:

| pToken | symbol | name | supply | NAV (USDG, totalAssets) |
|---|---|---|---|---|
| `0xe24cabdf76dd1c2576049167eb1755c84b985c36` | pHOOD3x | Arcus HOOD (3x Long) | 1,570.09 | 259,978 |
| `0x4472c69d299382f8847ebce4fc6ed8e295510e3e` | pBTC3x | Arcus BTC (3x Long) | 375.47 | 75,227 |
| `0x0053333fcaff9486fa55877044f09137c1a52530` | sHOOD3x | Arcus HOOD (3x Short) | 202.09 | 56,294 |
| `0x1a596466cb593bee293be8366d9ce493582189c2` | sGME5x | Arcus GME (5x Short) | 621.84 | 54,326 |
| `0xb2cb7371bc45a460f856712a3088c23acd385df8` | sGLD5x | Arcus GLD (5x Short) | 462.10 | 50,209 |
| `0x5c3b9a9b021e86b54202abcb4580f1f5c271875b` | pGME5x | Arcus GME (5x Long) | 563.87 | 50,124 |
| `0x37a2afaa98648f2e13658623885f821ac8365609` | pGLD5x | Arcus GLD (5x Long) | 567.69 | 49,869 |
| `0x8b9d2eb675e33e541cb7de25a55724d2e70e8dab` | pSPCX3x | Arcus SPCX (3x Long) | 501.46 | 49,734 |
| `0x925f92f055edb79c42b5d45e64a1b74143b90ea0` | pBTC | Arcus BTC (1x Long) | 233.65 | 24,718 |
| `0xadcceee8e422050f890522fa798f8a93a4857083` | sBTC3x | Arcus BTC (3x Short) | 265.48 | 21,590 |
| `0xc25c966168a8e933b0aba0dc8a25cac4a2b2b91d` | sBTC | Arcus BTC (1x Short) | 139.28 | 13,261 |
| `0x17271bd2a1eaa350a002d25236bcc4dc07ceb6a9` | sSPCX3x | Arcus SPCX (3x Short) | 104.04 | 10,128 |
| `0x2e9c527032daaa6084b15bf0c2dbf50f9675253c` | sSPCX5x | Arcus SPCX (5x Short) | 5.75 | 688 |
| `0x9b319b9ffbe969be6fcdcb0ad09ad0405eda05b0` | pSPCX5x | Arcus SPCX (5x Long) | 5.48 | 450 |
| `0x1193bcbfafeb2f25c516817c46bd3143936d1d5c` | pTEST | Arcus pToken Test | 200.90 | 293 |
| `0x4595a18b47c6fb46f3a157e2918f5c34cdca35eb` | pTESTR | pToken Redemption Test | 307.11 | 283 |
| `0x122408c1399e51c41b096402fea46e20e762a950` | pTEST3 | Test 3 | 0.00 | 0 |

### 2.3 Other derivatives

| venue | what it is | evidence |
|---|---|---|
| **Meridian** | Off-chain matching with exchange contracts on 4663. "mPerps" freeze at the last oracle price off-hours. Markets: USD, BTC, ETH, SOL, HYPE, XAU(USD), XAG(USD), SPY(USD), QQQ(USD). Collateral is merUSD `0xad221259…` (1:1 USDe-backed, supply 1,077,608). ExchangeGateway proxy `0xD540F47F214dC7D6D244E62A6aE7e06B586Ef44A`. LP vault MLP `0x24b84023…` | [LIVE: `getExchangeTokens`/`getToken`] [DOCS: docs.meridian.xyz] |
| **Panoptic V2** | Factories `0x0000000000000aDC9A108591e718F2aee963a2a7` (v3) and `0x0000000000000c51d0f8cf4bd9adE7191372a625` (v4). Six v3-based pools (GOOGL/USDG, WETH/USDG, NVDA/USDG, SPCX/USDG, GLD/USDG, QQQ/USDG), all with **empty** collateral trackers (1 wei). Two v4 SPY/USDG pools, one holding 12.45 SPY + 7,611.7 USDG | [LIVE] |
| **PARE** | Interest-rate derivatives on stocks: principal/yield split (`PYToken`), e.g. `pSPY-DEC27` | [LIVE] |
| **VS Trade** | Binary-outcome markets with USDG complete sets plus an AMM; factory `0xE96F3d1F98f91842EA209acA197844040E241990` | [LIVE code] [DOCS: DefiLlama adapter] |
| Meridian Predict, Hoodbets, BV-7X, wambo.fun | prediction markets | [UNVERIFIED: DefiLlama] |
| Inverse / short stock ERC-20s outside Arcus | **none found** | — |
| Options protocols (Ithaca, Ryze, etc.) | **none found** on 4663 except Panoptic | [UNVERIFIED: DefiLlama category scan] |
| Bitstamp / Vertex perps | Not on-chain on 4663. Robinhood's EU 24/7 perps and Bitstamp are off-chain Robinhood products | [UNVERIFIED: The Block 2026-07-01] |
| UIs (Hyperhood, HoodPerp, Perpetra) | front-ends found by search; contracts not verified | [UNVERIFIED] |

---

## 3. DEXes

### 3.1 Uniswap deployments on 4663

Source: [DOCS: developers.uniswap.org/deployments.json, generated 2026-07-15]. Code was checked for each [LIVE].

| contract | address |
|---|---|
| v3 Factory | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` |
| v3 NonfungiblePositionManager | `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3` |
| v3 SwapRouter02 / QuoterV2 / TickLens | `0xCaf681a66D020601342297493863E78C959E5cb2` / `0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7` / `0x7DfD4F31be6814D2906BDE155c3e1B146EAc1468` |
| v4 PoolManager / PositionManager / StateView / V4Quoter | `0x8366a39CC670B4001A1121B8F6A443A643e40951` / `0x58daec3116aae6D93017bAAea7749052E8a04fA7` / `0xF3334192D15450CdD385c8B70e03f9A6bD9E673b` / `0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94` |
| UniversalRouter (current / v2.1.2) | `0x06AfBA43Fd06227fA663b0DAecF536f6EaA6bf99` / `0x204FAca1764B154221e35c0d20aBb3c525710498` |
| v2 Factory / Router02 | `0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f` / `0x89e5DB8B5aA49aA85AC63f691524311AEB649eba` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| UniswapX DutchV3OrderReactor | `0x000000007A1C8e570011EeDF86A2A35593013cBA` |

### 3.2 Uniswap v3: all pools [LIVE]

`PoolCreated` from block 0 to 72,816,157 gives **436,362 pools**:

- By fee tier: 1% 413,003; 0.01% 11,580; 0.3% 10,047; 0.05% 1,732.
- By pair: 425,201 pair with WETH (launchpad memecoins), 6,070 with USDG, and 2,420 contain a registered stock token.

I read known-side balances (`balanceOf` of USDG, WETH, 195 stock tokens and USDe) for every pool: 433,731 calls. Only 1,597 pools hold more than $1K on the known side and 348 hold more than $10K. The known side totals $109.1M.

**Top 40 by USD TVL**, sorted by the conservative column (★ = stock pool) [LIVE, balances read at ≈ block 72.82M]. Pricing: USDG = $1; WETH = Chainlink ETH/USD (2,686.81); stock tokens = Chainlink "Robinhood X/USD" where it exists, otherwise the RH `/prices` token bid/ask mid (multiplier-adjusted); USDe = Chainlink. Tokens marked `derived` are priced from their deepest pool against a known asset. The "conservative" column caps the pool-priced side at 1× the known side.

| # | pair (token0/token1) | fee | pool | TVL USD | TVL USD (conservative) | reserve0 | reserve1 | pricing |
|---|---|---|---|---|---|---|---|---|
| 1 | WETH/USDG | 0.01% | `0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca` | 19,233,874 | 19,233,870 | 3,140.86 | 10,794,988.21 | known/known |
| 2 | WETH/PIPEDOG | 1.00% | `0xb7f10f74b39291b9290b779978e19a7637c742d6` | 8,276,315 | 8,244,117 | 1,534.18 | 2,170,438,096.99 | known/derived |
| 3 | USDG/NVDA ★ | 0.05% | `0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3` | 5,770,065 | 5,770,061 | 3,718,174.39 | 9,092.83 | known/known |
| 4 | WETH/USDG | 0.05% | `0x69bfaf19c9f377bb306a89aed9f6b07e2c1a8d9a` | 4,766,162 | 4,766,162 | 641.44 | 3,042,734.43 | known/known |
| 5 | WETH/PONS | 1.00% | `0x10cc6bd38112cac182db90b6a71d8bb5939526ba` | 4,385,207 | 4,291,340 | 798.59 | 3,488,316.51 | known/derived |
| 6 | CASHCAT/WETH | 1.00% | `0xa70fc67c9f69da90b63a0e4c05d229954574e313` | 6,033,285 | 4,131,526 | 20,468,139.00 | 764.10 | derived/known |
| 7 | WETH/PONS | 0.30% | `0xed50bdeea8adc232f159486192a4157281d722ff` | 5,917,205 | 3,763,752 | 706.10 | 6,261,670.20 | known/derived |
| 8 | USDG/GLD ★ | 0.30% | `0x7a6a053eccf1446a2633e05aa6d40d09381997ec` | 3,161,303 | 3,161,303 | 950,707.60 | 5,682.62 | known/known |
| 9 | SPCX/USDG ★ | 0.05% | `0xc61284332117c3fb23a2a56cceffd07f7af60029` | 2,535,481 | 2,535,481 | 9,125.55 | 1,179,031.76 | known/known |
| 10 | CASHCAT/WETH | 0.30% | `0xd42a491087a15e5afd51feb3606066cc152d2b09` | 2,621,165 | 2,494,989 | 7,150,533.51 | 458.03 | derived/known |
| 11 | USDG/SGOV ★ | 0.30% | `0xfab520051f96f4d2a32c22b6a3dd7fffdf231bfe` | 2,400,956 | 2,400,956 | 1,581,304.68 | 8,101.84 | known/known |
| 12 | WETH/AI | 1.00% | `0xc4a21f9d6485fc5893dd4a491b320a83daf4da1d` | 3,575,720 | 2,266,996 | 421.88 | 9,635,848.44 | known/derived |
| 13 | USDG/CRCL ★ | 0.30% | `0x654e4143e82a5824445ade0824351c2a9acd95a8` | 2,033,853 | 2,033,853 | 863,813.27 | 13,393.32 | known/known |
| 14 | USDG/USO ★ | 0.30% | `0x02175608f1b5e6b5ed221ccfdc7be197d111d915` | 1,959,518 | 1,959,518 | 1,120,906.34 | 5,639.69 | known/known |
| 15 | WETH/SPY ★ | 0.05% | `0xddcbba3666f578e3f09516f21ff85bfee859ab5e` | 1,732,883 | 1,732,883 | 151.89 | 1,715.32 | known/known |
| 16 | USDG/GLD ★ | 0.05% | `0xba2f1ed4ceb2169d538d1e614d847e83c5a55913` | 1,730,621 | 1,730,621 | 489,492.34 | 3,190.48 | known/known |
| 17 | WETH/USDG | 0.30% | `0xa9188730fe85be88ad499d7d52b099e800fb0334` | 1,552,464 | 1,552,464 | 134.80 | 1,190,274.14 | known/known |
| 18 | WETH/DELTA | 1.00% | `0xd64fbda67e1015df43fa5e49f02ca844729e5f94` | 1,577,658 | 1,526,509 | 284.07 | 36,938,526.89 | known/derived |
| 19 | WALLET/WETH | 1.00% | `0x9501a20bedb8bea0798fe5d4c411f5e270965d49` | 2,087,523 | 1,450,945 | 61,902,972.28 | 269.68 | derived/known |
| 20 | USDG/QQQ ★ | 0.05% | `0xd60a5d14db690b7afad71f76b108071d7175597d` | 1,353,172 | 1,353,172 | 680,471.76 | 902.52 | known/known |
| 21 | WETH/cbBTC | 0.30% | `0xd30e44aae604b42a63f6f9a8109fd0408f35b9fb` | 1,310,142 | 1,240,246 | 230.80 | 8.24 | known/derived |
| 22 | RDDT/USDG ★ | 1.00% | `0xa8744e76aed23b05f0126335e7bd38f7935d19fe` | 1,225,834 | 1,225,790 | 4,198.34 | 491,040.98 | known/known |
| 23 | WETH/NVDA ★ | 0.05% | `0x62ab521f71431f78ac374cdbadc6cda3c8916b6c` | 1,098,555 | 1,098,555 | 142.79 | 3,168.02 | known/known |
| 24 | USDG/HIMS ★ | 0.30% | `0xc8c90d3a1c1a24967e773ac2ad0d456ba3e31f64` | 1,078,914 | 1,078,914 | 467,158.60 | 22,495.13 | known/known |
| 25 | WETH/CHUMP | 1.00% | `0x714442e9a611f8561a7df108d6d925132937cfb8` | 1,074,643 | 1,024,335 | 190.61 | 17,827,580.61 | known/derived |
| 26 | WETH/SPCX ★ | 0.05% | `0xc3c9f0171490ef0f4536fe493f3b0ebb5ee0cb5e` | 1,001,151 | 1,001,151 | 75.68 | 5,367.32 | known/known |
| 27 | GOOGL/USDG ★ | 0.05% | `0x34d0dc122cf9a8eb296fc5e0d3a233625d7d19b7` | 967,196 | 967,196 | 1,433.47 | 474,515.77 | known/known |
| 28 | USDG/MU ★ | 0.30% | `0xd057b1bc54917855bbee58ead58647f47cab35e5` | 859,216 | 859,216 | 526,684.93 | 307.10 | known/known |
| 29 | AMZN/USDG ★ | 0.30% | `0x8ac92da74ab5f3b1d024dc1943ad7e15dc4179ef` | 806,880 | 806,880 | 2,029.90 | 299,523.58 | known/known |
| 30 | GME/USDG ★ | 1.00% | `0xe9713f453adb9245b19559790c96f470a18f2fdf` | 750,250 | 750,250 | 16,307.78 | 367,735.68 | known/known |
| 31 | PONS/USDG | 1.00% | `0x7a192e71564ec66ee0763e328a3ac274942de4e1` | 3,675,971 | 720,775 | 5,164,374.51 | 360,387.38 | derived/known |
| 32 | WETH/TENDIES | 1.00% | `0x237609918f330add285b8bc5f8f2922283d1c4c5` | 697,960 | 686,062 | 127.62 | 33,385,494.69 | known/derived |
| 33 | USDG/MSFT ★ | 0.30% | `0xeb60bcd1d920ad6e102690ccfc6fb488899e1510` | 680,627 | 680,627 | 548,809.28 | 255.05 | known/known |
| 34 | COST/USDG ★ | 0.30% | `0x0a2121a50a09ed0796ae81f9c53ff9398355a398` | 633,107 | 633,107 | 225.88 | 416,430.40 | known/known |
| 35 | WETH/TAO | 1.00% | `0x572d51a3de7c220fdd19451e4e24183b9f2ecadc` | 616,430 | 616,430 | 206.62 | 195.83 | known/derived |
| 36 | CASHCAT/USDG | 1.00% | `0x4b0c312ffbb068f6a0bea128759e35d94b94d0e1` | 594,594 | 595,841 | 268,314.64 | 542,417.03 | derived/known |
| 37 | USDG/TAO | 1.00% | `0x3f048149f291f459a38fe1d937a361b153cba43e` | 590,220 | 590,220 | 452,286.64 | 440.72 | known/derived |
| 38 | WETH/COIN ★ | 0.30% | `0x6707aeac7d0e519b083219d27bb427364363183a` | 588,616 | 588,616 | 82.59 | 1,881.05 | known/known |
| 39 | SPCX/USDG ★ | 0.30% | `0xeb07d9587efd1778dfb9c385ec43ef6d5f9fe401` | 588,499 | 588,499 | 1,594.95 | 351,420.97 | known/known |
| 40 | WETH/Index | 1.00% | `0xd29893ffac8b29ec4db2cfe0cdb3fe1377c028ff` | 912,030 | 584,748 | 110.07 | 21,679,759.60 | known/derived |

### 3.3 Uniswap v4: all pools, hooks [LIVE]

`Initialize` from block 0 to 72,819,264 gives **895,598 pools**:

- 588,037 have no hook; 307,561 are hooked, across 23,344 distinct hook addresses.
- 439,755 are native-ETH pairs, 201,879 USDG pairs and 131,425 WETH pairs.
- **90,252 contain a stock token.** Mostly these are memecoin/stock launchpad pairs: 53,565 through the Doppler hook. 14,020 stock pools have no hook.

Top hooks by pool count, identified via Sourcify (the permission set is decoded from the address bits):

| hook | pools | stock pools | code B | Sourcify name | permissions |
|---|---|---|---|---|---|
| `0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544` | 179,063 | 53,565 | 25,533 | DopplerHookInitializer | afterSwapReturnsDelta, afterSwap, afterRemoveLiquidity, afterAddLiquidity, beforeInitialize |
| `0x48b8f6ad3a1b4aa477314c9a23035b8f84dde8cc` | 15,065 | 149 | 16,405 | ClankerHookStaticFeeV2 | afterSwapReturnsDelta, beforeSwapReturnsDelta, afterSwap, beforeSwap, beforeAddLiquidity, beforeInitialize |
| `0xe5e702641ea86f4ae6cc3cdaed2b886f976be044` | 9,476 | 3,196 | 15,167 | PonsV2MemeHook | afterSwapReturnsDelta, afterSwap, beforeInitialize |
| `0x75a54357d9c78a2db19004a5fdc76c50f9242aec` | 8,956 | 0 | 13,927 | CashCatHookV2 | afterSwapReturnsDelta, beforeSwapReturnsDelta, beforeDonate, afterSwap, beforeSwap, beforeRemoveLiquidity, beforeAddLiquidity, beforeInitialize |
| `0x745d717620052a97a22deee2e5eba59583f3e0cc` | 6,508 | 0 | 9,130 | UniversalKlikHook | afterSwapReturnsDelta, beforeSwapReturnsDelta, afterSwap, beforeSwap, beforeInitialize |
| `0x4eb1976978756bd56802d8162f2271844924e0cc` | 5,872 | 1,270 | 130 | ERC1967Proxy | afterSwapReturnsDelta, beforeSwapReturnsDelta, afterSwap, beforeSwap, beforeInitialize |
| `0x5cf8e499c7c466c7e2cf127bdf129f57151e65dc` | 5,334 | 0 | 23,524 | PositionManager | afterSwapReturnsDelta, beforeSwapReturnsDelta, afterDonate, afterSwap, beforeSwap, afterRemoveLiquidity, afterAddLiquidity, beforeInitialize |
| `0x16d1560630ce74af4478d9b8ad46548a092a2000` | 4,550 | 4,507 | 3,012 | PairV4Hook | beforeInitialize |
| `0x0310cfebe1d7a69f2414f6595bbe9d17c5342acc` | 4,191 | 3,479 | 15,732 | LaunchHook | afterSwapReturnsDelta, beforeSwapReturnsDelta, afterSwap, beforeSwap, beforeRemoveLiquidity, beforeAddLiquidity, beforeInitialize |
| `0x14bcc18fdb0e7a427122b9c2f1a40ff7d63eaacc` | 3,222 | 0 | 6,713 | PumpV4Hook | afterSwapReturnsDelta, beforeSwapReturnsDelta, afterSwap, beforeSwap, beforeRemoveLiquidity, beforeAddLiquidity, beforeInitialize |
| `0x778b0c4eea7d35d66513b587ba87fc9084b0eacc` | 3,221 | 3,221 | 10,342 | LaunchHook | afterSwapReturnsDelta, beforeSwapReturnsDelta, afterSwap, beforeSwap, beforeRemoveLiquidity, beforeAddLiquidity, beforeInitialize |
| `0xefe669814e5eec33406bd50ffa8331618d076aec` | 2,347 | 0 | 11,383 | CashCatHook | afterSwapReturnsDelta, beforeSwapReturnsDelta, beforeDonate, afterSwap, beforeSwap, beforeRemoveLiquidity, beforeAddLiquidity, beforeInitialize |
| `0xf7521cf0bb7c11e2d2794189412614cf2e29a0cc` | 2,139 | 0 | 130 | ERC1967Proxy | afterSwapReturnsDelta, beforeSwapReturnsDelta, afterSwap, beforeSwap, beforeInitialize |
| `0x441f773b3bb1ed4c6457d0528624112e43c02acc` | 1,681 | 0 | 10,342 | LaunchHook | afterSwapReturnsDelta, beforeSwapReturnsDelta, afterSwap, beforeSwap, beforeRemoveLiquidity, beforeAddLiquidity, beforeInitialize |
| `0x8aa375f7186f86bbac7b13ab01db189ebe50c0c4` | 1,479 | 996 | 20,094 | unverified | afterSwapReturnsDelta, afterSwap, beforeSwap |
| `0xa732256e597eee0cef5cf013cc4018c457ed40cc` | 1,098 | 0 | 4,759 | unverified | afterSwapReturnsDelta, beforeSwapReturnsDelta, afterSwap, beforeSwap |
| `0xbffe76cc9e506285032b2e5d1b74b579e39ac0cc` | 792 | 0 | 5,330 | LivoSwapHook | afterSwapReturnsDelta, beforeSwapReturnsDelta, afterSwap, beforeSwap |
| `0x54198ff2fce9b0df255051d49748fe53a8e428cc` | 609 | 0 | 31,134 | PmavHook | afterSwapReturnsDelta, beforeSwapReturnsDelta, afterSwap, beforeSwap, beforeAddLiquidity, beforeInitialize |
| `0x238484beb11de95bbaa29e8243ddfebd72a41000` | 576 | 0 | 1,487 | DynamicFeeHookV4 | afterInitialize |
| `0x491d47e2fc27c39e007df0fabb62691d75fc9044` | 530 | 0 | 11,347 | unverified | afterSwapReturnsDelta, afterSwap, afterInitialize |
| `0x9458bc8b4d6d70532ad856307257be223a8240c4` | 526 | 241 | 20,026 | unverified | afterSwapReturnsDelta, afterSwap, beforeSwap |
| `0xb884a8a6459b52c143717894a93b2f676e6b00cc` | 517 | 0 | 8,593 | HookPadHook | afterSwapReturnsDelta, beforeSwapReturnsDelta, afterSwap, beforeSwap |
| `0x5bea51a486a6a85e4f5c86eaad9f61851aaf0044` | 460 | 31 | 8,890 | BerserkBearFeeHook | afterSwapReturnsDelta, afterSwap |
| `0xd2f759a1cf13c30127c551c3aee04629aea200c0` | 432 | 367 | 9,016 | PairV5LaunchV2NativeFeeHook | afterSwap, beforeSwap |
| `0xfe3efa722dcab53e87e94593cb41bc706c1e3044` | 415 | 0 | 24,359 | CookHook | afterSwapReturnsDelta, afterSwap, afterInitialize, beforeInitialize |
| `0x5668a66170e8fec7cbdaf0b5d1a88ac6b45310c0` | 405 | 0 | 19,662 | LootHookV4 | afterSwap, beforeSwap, afterInitialize |
| `0x50b7fcf40fae69e888ab7e8f28610828367a80cc` | 310 | 0 | 6,025 | VenomHook | afterSwapReturnsDelta, beforeSwapReturnsDelta, afterSwap, beforeSwap |
| `0x0225a740822094d0d8c21b20a9a0f6d254e36888` | 296 | 0 | 11,477 | PackHook | beforeSwapReturnsDelta, beforeSwap, beforeAddLiquidity, beforeInitialize |
| `0xc52fc52698479e42f0da9a8a75296ec3871454c0` | 293 | 33 | 19,429 | unverified | afterSwap, beforeSwap, afterAddLiquidity, afterInitialize |
| `0x66ffe4379d75c0d38cc07ec2c87a34f2922840cc` | 290 | 0 | 4,587 | unverified | afterSwapReturnsDelta, beforeSwapReturnsDelta, afterSwap, beforeSwap |
| `0xe693a6978cae40520c1aa040ab0ff2d44454f8cc` | 285 | 0 | 8,315 | unverified | afterSwapReturnsDelta, beforeSwapReturnsDelta, afterSwap, beforeSwap, beforeAddLiquidity, afterInitialize, beforeInitialize |
| `0x8d346f24278c5cd786309161aac0fc2bbe4c25dc` | 264 | 99 | 23,479 | PositionManager | afterSwapReturnsDelta, beforeSwapReturnsDelta, afterDonate, afterSwap, beforeSwap, afterRemoveLiquidity, afterAddLiquidity, beforeInitialize |

Identification notes:

- **Doppler**: `DopplerHookInitializer`.
- **Clanker**: `ClankerHookStaticFeeV2`.
- **Pons**: `PonsV2MemeHook`.
- **CashCat**: `CashCatHookV2`.
- **Flaunch**: probably `0x5cf8e499…` and `0x8d346f24…`. Their Sourcify tree `src/contracts/PositionManager.sol` with FeeEscrow, ReferralEscrow and Notifier matches Flaunch's layout [UNVERIFIED attribution].
- **Pump.fun**: `PumpV4Hook` `0x14bcc18f…` [LIVE: Sourcify name].
- **Stock-specific hooks**:
  - `PairV4Hook` and two `LaunchHook`s: 4.5K and 6.7K stock pools.
  - `SessionHook` `0x30c714bb…` / `0x0a1e2c2b…`: `beforeSwap` reverts `MarketClosed` outside 09:30–16:00 NY Mon–Fri, and pools are 0-fee.
  - `EquityLaunchHook` and `SentryStockFeeHookV3`.
  - **FablesRWA**: a per-pool session-aware dynamic-fee hook with an on-chain `MarketCalendar`; fees tier open/overnight/closed, with an opening descent and a closing ramp.
  - `ArrakisPrivateHook` `0xa4e6f550…`.
  - `ZiaFeeHook` `0x64e9ae10…`.
  - **What The Hook** `0xc52fc526…`.
  - **MoleHook** `0xb2c9A0af…`: 9 pools.
- **Not found on 4663**: "Bags" (a Solana launchpad) and any Robinhood-operated hook.

### 3.4 Stock pools: exact TVL and executable depth, v3 vs v4 [LIVE @ 72,827,502]

Method: walk every initialized tick (v3 `tickBitmap`/`ticks`; v4 `StateView.getTickBitmap`/`getTickLiquidity`) and integrate the liquidity segments. Depth is the USD needed to move the pool price by −2/−1/+1/+2%. Pools included have TVL > $20K with both sides priced.

The top 40 by TVL:

| venue | pair | fee | hook | pool / poolId | TVL USD | depth −2% | −1% | +1% | +2% | pool px | Chainlink/ref px |
|---|---|---|---|---|---|---|---|---|---|---|---|
| v3 | USDG/NVDA | 0.050% | – | `0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3` | 5,759,264 | 1,195,104 | 863,809 | 798,281 | 1,397,653 | 224.86 | 225.66 |
| v4 | USDG/META | 0.300% | – | `0x5875d407a42965b0…` | 4,998,521 | 836,999 | 542,901 | 377,488 | 642,875 | 746.85 | 748.65 |
| v4 | SPY/USDG | 0.300% | – | `0xfe2a80bb5618fd14…` | 3,871,507 | 1,562,864 | 956,217 | 845,075 | 1,246,654 | 770.92 | 772.33 |
| v3 | USDG/GLD | 0.300% | – | `0x7a6a053eccf1446a2633e05aa6d40d09381997ec` | 3,139,852 | 568,984 | 255,289 | 219,694 | 405,717 | 392.49 | 389.01 |
| v3 | SPCX/USDG | 0.050% | – | `0xc61284332117c3fb23a2a56cceffd07f7af60029` | 2,518,218 | 449,418 | 280,388 | 275,356 | 481,812 | 148.57 | 148.64 |
| v3 | USDG/SGOV | 0.300% | – | `0xfab520051f96f4d2a32c22b6a3dd7fffdf231bfe` | 2,394,137 | 815,412 | 753,249 | 1,570,824 | 1,581,503 | 100.99 | 101.17 |
| v3 | USDG/CRCL | 0.300% | – | `0x654e4143e82a5824445ade0824351c2a9acd95a8` | 2,018,438 | 138,347 | 73,557 | 69,667 | 118,371 | 87.55 | 87.36 |
| v3 | USDG/USO | 0.300% | – | `0x02175608f1b5e6b5ed221ccfdc7be197d111d915` | 1,955,393 | 388,349 | 202,641 | 200,097 | 402,906 | 151.14 | 148.70 |
| v4 | SPY/USDG | dynamic | `0xa0e8fbff…` | `0x8674c1c5544f3c95…` | 1,823,884 | 551,244 | 336,883 | 394,486 | 650,725 | 771.80 | 772.33 |
| v3 | USDG/GLD | 0.050% | – | `0xba2f1ed4ceb2169d538d1e614d847e83c5a55913` | 1,722,695 | 462,108 | 291,354 | 213,349 | 336,263 | 392.81 | 389.01 |
| v3 | WETH/SPY | 0.050% | – | `0xddcbba3666f578e3f09516f21ff85bfee859ab5e` | 1,718,503 | 219,081 | 113,351 | 100,334 | 182,488 | 771.24 | 772.33 |
| v4 | USDG/GLD | dynamic | `0xb608a787…` | `0xfe281bbfa9aa658c…` | 1,616,514 | 392,157 | 235,860 | 210,090 | 310,000 | 393.32 | 389.01 |
| v4 | SPY/QQQ | 0.050% | – | `0xf38009b348295f90…` | 1,430,913 | 331,664 | 320,255 | 289,074 | 483,445 | 772.41 | 772.33 |
| v3 | USDG/QQQ | 0.050% | – | `0xd60a5d14db690b7afad71f76b108071d7175597d` | 1,350,597 | 338,452 | 176,171 | 187,586 | 298,658 | 745.25 | 745.36 |
| v4 | USDG/MSTR | 0.250% | – | `0x319bac87e616a89e…` | 1,341,508 | 84,585 | 43,423 | 43,073 | 83,840 | 159.03 | 158.70 |
| v3 | RDDT/USDG | 1.000% | – | `0xa8744e76aed23b05f0126335e7bd38f7935d19fe` | 1,215,183 | 134,074 | 70,080 | 62,748 | 125,786 | 151.27 | 175.02 |
| v4 | SPCX/USDG | 1.000% | – | `0xcb6ffbcc84359535…` | 1,146,220 | 69,172 | 36,182 | 38,705 | 75,104 | 148.06 | 148.64 |
| v3 | WETH/NVDA | 0.050% | – | `0x62ab521f71431f78ac374cdbadc6cda3c8916b6c` | 1,087,106 | 139,880 | 77,177 | 57,740 | 109,512 | 224.69 | 225.66 |
| v4 | SPY/NVDA | 0.050% | – | `0xbc732a1a0baabce2…` | 1,079,504 | 152,086 | 77,188 | 76,072 | 147,961 | 774.58 | 772.33 |
| v3 | USDG/HIMS | 0.300% | – | `0xc8c90d3a1c1a24967e773ac2ad0d456ba3e31f64` | 1,071,522 | 172,212 | 106,115 | 55,151 | 102,098 | 29.23 | 27.20 |
| v4 | USDG/NVDA | 0.300% | – | `0x3bb34a44f1b2b5f3…` | 1,006,923 | 78,615 | 39,573 | 39,766 | 78,476 | 224.99 | 225.66 |
| v3 | WETH/SPCX | 0.050% | – | `0xc3c9f0171490ef0f4536fe493f3b0ebb5ee0cb5e` | 996,236 | 145,119 | 71,948 | 61,130 | 106,168 | 148.47 | 148.64 |
| v4 | TSLA/USDG | 0.300% | – | `0x8517f8071ae5b831…` | 990,015 | 115,956 | 66,220 | 92,214 | 168,324 | 372.18 | 371.75 |
| v3 | GOOGL/USDG | 0.050% | – | `0x34d0dc122cf9a8eb296fc5e0d3a233625d7d19b7` | 962,422 | 145,912 | 84,059 | 100,240 | 159,533 | 343.31 | 343.70 |
| v4 | GOOGL/USDG | 0.300% | – | `0xd4ecb79fdc521d77…` | 905,197 | 101,248 | 50,832 | 50,668 | 110,673 | 344.08 | 343.70 |
| v3 | USDG/MU | 0.300% | – | `0xd057b1bc54917855bbee58ead58647f47cab35e5` | 855,601 | 62,495 | 35,261 | 38,026 | 68,898 | 1,079.72 | 1,082.82 |
| v4 | USDG/PLTR | 1.000% | – | `0xee430ee1003e1985…` | 808,013 | 107,494 | 54,493 | 60,837 | 116,242 | 190.50 | 190.31 |
| v3 | AMZN/USDG | 0.300% | – | `0x8ac92da74ab5f3b1d024dc1943ad7e15dc4179ef` | 801,074 | 147,825 | 81,871 | 82,447 | 168,026 | 249.39 | 249.94 |
| v4 | SPY/GOOGL | 0.050% | – | `0x2bca43d9d8c75399…` | 766,663 | 147,946 | 74,539 | 62,367 | 107,543 | 772.69 | 772.33 |
| v4 | SPY/USDG | 0.050% | – | `0xe5923c8a8be481ec…` | 763,558 | 350,835 | 256,891 | 199,571 | 219,953 | 771.91 | 772.33 |
| v3 | GME/USDG | 1.000% | – | `0xe9713f453adb9245b19559790c96f470a18f2fdf` | 744,672 | 111,283 | 55,638 | 57,336 | 110,604 | 23.45 | 23.46 |
| v4 | USDG/AAPL | 0.300% | – | `0xc748f4671a867db4…` | 714,931 | 84,985 | 45,709 | 51,156 | 105,538 | 341.08 | 341.45 |
| v4 | ETH/SPY | 0.100% | – | `0x509c6c6826ef06e0…` | 704,687 | 44,966 | 22,313 | 14,624 | 23,552 | 771.59 | 772.33 |
| v3 | USDG/MSFT | 0.300% | – | `0xeb60bcd1d920ad6e102690ccfc6fb488899e1510` | 675,605 | 60,981 | 37,315 | 56,726 | 143,296 | 516.90 | 516.82 |
| v4 | SPY/AMZN | 0.050% | – | `0x68beff3b4270ffbb…` | 670,487 | 84,301 | 42,491 | 38,856 | 68,437 | 773.09 | 772.33 |
| v4 | USDG/COIN | 1.000% | – | `0x007a13fa152f6dc3…` | 651,027 | 42,476 | 21,078 | 20,942 | 41,776 | 194.79 | 194.95 |
| v4 | USDG/MSTR | 0.240% | – | `0xc105b8300ff65d75…` | 648,727 | 78,465 | 39,132 | 38,408 | 76,160 | 159.01 | 158.70 |
| v3 | COST/USDG | 0.300% | – | `0x0a2121a50a09ed0796ae81f9c53ff9398355a398` | 627,902 | 123,424 | 61,673 | 45,982 | 72,055 | 921.57 | 959.24 |
| v4 | SPY/AAPL | 0.035% | – | `0xeab0adac76db99a2…` | 612,153 | 155,904 | 140,990 | 183,416 | 209,028 | 772.74 | 772.33 |
| v3 | SPCX/USDG | 0.300% | – | `0xeb07d9587efd1778dfb9c385ec43ef6d5f9fe401` | 586,130 | 79,943 | 41,039 | 41,826 | 83,807 | 148.70 | 148.64 |

**Per stock, which venue is deeper (USDG-quoted pools only)?**

| stock | best v3 stock/USDG pool (fee) | v3 ±1% depth (min side) | Σ v3 stock/USDG TVL | best v4 stock/USDG pool (fee, hook) | v4 ±1% depth (min side) | Σ v4 stock/USDG TVL | deeper venue |
|---|---|---|---|---|---|---|---|
| NVDA | `0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3` (0.05%) | 798,281 | 5,790,797 | `0x3bb34a44f1b2…` (0.30%) | 39,573 | 1,552,129 | **v3** |
| SPY | `0xa7bb1ac63bbab0c44316e6c8c455213441689167` (0.05%) | 63,846 | 399,242 | `0xfe2a80bb5618…` (0.30%) | 845,075 | 6,482,804 | **v4** |
| GLD | `0x7a6a053eccf1446a2633e05aa6d40d09381997ec` (0.30%) | 219,694 | 4,862,547 | `0xfe281bbfa9aa…` (dyn, hook) | 210,090 | 1,719,294 | **v3** |
| META | `0x107a7cb40d8665360ba10e59471af06150a50922` (0.30%) | 25,234 | 274,602 | `0x5875d407a429…` (0.30%) | 377,488 | 5,348,158 | **v4** |
| SPCX | `0xc61284332117c3fb23a2a56cceffd07f7af60029` (0.05%) | 275,356 | 3,147,436 | `0xcb6ffbcc8435…` (1.00%) | 36,182 | 1,510,702 | **v3** |
| CRCL | `0x654e4143e82a5824445ade0824351c2a9acd95a8` (0.30%) | 69,667 | 2,018,438 | `0xdb9c34002d17…` (dyn, hook) | 30,002 | 886,958 | **v3** |
| SGOV | `0xfab520051f96f4d2a32c22b6a3dd7fffdf231bfe` (0.30%) | 753,249 | 2,742,118 | `0x2a72510d7d92…` (0.04%) | 22,443 | 52,254 | **v3** |
| MSTR | `0x17578c0e0d15da44f31677263114f71ae76653ea` (1.00%) | 23,968 | 568,579 | `0x319bac87e616…` (0.25%) | 43,073 | 2,104,501 | **v4** |
| USO | `0x02175608f1b5e6b5ed221ccfdc7be197d111d915` (0.30%) | 200,097 | 2,070,968 | `0x1f2ad5a274a7…` (0.12%) | 13,555 | 215,809 | **v3** |
| GOOGL | `0x34d0dc122cf9a8eb296fc5e0d3a233625d7d19b7` (0.05%) | 84,059 | 962,422 | `0xd4ecb79fdc52…` (0.30%) | 50,668 | 905,197 | **v3** |
| TSLA | `0xf4acdaeeb7022862a763c9b1b885e11191c889e3` (0.30%) | 39,019 | 599,044 | `0x8517f8071ae5…` (0.30%) | 66,220 | 1,175,181 | **v4** |
| AAPL | `0xaae0d815ee56e4092a5e5c2911e676fea50b2d6d` (0.05%) | 54,734 | 480,200 | `0xc748f4671a86…` (0.30%) | 45,709 | 1,001,269 | **v3** |
| MU | `0xd057b1bc54917855bbee58ead58647f47cab35e5` (0.30%) | 35,261 | 855,601 | `0x6fa3ee0048e7…` (1.00%) | 11,985 | 517,684 | **v3** |
| QQQ | `0xd60a5d14db690b7afad71f76b108071d7175597d` (0.05%) | 176,171 | 1,350,597 | – | – | 0 | **v3** |
| RDDT | `0xa8744e76aed23b05f0126335e7bd38f7935d19fe` (1.00%) | 62,748 | 1,215,183 | `0x7c2985fd7623…` (0.29%) | 7,856 | 115,822 | **v3** |
| HIMS | `0xc8c90d3a1c1a24967e773ac2ad0d456ba3e31f64` (0.30%) | 55,151 | 1,071,522 | `0x68d4f28f1432…` (0.90%) | 8,149 | 160,486 | **v3** |
| MSFT | `0xeb60bcd1d920ad6e102690ccfc6fb488899e1510` (0.30%) | 37,315 | 675,605 | `0x9194a557b6a6…` (0.30%) | 10,160 | 354,817 | **v3** |
| PLTR | `0x851680416a4f4e1c463d45171d61acddbc8554c0` (0.30%) | 15,134 | 110,714 | `0xee430ee1003e…` (1.00%) | 54,493 | 894,535 | **v4** |
| AMZN | `0x8ac92da74ab5f3b1d024dc1943ad7e15dc4179ef` (0.30%) | 81,871 | 801,074 | `0x5619cb842067…` (dyn, hook) | 8,592 | 143,520 | **v3** |
| GME | `0xe9713f453adb9245b19559790c96f470a18f2fdf` (1.00%) | 55,638 | 921,489 | – | – | 0 | **v3** |
| DJT | `0x31a89afd92f9397465649ad03226c52292fc1ae5` (1.00%) | 26,429 | 375,376 | `0x55f2df399bf6…` (0.21%) | 14,975 | 348,608 | **v3** |
| INTC | `0x2e5a92f5013a64661a49312111be2e8abd33f56a` (0.30%) | 9,168 | 158,071 | `0xf2e329e631d0…` (1.00%) | 17,891 | 541,328 | **v4** |
| AMC | `0xaa34fea710a1a737840329051d81d3b0b7c564d5` (0.30%) | 7,392 | 453,000 | `0x7499938c352d…` (0.10%) | 16,427 | 239,399 | **v4** |
| COST | `0x0a2121a50a09ed0796ae81f9c53ff9398355a398` (0.30%) | 45,982 | 627,902 | `0xd0f36f913c83…` (0.09%) | 13,914 | 59,649 | **v3** |
| LLY | `0xf212d02146a897f5f686e9d629f6a73da534324a` (0.05%) | 38,603 | 589,483 | `0x23b1d33a2158…` (0.08%) | 9,683 | 89,786 | **v3** |
| COIN | – | – | 0 | `0x007a13fa152f…` (1.00%) | 20,942 | 651,027 | **v4** |
| AMD | `0x48d284a2a4d3dc1b3da08231fe44317e7e7aa51f` (0.30%) | 7,971 | 117,900 | `0xde9f85fdd9e0…` (1.00%) | 20,985 | 435,109 | **v4** |
| SLV | `0x8cb787e6c315d464775289bad00fdd67d53ecb3d` (0.30%) | 37,672 | 439,869 | – | – | 0 | **v3** |
| RBLX | `0x2ef5945cd5664876b6481fdacfaa2942995a4da8` (1.00%) | 10,351 | 382,180 | – | – | 0 | **v3** |
| TSM | `0x07e8ea83d4c1340774c8965125e26e12bf943bf1` (1.00%) | 6,439 | 128,351 | `0x0ba5d53d2f62…` (0.75%) | 21,916 | 249,288 | **v4** |

**Deepest stock/USDG liquidity is split.**

- SPY and META liquidity concentrates in v4 no-hook 0.30% pools:
  - SPY `0xfe2a80bb…c526cd`
  - META `0x5875d407…6ae6d`
- There is also a large **SPY/QQQ v4 0.05%** stock/stock pool, $1.43M.
- NVDA, SPCX, GLD, QQQ, GOOGL and SGOV concentrate in v3 0.05%/0.30% pools.

For names with a Chainlink feed, pool prices sit within about 0.1–0.9% of the feed: SPY −0.18%, META −0.24%, NVDA −0.36%, TSLA +0.1%.

- GLD pools print about $392.5 against the RH API mid of $389.0; the Chainlink `GLD / USD` feed reads 392.87.
- Names without a Chainlink feed are referenced to the RH `/prices` mid, and **that mid is unusable off-hours**. At 05:32 UTC RDDT was quoted 150.04/200.00, HIMS 24.99/29.40 and COST 903.6/1014.9 [UNVERIFIED: RH API]. The apparent gaps (RDDT pool $151.27 vs a "ref" of $175.02, HIMS +7%, COST −4%) are reference error, not pool mispricing.
- TVL and market-cap figures for feedless names carry this error.

Stock float held in DeFi contracts [LIVE]:

| venue | stock tokens held (all 204 tokens, priced as in §9) |
|---|---|
| Uniswap v4 PoolManager | $58.4M, 34.8% of the $167.5M market cap |
| v3 pools (top 4,000 by known side) | ≈$26.3M |
| Lighter RH contract | $9.05M |
| Morpho | $17K |

### 3.5 Uniswap v2 and other DEXes

- **Uniswap v2** [LIVE]: 61,510 pairs, estimated total TVL $13.2M. No stock pair is material; the largest is RIPE/NVDA at ~$76K.

| pair | address | est. TVL USD |
|---|---|---|
| WETH/VIRTUAL | `0xd95e8e2cd04c207625c6f23c974d365a5f3a91d3` | 2,574,317 |
| USDG/NET | `0x59f95461e68e0c77605299791e1449f175165b54` | 607,573 |
| WETH/PRISM | `0x126a9f6ee2e4be592c3520579ba9b48327a3d5e0` | 559,255 |
| WETH/TAKO | `0x1308fe01a0eafceca503521b7d6fbcd4bc7599a4` | 522,046 |
| WETH/WOOD | `0xbf3bb81de6285b8310a028d1c2cd38f9419d54c1` | 479,395 |
| WETH/USDG | `0x8803c117ccae7b5146297876c2a25df135141c4d` | 403,979 |
| WETH/VOLT | `0x02d356acd227e12a9573f0499f133c6e3b0af1c9` | 342,950 |
| WETH/HOODRAT | `0x451c0da3b774045a822a129eedcc5c667dcbfdd8` | 253,438 |
| WETH/ARROW | `0xe40d98d88038e0b844f844dce6ae3c79ec01ec53` | 246,950 |
| WETH/COUPONS | `0x13bc28ec6a29b1843872750d9af7161402dc25bb` | 220,437 |
| WETH/astro | `0x3416b8d8aa6ae642ffdc2f65165ff479d4bd3007` | 211,148 |
| USDG/VIRTUAL | `0xee8d21c0e5aaa31269867db4e3c66a90c3d5951d` | 187,504 |

Other DEXes and propAMMs [UNVERIFIED: DefiLlama chainTvls "Robinhood Chain", fetched 2026-09-26]:

- Fables (v4 hook DEX): $49.9M TVL. Registry `0x159a113e012593d9b3cc63ad45e30f0467e13ef3` [LIVE] lists 38 pools.
- Ramses CL V2: $8.0M.
- up v3: $7.0M.
- SushiSwap V3: $2.5M.
- PancakeSwap V3: $2.5M.
- Ekubo: $1.7M.
- GIGA V3: $1.2M.
- Alandale V3: $1.2M.
- STONX (Ekubo): $1.2M.
- Curve: $0.64M.
- Ramses DLMM, Kittenswap (Algebra), Hybra, BrownFi, Twofold, Deepstate and others below $0.5M.
- Not present: Aerodrome, Velodrome, Camelot, Balancer, Maverick, Fluid DEX. Ramses (a Solidly/CL fork) and Kittenswap (Algebra) are the nearest equivalents.
- **propAMMs**: **Rialto** (propAMM exchange, launched with Robinhood and Offchain Labs) and **Pleiades** (proprietary AMM, named as a day-one partner) [UNVERIFIED: news]. RH docs describe propAMM liquidity as composable [DOCS: building-with-stock-tokens]. I found no contract addresses.
- **RFQ**: RH docs name 0x RFQ, 1inch Fusion and LiFi as the stock-token RFQ sources [DOCS].
- **Aggregators**:
  - LiFi supports chain 4663 [UNVERIFIED: li.quest/v1/chains].
  - KyberSwap aggregator routes on `robinhood` (live USDG→WETH quote) [UNVERIFIED: KyberSwap API].
  - Relay: erc20Router `0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f`, approvalProxy `0xccc88a9d1b4ed6b0eaba998850414b24f1c315be` [LIVE code] [UNVERIFIED: Relay API].
  - MoleRouter `0x7D74a0959A321e362aDb171E405Ee97ADA6ca79d` (69 bps fee) [LIVE code].
  - Arcus Spot Router: RFQ plus AMM. When there is no native fill it delivers non-transferable `wTSLA`-style wrapped tokens [DOCS: docs.arcus.xyz].

---

## 4. Oracles

### 4.1 Chainlink (primary)

Source: [DOCS: docs.chain.link/data-feeds/tokenized-equity-feeds/robinhood; RDD `feeds-robinhood-mainnet.json`]. Values [LIVE, read at 2026-09-26 05:12 UTC].

- 58 feeds: 35 "Robinhood X / USD" equity feeds plus 23 crypto/stable/exchange-rate feeds.
- **Only 35 of the 204 stock tokens have a Chainlink feed.** The RH docs say "every Stock Token has a live Chainlink price feed", but the RDD for robinhood-mainnet lists only these [LIVE][DOCS]. Morpho markets on feedless names use "Uniswap V3 Pool Price in USD" adapters (§1.3).
- All equity feeds have 8 decimals, a 86,400 s heartbeat and 0.5% deviation (RDD), and are tagged `us_equities_24/5`.
- Every equity feed has a second **SVR** proxy (Smart Value Recapture, OEV-capturing).

| feed | proxy (std) | SVR proxy | dec | heartbeat | deviation | market hours | answer | age at read |
|---|---|---|---|---|---|---|---|---|
| Robinhood AAPL / USD | `0x6B22A786bAa607d76728168703a39Ea9C99f2cD0` | `0x4bDbb3150014c6Ab2C6D9347B0779c49015a2f3f` | 8 | 86400s | 0.5% | us_equities_24/5 | 341.4532 | 9.4h |
| Robinhood AMD / USD | `0x943A29E7ae51A4798823ca9eEd2ed533B2A22C72` | `0xF6d57763DFa625F4A413485261Ab2E71Ff4304CF` | 8 | 86400s | 0.5% | us_equities_24/5 | 630.0300 | 13.2h |
| Robinhood AMZN / USD | `0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C` | `0x9244830430bC7D9C9A48dd47603F24AD61f7c56e` | 8 | 86400s | 0.5% | us_equities_24/5 | 249.9420 | 13.2h |
| Robinhood ASML / USD | `0xB4106147E8cce40b7d46124090d373A71b70f87D` | `0x3eFBba343e2b1cF9ed4d4D5768e20B70307Aa8c9` | 8 | 86400s | 0.5% | us_equities_24/5 | 1,744.4867 | 13.1h |
| Robinhood BABA / USD | `0x62Cc8F9b5f56a33c9C8A60c8B92779f523c4E984` | `0xDB69948B26050818E8c9f43300F78b2582e67260` | 8 | 86400s | 0.5% | us_equities_24/5 | 109.6650 | 9.3h |
| Robinhood CLSK / USD | `0x810c12D3a554Bc47fd39597Fe3b3AAC4941F50eF` | `0x951C5E9a2a065053035D4B812b1f6cA7e64c5102` | 8 | 86400s | 0.5% | us_equities_24/5 | 13.9450 | 9.4h |
| Robinhood COIN / USD | `0xA3a468A452940B7D6b69991207B508c609a98Ef2` | `0xA7F7D79D578fb007384BaDF42c8E1D76a6a63bBD` | 8 | 86400s | 0.5% | us_equities_24/5 | 194.9550 | 9.5h |
| Robinhood CRCL / USD | `0x6652eDf64bA3731C4F2D3ce821A0Fb1f1f6b482a` | `0x025Ba3B3569Ca7d15Da7BFC1648F13F06A072851` | 8 | 86400s | 0.5% | us_equities_24/5 | 87.3600 | 6.1h |
| Robinhood CRWV / USD | `0xe1b3aABCAFAd1c94708dc1367dcfF8Aa4407487C` | `0x288b837A17fED1aa00c1df832ef79D0C77336c10` | 8 | 86400s | 0.5% | us_equities_24/5 | 87.7570 | 7.5h |
| Robinhood DELL-USD | `0x1C6c8cADBe02E19129c39dDB92281cE4c0bf206b` | `0xe9B94828424a8Efe6e773c28AB5Fd486851867c8` | 8 | 86400s | 0.5% | us_equities_24/5 | 563.3759 | 9.6h |
| Robinhood EWY / USD | `0xEFdf54610B62A7753Ec30bDc380847c12D32e1D1` | `0x26bca2a89D2D23787ada8F91B849608c51A26977` | 8 | 86400s | 0.5% | us_equities_24/5 | 187.2100 | 11.5h |
| Robinhood GME / USD | `0x27C71df6A64fB476468EdF256CF72c038baB5B67` | `0x42A4652D447A5B0bccF3B265bE8530b85A33b3A2` | 8 | 86400s | 0.5% | us_equities_24/5 | 23.4560 | 9.2h |
| Robinhood GOOGL / USD | `0xF6f373a037c30F0e5010d854385cA89185AE638b` | `0xA04EE5c4c8827F17e82f93bE9e19DeA221A749a8` | 8 | 86400s | 0.5% | us_equities_24/5 | 343.6966 | 12.5h |
| Robinhood INTC / USD | `0x3f390C5C24628Ac7C489515402235FeAD71D1913` | `0x127B1DeDeE6269E962a59E6C1295b4002c56c403` | 8 | 86400s | 0.5% | us_equities_24/5 | 123.4150 | 9.6h |
| Robinhood IONQ / USD | `0x22EfeC4919baf55F360E0EDee4AbEB26DE4971eb` | `0x926D7D95E554D1e671EB2C0d238fe37a2C23A64E` | 8 | 86400s | 0.5% | us_equities_24/5 | 45.2367 | 5.9h |
| Robinhood META / USD | `0x7C38C00C30BEe9378381E7B6135d7283356D71b1` | `0x5cBC53D382E56cBb223f118CF8Eefb6c9c2759f5` | 8 | 86400s | 0.5% | us_equities_24/5 | 748.6501 | 5.5h |
| Robinhood MSFT / USD | `0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E` | `0xaD6D88eab22aa4867Efe807a5311Ed64962f740D` | 8 | 86400s | 0.5% | us_equities_24/5 | 516.8233 | 11.9h |
| Robinhood MSTR / USD | `0x396118bdFB181e6240E74D243F266B061c0edc3D` | `0x2521a77F42098357e83bDea7fBb2A38745bf9280` | 8 | 86400s | 0.5% | us_equities_24/5 | 158.6970 | 9.3h |
| Robinhood MU / USD | `0x425EEFdCf05ed6526C3cE61Af99429A228a6d596` | `0x5b40F4E78FA58B60a4F59b8cc8cB8d2Fb0690467` | 8 | 86400s | 0.5% | us_equities_24/5 | 1,082.8160 | 12.2h |
| Robinhood NBIS / USD | `0xE1D87B116Ba0fe898998f1D140339D1fA1E09705` | `0xCa59A8F53bf4E0628CC0b1BD3a2216F2F8E04770` | 8 | 86400s | 0.5% | us_equities_24/5 | 238.2064 | 6.8h |
| Robinhood NVDA / USD | `0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15` | `0xCF169363636D73dbBf77733629CB38919d14232d` | 8 | 86400s | 0.5% | us_equities_24/5 | 225.6602 | 9.3h |
| Robinhood ORCL / USD | `0x0e6a64a2B58A6693a531E6c555f3A5d042eEA844` | `0x2a07f8d87d369Bd8Bc36472337ae02d512a7b5e5` | 8 | 86400s | 0.5% | us_equities_24/5 | 137.7380 | 9.7h |
| Robinhood PLTR / USD | `0x820ABedFF239034956B7A9d2F0a331f9F075eB4c` | `0x8cd1DFC0fc61fcA55FA77b37e008A90f13364Fce` | 8 | 86400s | 0.5% | us_equities_24/5 | 190.3150 | 9.7h |
| Robinhood QQQ / USD | `0x80901d846d5D7B030F26B480776EE3b29374C2ae` | `0x41ed2c58611790af0760e31e80Bb427e4e83D603` | 8 | 86400s | 0.5% | us_equities_24/5 | 745.3597 | 13.1h |
| Robinhood RGTI / USD | `0x2A045cF1C49c61c166C036d2f06FA2D2d984f765` | `0xC9C477AEfF7eD1BB89B84F7907E2e11707491466` | 8 | 86400s | 0.5% | us_equities_24/5 | 16.6950 | 9.3h |
| Robinhood RKLB / USD | `0x045477BF65Aef6f4F2386ad0164579e48381CC74` | `0x955c60932E517B36be137Eee78E65343cBFC9D29` | 8 | 86400s | 0.5% | us_equities_24/5 | 73.9000 | 10.7h |
| Robinhood SGOV-USD | `0xa0DF4ee0fFf975306345875E3548Fcc519577A11` | `0xa7a18Ca3F19E17FfA28F92302B817Ca8c1A94b06` | 8 | 86400s | 0.5% | us_equities_24/5 | 101.1685 | 5.2h |
| Robinhood SLV / USD | `0x209b73908e92Ae021826eD79609845451Ecba2ce` | `0xdA81cD9c76F1D3Ea32655dfFc7408ef22BB0Ee2a` | 8 | 86400s | 0.5% | us_equities_24/5 | 58.2750 | 10.6h |
| Robinhood SNDK / USD | `0xfb133Fa4B7b385802B693a293606682Df47109A3` | `0xd1016D9Da414B13D55abe02221A8A145eB89aA0D` | 8 | 86400s | 0.5% | us_equities_24/5 | 1,778.5400 | 12.1h |
| Robinhood SPCX / USD | `0xB265810950ba6c5C0Ff821c9963014a56fD8Bffb` | `0x42a95341ff361e81fd934F39943c5C98F6991844` | 8 | 86400s | 0.5% | us_equities_24/5 | 148.6430 | 9.7h |
| Robinhood SPY / USD | `0x319724394D3A0e3669269846abE664Cd621f9f6A` | `0xa68CA83408bE3f78d1c58a82081c619e9d21486d` | 8 | 86400s | 0.5% | us_equities_24/5 | 772.3280 | 13.2h |
| Robinhood TSLA / USD | `0x4A1166a659A55625345e9515b32adECea5547C38` | `0xE4479F01738B4e8C428CD8eB72D47AB9BC3c7de6` | 8 | 86400s | 0.5% | us_equities_24/5 | 371.7471 | 10.2h |
| Robinhood TSM / USD | `0x874cF94aa8eC88Fd9560094dD065f2fB3E41Fc2F` | `0xB48D6D5729Ca032ca43729F4b605bBf9f257A84d` | 8 | 86400s | 0.5% | us_equities_24/5 | 452.0363 | 12.2h |
| Robinhood USAR-USD | `0xA994d3684e8400A6c8078226925779FdeE682DD9` | `0x451B1295aA84FD6d6b58af1a5002eA1b1A1913A0` | 8 | 86400s | 0.5% | us_equities_24/5 | 15.1950 | 9.3h |
| Robinhood USO / USD | `0x75a9c76Ef439e2C7c2E5a34Ab105EcFe3766431c` | `0x6D054DECb74Cf8ef3675B0Abc100e02921176EdF` | 8 | 86400s | 0.5% | us_equities_24/5 | 148.6983 | 8.4h |
| BTC / USD | `0xa2c5184bF03d373Dc9dE4876eb4Bce595B460251` | `0x5a74F49d16fd0Cb866766d7e8EDb54DE36F6645A` | 8 | 86400s | 0.5% | Crypto | 83,755.5300 | 14.8h |
| BTC.B / USD | `0x5BB5e6a17a477d5B6Fec77b4322daD4A66bFb732` | `0x7097e57539201dd96d1ca4db82bd3A3013B73D9D` | 8 | 86400s | 0.5% | Crypto | 83,944.5045 | 13.1h |
| CBBTC / USD | `0x0009cD492adf8167f9eEBf1293556A673530a21a` | `0x3546407C5F94dD7Eab3a853D245b5C5EAb53318a` | 8 | 86400s | 0.5% | Crypto | 83,754.4281 | 14.8h |
| ENA / USD | `0x2A291496b3aa19d8948e442Ef28Ee952f3Ee97E8` | `0x68350E7a5f6b17d2d72231F2F33b2CfBAE408E23` | 8 | 86400s | 0.5% | Crypto | 0.2766 | 0.0h |
| ETH / USD | `0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9` | `0x5058aDee53b04e374d8bEDbAD634Bc4778F50b22` | 8 | 86400s | 0.5% | Crypto | 2,686.8100 | 13.2h |
| EURC / USD | `0xfF2B10c1973eD10c841434f98e456d8f3a0D7DD8` | `0x785b8C8831CEFb9F165548872aCa11425F33Cd95` | 8 | 86400s | 0.5% | Crypto | 1.1394 | 12.3h |
| GLD / USD | `0x470A51258068043bd43dC0a56245625C9fE86eB0` | – | 8 | 86400s | 0.5% | Crypto | 392.8722 | 15.7h |
| LBTC / USD | `0xa621344AdAEE699491597Fd8890E0C59a5BFBE59` | `0x55F3a8f8D0b41a3DC02F117e5DE04CC7CAcc1879` | 8 | 86400s | 0.5% | Crypto | 84,207.5384 | 13.1h |
| LINK / USD | `0xe86e3422Aa9B5e8ee9f3E41a63975bC387A8bce9` | `0xB7F054718bD802716FA7bD5944Df2f50a8D0424E` | 8 | 86400s | 0.5% | Crypto | 14.1079 | 0.8h |
| SYRUPUSDC / USD | `0x8765c3B9Cda41d1029E780D0c1C37C8200DC4675` | `0x4a3A14febFD43c4cd8adFAE609f1fcCfd62E7538` | 8 | 86400s | 0.5% | Crypto | 1.1842 | 13.4h |
| SYRUPUSDC / USDC Exchange Rate | `0x6317f016FA3e312C4625dee51d32b43a223011f8` | – | 18 | 86400s | 0.05% | Crypto | 1.1849 | 7.7h |
| SYRUPUSDT / USDT Exchange Rate | `0xBB688c0184Ce03fEdac89D71ccE752Ab21bC2999` | `0x7F7Fa3ab20d36689F854Cb6a788bF9fcd383B414` | 18 | 86400s | 0.05% | Crypto | 1.1448 | 10.1h |
| USDC / USD | `0x9e6f4605992a899eE2999999F3Ec80C41F452546` | `0x8929d7B1989459b3b1ec69066A06eab5c93B6d85` | 8 | 86400s | 0.5% | Crypto | 0.9999 | 13.6h |
| USDE / USD | `0xb9fB4e65744E4178894f7C61CF80E8a48A5f224a` | `0xd9B1f2958298F25bf1289B5aaB7fB6d1B7416c95` | 8 | 86400s | 0.5% | Crypto | 0.9997 | 13.5h |
| USDG / USD | `0x61B7e5650328764B076A108EFF5fa7282a1B9aD2` | `0x901f56689360B89D7767a8acE28B7801e6348fa2` | 8 | 86400s | 0.5% | Crypto | 1.0000 | 13.6h |
| USDS / USD | `0x2D88D75b625633dCcd65d9d53BfDD3Aea2d8e84f` | `0x08b18ae3AB64323Fe7e6f7b86e126d9F54e20B95` | 8 | 86400s | 0.5% | Crypto | 0.9999 | 13.5h |
| USDT / USD | `0xbf3550B6fAe1671da7C238Af12e03Ac586BEf3B1` | `0x84dD63d9162DaA201c4Ea0a6dDbfBFB274F4514D` | 8 | 86400s | 0.5% | Crypto | 0.9998 | 13.6h |
| WBTC / USD | `0x62107b0d3adA75fc1697fD342d99eed947a3aA5E` | `0x43AF1Fc55DeAD1766fe96432148A069Cfd52D138` | 8 | 86400s | 0.5% | Crypto | 83,715.7147 | 15.4h |
| WEETH / EETH Exchange Rate | `0xb63f44E40aA811Cc69Fc55da786a5F3834100B4A` | `0xFeDe0c0172960F3E5915a94Db84a7ae415F096d7` | 18 | 86400s | 0.05% | Crypto | 1.1044 | 13.5h |
| WEETH / USD | `0xf882e1D50352aecB0Ac85378378918BCf40511e7` | `0x8A6f8b17D6faBFf4c400F7C9edb6872573F85F48` | 8 | 86400s | 0.5% | Crypto | 2,970.5491 | 13.2h |
| WSTETH / STETH Exchange Rate | `0x8E3Eb706B170c8FD1DdcD402932D952887736f9A` | `0x0D15F844B87C1EAAdC7202F5EE3C5D9B9389Bf02` | 18 | 86400s | 0.05% | Crypto | 1.2449 | 13.6h |
| WSTETH / USD | `0x3F5040B50FB37934573B210fE54B53a6F1A792E8` | `0xe382E3CD333b6466f7C31d9a6Fd979A01fE86c75` | 8 | 86400s | 0.5% | Crypto | 3,349.6252 | 6.6h |
| syrupUSDG / USDG Exchange Rate | `0xDd194C66aDcb422F188a04434e4824D70c151cF0` | `0x3bEdEA9CE3ead0Db4EA60dC497568DEdDe85dBa3` | 18 | 86400s | 0.05% | Crypto | 1.0123 | 10.1h |

Semantics [DOCS]:

- The answer is **Total Return Value = underlying price × `uiMultiplier()`**. The price is continuous across splits and dividends, and the feed reads the multiplier from the token.
- While `token.oraclePaused()` is true, the feed freezes at the last good value. The flag is advisory; keep a staleness check as the primary guard.
- There is **no heartbeat off-hours**. The 24/5 session covers regular, pre, post and overnight trading. Feeds hold over weekends and holidays; Vigil measured the 2026-09-18→21 weekend silence at 48.9–52.2 h [UNVERIFIED: mdlog/vigil README].
- RH docs recommend a sequencer-uptime check, but **Chainlink publishes no L2 sequencer-uptime feed for Robinhood Chain**. The docs.chain.link L2 sequencer page lists Arbitrum, Base, Celo, Mantle, MegaETH, Metis, OP, Scroll, Soneium, X Layer and zkSync only [DOCS].
- **Chainlink Data Streams** verifier proxy: `0xcE73c8ad08CBDEaCa6078BF0627C8fe0a9a536E7` (7,009 B) [LIVE][DOCS: docs.robinhood.com/chain/data-streams].
- CCIP (§7) also runs on 4663.

### 4.2 Other oracles

| oracle | status on 4663 | evidence |
|---|---|---|
| Pyth Core (pull) | **not live**. `0x2880aB155794e7179c9eE2e38200202908C17B43` holds a 1,067-byte uninitialized Wormhole-receiver `setup(...)` stub with no EIP-1967 implementation; `priceFeedExists` reverts. Robinhood is absent from the Pyth Core EVM address list | [LIVE][DOCS: docs.pyth.network] |
| Pyth Pro (Lazer) verifier | **live**: `0xACeA761c27A909d4D3895128EBe6370FDE2dF481` (ERC1967, impl `0xd8f4a467…`, `version()` 0.2.0, `verification_fee` = 1 wei) | [LIVE][DOCS: docs.pyth.network/price-feeds/pro/contract-addresses] |
| API3 | **live**: Api3ServerV1 `0xEa5f320Ee0ef7E81AFAf2a9b4FBc1a7d093287fe`, OEV extension `0x1B3F9f25…`, ReaderProxyV1Factory `0xEfC5883a…`, AirseekerRegistry `0xbd553312…`. dAPIs set: USDT/USD, USDG/USD, CASHCAT/USD, AI/USD, PONS/USD, frxUSD/USD (**no equities**). 115 updates in the last 600K blocks. Also dApp aliases "morpho-api3" and "SWAN Protocol" on robinhood | [LIVE][DOCS: @api3/contracts v42.0.0] |
| Stork | **deployed but idle**: `0xacC0a0cF13571d30B4b8637996F5D6D774d4fd62` (impl `0xf89cef90…`, `version` 1.0.6, `validTimePeriodSeconds` 3,600). 0 logs in the last 100K blocks | [LIVE][DOCS: docs.stork.network] |
| RedStone | not found: `@redstone-finance/chain-configs` 0.9.0 has no 4663; the push-feeds app only maps a chain id | [DOCS] [UNVERIFIED] |
| Chronicle | not found: the docs site was unreachable and no Chronicle addresses were identified | [UNVERIFIED] |
| Supra | not listed on the Supra pull-oracle networks page | [DOCS] |
| RH "Oracles & Price Feeds" page | Chainlink only; per-stock feeds; stock feeds 24/5; oracle pause during corporate actions | [DOCS: docs.robinhood.com/chain/oracles-and-price-feeds] |

### 4.3 Which prices update 24/7?

- **Crypto feeds**: 24/7 by deviation (0.5%) and heartbeat (24 h) [DOCS/LIVE]. Equity feeds do not update 24/7 [DOCS/LIVE].
- **24/7 stock marks come only from trading venues**:
  - Uniswap v3/v4 pools, permissionless.
  - Lighter RH perps and spot (`trading_hours` empty).
  - Arcus perps: an internal EWMA mark off-hours, banded around Friday's VWAP.
  - Meridian mPerps: frozen off-hours.
- RH `/rhj/prices` offers `tokenBid`/`tokenAsk` (multiplier-adjusted) with a 15 s cache [DOCS: stock-token-apis]. Its off-hours quotes can be very wide: on Saturday RDDT was quoted 150.04/200.00, while the NVDA spread was 0.06% [UNVERIFIED: RH API].

The design consequence: an on-chain NAV or hedge-ratio oracle for weekends has to come from pool TWAP or perp mark, with bands. Otherwise the vault has to stop accepting flow.

---

## 5. Stock tokens

### 5.1 Contracts and enumeration [LIVE]

- **Beacon = AccessControlsRegistry**: `0xe10b6f6b275de231345c20d14ab812db62151b00`. The same contract is the UpgradeableBeacon, holding `implementation()` = `0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2`, plus the role registry, the blocklist and the global pause.
  - The implementation is `src/Stock.sol:Stock`, solc 0.8.33, an exact match on Sourcify (verified 2026-09-08).
  - The registry was upgraded twice, at blocks 7,796 and 657,134, and paused once, from block 611,101 to 611,243.
- **204 stock/ETF tokens** were found via `BeaconUpgraded(beacon)` logs. Every one has EIP-1967 beacon slot `0xa3f0…3d50` = registry (**204/204 verified**).
  - 195 appear in `GET api.robinhood.com/rhj/assets`.
  - 9 are on-chain but not in the API: WEEK, ARM, NASA, RVI, NOK, DRAM, ZETA, JEPQ, PEACH_DEFI_1.
  - All have 18 decimals. Total market cap ≈ **$167.5M**, priced as in §9.
  - Largest: SPY $22.6M, NVDA $20.4M, SPCX $12.3M, GLD $8.7M, META $6.9M, GOOGL $6.4M, AAPL $5.4M, QQQ $5.2M, TSLA $5.0M. The full list is in the appendix (§9).
- **HOOD is not a Robinhood Stock Token.** The "HOOD" traded in pools (`0x32ac8c1d7672667d5ebdea22935f7b06fc8d496f`, supply 9,749.8) is a third-party synthetic. Subway calls it "an anonymous synthetic tracker minted by a UUPS vault at an oracle price". Classify tokens **by address** [LIVE][UNVERIFIED: Subway report]. Likewise, `0x8c864e58…` "USDG" (0 decimals) is an impostor.

### 5.2 Transfer and control semantics

Source: verified `Stock.sol`, `AccessControlled.sol` and `ERC20ScaledUIUpgradeable.sol` [LIVE: Sourcify].

- `transfer`, `transferFrom`, `approve` and `permit` require `!paused()` and **`!isBlocked(msg.sender)`, `!isBlocked(from)` and `!isBlocked(to/spender)`**, checked against the registry.
- `paused()` = the token's own pause (`TOKEN_PAUSER_ROLE`) **or** the registry-wide pause (`PAUSER_ROLE`).
- `mint` needs MINTER_ROLE; `burn(from)` needs BURNER_ROLE. Both are subject to pause and blocklist.
- **`adminBurn(from, amount)` needs ADMIN_BURNER_ROLE and has no pause or blocklist check.** It can burn any holder's balance, including a vault's or a Uniswap pool's.
- `setMetadata` can rename a token (6 renames so far: XOM, WEEK, SPCX, QBTS, VTI, NET) [LIVE].
- Role holders are **all EOAs** (`codeSize` 0) [LIVE]:

  | role | holder | nonce |
  |---|---|---|
  | DEFAULT_ADMIN | `0xd6f8…b66d` | — |
  | BEACON_UPGRADER | `0xcd8c…e094` | — |
  | FACTORY_UPGRADER | `0x697e…e553` | — |
  | TOKEN_DEPLOYER | `0x5516…e000` | 204 |
  | MINTER | `0x2b94…3a87` | 74,932 |
  | BURNER | `0x6e40…d8c1` | 12,837 |
  | ADMIN_BURNER | `0x957b…74d4` | — |
  | PAUSER | `0xe7bc…f22a` | — |
  | TOKEN_PAUSER | `0xfccf…ab23` | — |
  | ORACLE_PAUSER | `0x7369…4abc` | — |
  | MULTIPLIER_UPDATER | `0x9290…8143` | 49 |
  | METADATA_UPDATER | `0xcba1…524a` | — |
  | BLOCKER | `0x913c…28fd` | 250 |

- **Blocklist**: 246 `Blocked` and 4 `Unblocked` events. **175 addresses are blocked now; all are EOAs, no contracts.** The v4 PoolManager, Morpho, Lighter, UniversalRouter and Permit2 all return `isBlocked` = false [LIVE].
- Separately, the **chain-level compliance filter** (ArbOS 61) drops transactions that touch sanctioned addresses (§7).
- **Composability evidence**: $58.4M of stock tokens sit in the v4 PoolManager, ≈$26M in v3 pools and $9.05M in the Lighter contract. Morpho holds stock collateral. Arbitrary contracts can receive and transfer stock tokens [LIVE].

### 5.3 ERC-8056 multiplier, dividends, splits

- **The spec**: [DOCS: ERC-8056 draft "Scaled UI Amount Extension", authors from Superstate, Robinhood and Coinbase, created 2025-10-20]. Interface IDs: `IScaledUIAmount` 0xa60bf13d, `…NewUIMultiplier` 0x4bd27648, `…Balances` 0xd890fd71, `…Conversion` 0x57854fc3. The Robinhood token implements the core, NewUIMultiplier and Balances interfaces, not Conversion.
- **Robinhood's event naming differs from the draft**: the token emits `TransferWithScaledUI(from,to,value,uiValue)`, not `TransferWithUIAmount` [LIVE: source].
- **Implementation behavior**:
  - `uiMultiplier()` returns `newMultiplier` once `block.timestamp ≥ effectiveAt`, so a staged change activates lazily with no transaction.
  - `updateMultiplier(m)` takes effect immediately; `updateMultiplier(m, effectiveAt)` stages the change. Both require `!paused` and MULTIPLIER_UPDATER.
  - `balanceOf` and `totalSupply` never change; **the token is not rebasing**.
  - UI views: `balanceOfUI` and `totalSupplyUI`.
- **Economics** [DOCS: RH oracles page, Chainlink RH page]:
  - Dividends are reinvested by raising the multiplier.
  - The Chainlink price = share price × multiplier, so the token tracks total return.
  - **AMM prices are in raw-token terms and stay continuous across splits.** No LP gap should appear if the feed pause and the multiplier are coordinated.
- **Observed history** [LIVE]:
  - 47 `UIMultiplierUpdated` events; 40 tokens currently have a multiplier > 1.
  - Examples: CRWD 1.0→4.0, a 4:1 split staged for 2026-07-02 13:30 UTC, with the oracle paused from block 978,442 to 1,287,194. WEEK saw 1→2 tests plus a 2.006 multiplier. SGOV is at 1.005102, SCHD 1.00554, SPY 1.001718, NVDA 1.000775.
  - `OraclePaused` fired 3 times and `OracleUnpaused` 4 times, only for WEEK and CRWD. Per-token `Paused` happened only on WEEK.
  - Nothing is currently pending and no oracle is paused.
- **Corporate-action API**: `/rhj/corporate-actions` (FORWARD/REVERSE_SPLIT, CASH/STOCK_DIVIDEND active; merger and spin-off types reserved) [DOCS].

### 5.4 Mint / redeem

- The issuer is Robinhood Assets (Jersey) Ltd (RHJ). Stock tokens are **tokenised debt securities**: holders have no rights in the underlying shares.
- Only Authorised Participants mint and redeem, after KYB. At issuance the only AP is **BBVI**.
- The **tokenization window** runs Monday 02:00 CET/CEST to Saturday 02:00 CET/CEST. Outside it there is no mint or burn, but on-chain trading continues.
- Per-asset session tradability comes from the `/assets` `tradingCapabilities` field.
- Stock tokens cannot be offered to US persons, and the UK, Canada and Switzerland are restricted.

Sources: [DOCS: docs.robinhood.com/chain/stock-tokens, building-with-stock-tokens]. On-chain, mints and burns are EOA-driven: MINTER nonce 74,932, BURNER nonce 12,837 [LIVE]. Secondary liquidity per the docs comes from RFQ (0x RFQ, 1inch Fusion, LiFi), AMMs, propAMM (Rialto) and the Lighter orderbook.

---

## 6. Stables and assets

| asset | address (4663) | issuer / mechanism | supply [LIVE] | notes |
|---|---|---|---|---|
| **USDG** | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | Paxos Global Dollar; UUPS proxy → `USDG.sol` impl `0x68184C449E1a8f34fA18d289737129FD27B66f8F` (facets, supply control, asset protection); owner `0xcfa0388f…6f` | 694,323,184 | 6 decimals. The chain's native stable. Across maps USDC on other chains ↔ USDG here [UNVERIFIED: Across API]. LayerZero Paxos DVN exists |
| USDC / USDT | **no canonical token** | — | — | Chainlink USDC/USD and USDT/USD reference feeds exist [LIVE]. MoleSwap notes that both "USDC" entries on the explorer are 18-decimal impostors [UNVERIFIED]. `UUSD` (Unity USD) and `USDUC` also trade |
| **USDe** | `0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34` | Ethena | 340,647,870 | $337M is posted as steakUSDG collateral. Chainlink USDE/USD feed |
| sUSDe | not found | — | — | [UNVERIFIED] |
| **syrupUSDG** | `0x40858070814a57FdF33a613ae84fE0a8b4a874f7` | Maple (CCIP burn-mint pool `0x01FA676E…`) | 125,684,871 | Chainlink exchange rate 1.012330 [LIVE] |
| **spUSDG** | `0xde770c84FE66E063336b31737cFE9790f18c4087` | Spark Savings (SparkVault) | 13,970,338 | |
| **csUSDG** / csWETH | `0x0dd43641…` / `0xa003ec16…` | Clearstone (`ClearstoneWrappedCollateral`, Morpho collateral wrapper) | 1 / 0 | |
| **nnUSDG** | VaultV2 `0x99347d5F70D3838763f6Bddcf80304C8aa953B57` (plus small 'nnUSDG' tokens `0x716211fc…` and `0x96c9a686…`) | NetNet Credit (NetNet Capital Management) | $1.53M (API) | wsNET `0x63c12667…` = Wrapped Staked NET |
| **mGLO** | `0xfed493f38c1aacb4ea4e6a11f8b9287849ee0096` | Midas "Fasanara Global Open" | 35,649,381 | Earn collateral ($31.5M) |
| **WETH** | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | Arbitrum L2 WETH (canonical gateway) | — | [DOCS: protocol-contracts] |
| wstETH | `0x2dC99af320BC317c567f24eE95811dcbd5983DfD` | Lido via CCIP burn-mint | 37.40 | |
| cbBTC | `0xCEC185eB182c47d1bA1EFc84e6959e18cd620Be4` | Coinbase via CCIP | 34.22 | |
| LINK | `0x492641F648a4986844848E0beFE66D14817bCE34` | CCIP | 256.76 | |
| WBTC, LBTC, BTC.b, weETH, EURC, USDS, ENA | token addresses not identified | — | — | Chainlink USD feeds exist on 4663 [LIVE]. The RH docs say WBTC comes via LayerZero OFT [DOCS] |
| Other CCIP tokens | TAO `0xf308…`, VIRTUAL `0xc691…`, GREEN `0x355b…`, RIPE, SPX, FLOCK, W0G, USDUC | — | — | [DOCS: CCIP token directory][LIVE meta] |

---

## 7. Bridges and infrastructure

### 7.1 Chain parameters [LIVE]

| parameter | value |
|---|---|
| chainId | 4663 |
| client | Arbitrum Nitro, **ArbOS 61** (`ArbSys.arbOSVersion()` = 116 = 55 + 61) |
| head at read | 72.82M |
| average block time over the last 100k blocks | **0.1013 s** |
| per-block gas limit / speed limit | 32M / 7M gas/s (`getGasAccountingParams`) |
| `eth_gasPrice` | 0.03247 gwei |
| minimum L2 gas price | 0.02 gwei |
| ArbGasInfo L1 calldata price | 4,128,896 wei per byte |
| `getCollectTips` | **false**: first-come-first-served, no priority auctions (matches the docs) |
| block header | exposes `l1BlockNumber` ≈ 26,059,372 (Ethereum) |

- Chain owners: `0x2a153c6a1b66dbc930a8d7017230ab0253005c09` (proxy) and `0x5eb36fd3a11f3a123c046e3bf84195bb4f5a2690`.
- Network fee account `0xbc5c3a7a…`; infra fee account `0x5a2b80a9…`.
- **Transaction filterer** (ArbOS 61 compliance filtering):
  - `ArbOwnerPublic.getAllTransactionFilterers()` = **`0xebdc18a1f5c42fc25552ea233facf4054df224b7`**. It is an EOA with nonce 6,097 and 0.49 ETH.
  - Filtering has been active since `getTransactionFilteringFrom()` = 1782295200, i.e. 2026-06-24 10:00 UTC.
  - `getFilteredFundsRecipient()` = 0x0.
  - The precompile at `0x0000000000000000000000000000000000000074` is ArbFilteredTransactionsManager; it answers `isTransactionFiltered(bytes32)`. It holds **6,096 `FilteredTransactionAdded` events** between blocks 591,078 and 64,453,865, and none after that. This matches the filterer's nonce [LIVE].
- **Filtering criteria** [DOCS: docs.arbitrum.io …/compliance-filtering, docs.robinhood.com differences-from-ethereum]:
  - The sequencer screens each transaction against a salted-SHA256 hashed list of restricted addresses, supplied by TRM or Chainalysis through S3 sync.
  - Rules block a transaction from or to a restricted address. They also block ERC-20/721/1155 `Transfer` or `Approval` events that involve one, and any CALL, CREATE, CREATE2 or SELFDESTRUCT that targets one.
  - Delayed-inbox transactions are force-failed via the filterer registering their hash.
  - Burn exception: a `Transfer` to 0x0 from a restricted address is allowed, e.g. for liquidations.
  - Reads (`eth_call`, `eth_getLogs`) are unaffected, and "a blocked transfer … appears as though the event never occurred".
- **Deterministic infrastructure present** [LIVE]:
  - Multicall3 `0xcA11…CA11`, Permit2 `0x0000…8BA3`, CreateX `0xba5E…a5Ed`, Arachnid CREATE2 `0x4e59…956C`, Create2Deployer `0x13b0…beF2`, Safe Singleton Factory.
  - Safe v1.3.0 (canonical and eip155), 1.4.1 and 1.5.0.
  - ERC-4337 EntryPoint v0.6, v0.7 and v0.8.
  - L2 Multicall `0x2cAC2D899eCC914d704FeaAE33ac1bF36277DaD1`.
- The docs say max contract size is 96 KB and max init code 192 KB [DOCS].

### 7.2 Canonical Orbit bridge: parent chain is Ethereum mainnet [LIVE-L1]

- Rollup `0x23A19d23e89166adedbDcB432518AB01e4272D94`:
  - `chainId()` = 0x1237 = 4663.
  - `confirmPeriodBlocks` = 45,818.
  - BoLD, with `baseStake` 1 WETH.
  - `validatorWhitelistDisabled` = false, i.e. a permissioned validator set.
  - Owner `0x552603b4…`.
- Bridge `0xDf8755334ce7A73cCF6b581C02eA649AE3E864b3` holds **304,363 ETH**.
- SequencerInbox `0xBd0D…ba96` (`isUsingFeeToken` false); Delayed Inbox `0x1A07…7a2D`; Outbox `0xf0ce…3DE9`.
- The RH docs agree [DOCS: protocol-contracts, cross-chain-messaging]:
  - L1 gateways: Router `0x6a2E3a1e…`, ERC20 `0x85001CC4…`, Custom `0x9368EAEb…`, WETH `0xF7e12b96…`.
  - L2 gateways: Router `0x1E324B93…`, ERC20 `0xfd9b1720…`, Custom `0x91228514…`, WETH `0x1D187C3E…`.
  - Withdrawals wait 7 days; deposits take about 10 minutes.
- **Governance** [DOCS: governance]:
  - An 8-member Security Council: Robinhood ×2, BitGo, Chainlink Labs, Fireblocks, Offchain Labs, Paxos, Talos.
  - Routine changes need 6/8 plus a 7-day timelock; emergency changes need 7/8.
  - BoLD validators are run by Offchain Labs and Alchemy.

### 7.3 Messaging and bridges

| system | 4663 contracts | evidence |
|---|---|---|
| LayerZero v2 | EID **30416**. EndpointV2 `0x6F475642a6e85809B1c36Fa62763669b1b48DD5B` (24,005 B); SendUln302 `0xc39161c7…`; ReceiveUln302 `0xe1844c5d…`; Executor `0x4208d6e2…`. DVNs include LayerZero Labs, Nethermind, Horizen, BitGo, **Paxos**, Canary, StablecoinX and others. v1 endpoint `0xb6319cc6…` (EID 416) | [LIVE][DOCS: LayerZero deployments metadata] |
| Chainlink CCIP | Router `0x06fC836cf9839B1cd891C440A0a45242DA6Ae1c9`, TokenAdminRegistry `0x1912C3cF…`, ARM proxy `0xe8464c35…`, RegistryModule `0x3237c0D7…`, TokenPoolFactory `0x614B3678…`. Chain selector 6180753054346818345. Lanes: Ethereum, Arbitrum, Base, BSC, Monad, Solana, 0G, Bittensor. 18 tokens (above) | [LIVE][DOCS: CCIP directory] |
| Hyperlane | Mailbox `0x3a867fCfFeC2B790970eeBDC9023E75B0a172aa7`, IGP `0x3862A9B1…`, MerkleTreeHook `0xF16E63B4…`, ICA router `0xf2755AE2…` (domain 4663) | [LIVE][DOCS: hyperlane registry] |
| Across | Routes ETH/WETH and USDC→USDG from Ethereum, OP, BSC, Unichain, Polygon, Monad, zkSync, World Chain, Soneium, Base, Arbitrum, Avalanche, Ink, Linea, HyperEVM and others, and the reverse | [UNVERIFIED: Across API] |
| Relay | Supported (USDG and ETH solver currencies); routers listed in §3.5 | [UNVERIFIED: Relay API][LIVE code] |
| Stargate / OFT | RH docs name LayerZero OFT and Stargate for WBTC, USDG and other OFTs; addresses not identified | [DOCS] |
| Symbiosis, SoDEX, STRATO, Ellipse | listed with small TVL | [UNVERIFIED: DefiLlama] |

Sequencer: `https://sequencer.mainnet.chain.robinhood.com`; feed `wss://feed.mainnet.chain.robinhood.com`, compressed-only (RFC 7692) since 2026-09-17 [DOCS: notices-and-upgrades]. The docs recommend an archive endpoint (Alchemy) for historical reads [DOCS]. The public RPC is non-archive: it serves logs from genesis but only recent state. `eth_getLogs` is capped at 10,000 matched logs with a roughly 2.4 s query timeout, returns 429 under load, and Subway reports it escalates to 403 [LIVE][UNVERIFIED: Subway README].

---

## 8. Existing delta-neutral, LP-manager and vault products on 4663

| product | what it does | on-chain footprint | hedged? |
|---|---|---|---|
| **Subway** (github.com/EthWiz/subway) | `xAMC` pooled vault LPs a stock token against USDG on Uniswap v4. `hAMC` wraps xAMC and shorts on **Lighter RH**, with the vault as the L1 owner of the Lighter account and a trade-only keeper key. NAV floor counts hedge PnL as 0. ERC-7540-style request/settle/claim. hAMC capped at 50% of xAMC. Their Phase-0 report dated 2026-09-16 found 18 of 194 names clear the hedge bar and said NO-GO on AMC, HOOD and MSTR | "**Nothing is deployed**" [UNVERIFIED: repo README, HEAD 2026-09-17] | designed hedged; **not live** |
| **SandCastle** (`scV3-*/scV4-*`, impl `0xfcfd4493c1b1d0dadc045c5dec5e2d01af0498b4` / `0x9ec636ac…`) | LP-NFT staking wrapper that is itself a Morpho collateral token and oracle (`price()`), with `registerPosition`, `stakePosition`, `borrow`/`repay`/`supplyCollateral` via bundler. Morpho markets "V3 SPY/USDG borrow SPY" etc. VaultV2s scUSDG, scSPY, scWETH (about $100 each). EIP-1167 clones | all `totalSupply` 0 except scV4-ETH-USDG-FR (100) [LIVE] | primitive for "borrow the stock against LP"; **unused** |
| **MD LP** (`MDLP` ×9, impl `0x65842885…`, factory `0xe21d3ec4…`, owner `0xbadfade0…`) | Same pattern: LP position → Morpho collateral (`price()`, `morpho()`, `stakePosition`). SPCX/USDG etc. | all supply 0 [LIVE] | **unused** |
| **Vigil** (mdlog/vigil) | Session-aware Morpho oracle haircut, premium, backstop, pre-liquidation, with an on-chain NYSE calendar | testnet 46630 only [UNVERIFIED: repo] | lending-side risk layer |
| **Fables** (FablesRWA hooks) | Session-aware dynamic-fee v4 hooks (open/overnight/closed floors plus bell ramps) and a FablesLedger for LP accounting. Largest stock hook TVL: SPY $1.82M, GLD $1.62M, SPCX $0.36M, NVDA $0.44M, AAPL $0.29M, TSLA $0.19M… | registry `0x159a113e…`, 38 pools [LIVE] | unhedged LP; LVR mitigated by fees |
| **MoleSwap** (penguinpecker/moleswap-pro) | Aggregator plus MoleHook v4 pools (fee enforcement and TWAP), MolePositions ALM, batch-auction queue | 9 hooked pools (SPY, NVDA, TSLA, AAPL, MSFT vs USDG…) [LIVE] | unhedged |
| **Steer** / **EARN** (earnonhood, "Liquid Arc Strategy") | ALM vaults on v4/v3. 29 vaults, $0.48M, largest STEERUV417 SPY/QQQ v4 at $247K | [LIVE] | unhedged |
| **Beefy CLM** (Alandale/up33) | 16 CLM vaults, e.g. WETH/SPY $59K, USDG/NVDA $14K | [UNVERIFIED: Beefy API] | unhedged |
| **StonkBrokers Smart LP** | Immutable "volatility farming" v3 vaults; registry `0xE8749183…` | [LIVE code][UNVERIFIED: DefiLlama $0.67M] | unhedged |
| **Snuggle / MaxFi** | ALM vault `0x1195C074…` (Uniswap v3 on RH) | [LIVE code][UNVERIFIED: DefiLlama $7.4M] | unhedged |
| **Arrakis** | `ArrakisPrivateHook` `0xa4e6f550…` on TSLA/USDG and USDG/NVDA v4 pools, about $10K each (issuer MM) | [LIVE] | n/a |
| **Arcus pTokens** | Tokenized perp accounts: long and short, 1x/3x/5x, $0.66M NAV | [LIVE] | directional; the short legs are a possible hedge leg for HOOD, GME, GLD and SPCX only |
| **NetNet Capital** (NET, wsNET, nnUSDG) | Fund/reserve token plus a Morpho credit vault lending USDG against stocks | [LIVE] | no |
| **Neutral Trade**, T3tris, D2 Finance, Lagoon, Spark Liquidity Layer | Managed/allocator vaults (Accountable-style) with off-chain strategies | [UNVERIFIED: DefiLlama $2.2M / $0.8M / $0.1M] | not LP receipts |
| **Aftermarket** | Morpho oracle whose haircut grows per closed hour, plus a session premium | **on Base, not 4663** [UNVERIFIED: Vigil README] | n/a |
| **Gamma**, **Kamino-style ALMs** | not found on 4663 | — | — |
| Delta (deltaliquidity) | "Liquidity Manager" per DefiLlama; the DELTA token `0xe8ffd7e2…` is a PonsLauncherToken | [LIVE meta][UNVERIFIED] | no evidence of hedging |

**Conclusion: no live product offers a hedged LP receipt on stock tokens.** Two routes have been built but not used:

- The LP-collateral "borrow SPY" route (SandCastle, MD LP) has zero supply.
- The Lighter-hedged route (Subway) is not deployed.

---

## 9. Appendix: all 204 stock tokens

totalSupply and uiMultiplier are [LIVE @ 2026-09-26 05:17 UTC]. Market cap = totalSupply × price. Price source by token:

- **CL**: the Chainlink feed [LIVE], 35 tokens.
- **pool**: the deepest Uniswap v3/v4 pool against USDG or WETH, with ≥ $1K on the known side [LIVE], 48 tokens.
- **RH-mid\***: the RH `/prices` tokenBid/tokenAsk mid, 112 tokens. Off-hours spreads make this unreliable [UNVERIFIED: API].
- **–**: unpriced, 9 tokens.

| symbol | address | name | totalSupply | uiMultiplier | px USD | px source | mcap USD | Chainlink proxy | overnight tradable | in /assets API |
|---|---|---|---|---|---|---|---|---|---|---|
| SPY | `0x117cc2133c37b721f49de2a7a74833232b3b4c0c` | SPDR S&P 500 ETF Trust | 29,268.880 | 1.001718 | 772.33 | CL | 22,605,177 | `0x319724394D3A0e3669269846abE664Cd621f9f6A` | yes | yes |
| NVDA | `0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec` | NVIDIA | 90,447.444 | 1.000775 | 225.66 | CL | 20,410,387 | `0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15` | yes | yes |
| SPCX | `0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea` | Space Exploration Technologies Corp. Class A Common Stock | 82,610.040 | 1.000000 | 148.64 | CL | 12,279,404 | `0xB265810950ba6c5C0Ff821c9963014a56fD8Bffb` | yes | yes |
| GLD | `0xc9a981fee1f9dec688bb123ccdecc63d0debfc4e` | SPDR Gold Trust | 22,191.470 | 1.000000 | 392.49 | pool | 8,709,852 | – | yes | yes |
| META | `0xc0d6457c16cc70d6790dd43521c899c87ce02f35` | Meta Platforms | 9,182.766 | 1.000541 | 748.65 | CL | 6,874,679 | `0x7C38C00C30BEe9378381E7B6135d7283356D71b1` | yes | yes |
| GOOGL | `0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3` | Alphabet Class A | 18,588.226 | 1.000194 | 343.70 | CL | 6,388,711 | `0xF6f373a037c30F0e5010d854385cA89185AE638b` | yes | yes |
| AAPL | `0xaf3d76f1834a1d425780943c99ea8a608f8a93f9` | Apple | 15,731.368 | 1.000566 | 341.45 | CL | 5,371,526 | `0x6B22A786bAa607d76728168703a39Ea9C99f2cD0` | yes | yes |
| QQQ | `0xd5f3879160bc7c32ebb4dc785f8a4f505888de68` | Invesco QQQ | 7,025.013 | 1.000701 | 745.36 | CL | 5,236,161 | `0x80901d846d5D7B030F26B480776EE3b29374C2ae` | yes | yes |
| TSLA | `0x322f0929c4625ed5bad873c95208d54e1c003b2d` | Tesla | 13,391.239 | 1.000000 | 371.75 | CL | 4,978,154 | `0x4A1166a659A55625345e9515b32adECea5547C38` | yes | yes |
| CRCL | `0xdf0992e440dd0be65bd8439b609d6d4366bf1cb5` | Circle Internet Group | 54,986.327 | 1.000000 | 87.36 | CL | 4,803,606 | `0x6652eDf64bA3731C4F2D3ce821A0Fb1f1f6b482a` | yes | yes |
| MU | `0xff080c8ce2e5feadaca0da81314ae59d232d4afd` | Micron Technology | 4,025.654 | 1.000075 | 1,082.82 | CL | 4,359,043 | `0x425EEFdCf05ed6526C3cE61Af99429A228a6d596` | yes | yes |
| MSTR | `0xec262a75e413fafd0df80480274532c79d42da09` | Strategy Inc. | 25,486.952 | 1.000000 | 158.70 | CL | 4,044,703 | `0x396118bdFB181e6240E74D243F266B061c0edc3D` | yes | yes |
| AMZN | `0x12f190a9f9d7d37a250758b26824b97ce941bf54` | Amazon | 14,935.383 | 1.000000 | 249.94 | CL | 3,732,979 | `0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C` | yes | yes |
| GME | `0x1b0e319c6a659f002271b69db8a7df2f911c153e` | GameStop | 150,740.562 | 1.000000 | 23.46 | CL | 3,535,763 | `0x27C71df6A64fB476468EdF256CF72c038baB5B67` | yes | yes |
| HIMS | `0xccee82fe024c36fa15e1005ede3e9e4787e23d09` | Hims & Hers Health | 116,815.473 | 1.000000 | 29.23 | pool | 3,414,072 | – | yes | yes |
| SGOV | `0x92fd66527192e3e61d4ddd13322aa222de86f9b5` | iShares 0-3 Month Treasury Bond | 31,110.075 | 1.005102 | 101.17 | CL | 3,147,360 | `0xa0DF4ee0fFf975306345875E3548Fcc519577A11` | yes | yes |
| MSFT | `0xe93237c50d904957cf27e7b1133b510c669c2e74` | Microsoft | 5,931.295 | 1.000413 | 516.82 | CL | 3,065,432 | `0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E` | yes | yes |
| USO | `0xa30fa36db767ad9ed3f7a60fc79526fb4d56d344` | United States Oil Fund | 18,372.576 | 1.000000 | 148.70 | CL | 2,731,971 | `0x75a9c76Ef439e2C7c2E5a34Ab105EcFe3766431c` | yes | yes |
| PLTR | `0x894e1ec2d74ffe5aef8dc8a9e84686accb964f2a` | Palantir Technologies | 14,027.634 | 1.000000 | 190.31 | CL | 2,669,669 | `0x820ABedFF239034956B7A9d2F0a331f9F075eB4c` | yes | yes |
| AMC | `0x05a3d1cd21d0c88145e82600e62e7e496e0f222b` | AMC Entertainment | 806,549.968 | 1.000000 | 2.93 | pool | 2,362,388 | – | yes | yes |
| RDDT | `0x05b37fb53a299a1b874a619e1c4c404d52c36f4c` | Reddit | 15,361.427 | 1.000000 | 151.27 | pool | 2,323,648 | – | yes | yes |
| COIN | `0x6330d8c3178a418788df01a47479c0ce7ccf450b` | Coinbase | 11,105.548 | 1.000000 | 194.95 | CL | 2,165,082 | `0xA3a468A452940B7D6b69991207B508c609a98Ef2` | yes | yes |
| AMD | `0x86923f96303d656e4aa86d9d42d1e57ad2023fdc` | AMD | 3,030.406 | 1.000000 | 630.03 | CL | 1,909,247 | `0x943A29E7ae51A4798823ca9eEd2ed533B2A22C72` | yes | yes |
| DJT | `0x1d11f0496982706c5e14a514d4e79f2e6bde4516` | Trump Media & Technology Group | 206,996.150 | 1.000000 | 9.16 | pool | 1,895,988 | – | yes | yes |
| INTC | `0xc72b96e0e48ecd4dc75e1e45396e26300bc39681` | Intel | 13,975.167 | 1.000000 | 123.42 | CL | 1,724,745 | `0x3f390C5C24628Ac7C489515402235FeAD71D1913` | yes | yes |
| SNDK | `0xb90a19ff0af67f7779aff50a882a9cff42446400` | Sandisk Corporation | 894.256 | 1.000000 | 1,778.54 | CL | 1,590,471 | `0xfb133Fa4B7b385802B693a293606682Df47109A3` | yes | yes |
| SLV | `0x411efb0e7f985935daec3d4c3ebaea0d0ad7d89f` | iShares Silver Trust | 26,619.954 | 1.000000 | 58.27 | CL | 1,551,278 | `0x209b73908e92Ae021826eD79609845451Ecba2ce` | yes | yes |
| TSM | `0x58ffe4a942d3885baa22d7520691f611ef09e7aa` | Taiwan Semiconductor Manufacturing | 3,096.325 | 1.001463 | 452.04 | CL | 1,399,651 | `0x874cF94aa8eC88Fd9560094dD065f2fB3E41Fc2F` | yes | yes |
| COST | `0x4ea005168d7f09a7a0ba9d1def21a479950e44c2` | Costco | 1,449.134 | 1.000612 | 921.57 | pool | 1,335,482 | – | yes | yes |
| TTWO | `0x5e81213613b6b86eab4c6c50d718d34359459786` | Take-Two Interactive Software | 6,292.882 | 1.000000 | 201.41 | pool | 1,267,428 | – | yes | yes |
| LLY | `0x8005d266423c7ea827372c9c864491e5786600ea` | Eli Lilly | 933.200 | 1.000002 | 1,183.21 | pool | 1,104,168 | – | yes | yes |
| ORCL | `0xb0992820e760d836549ba69bc7598b4af75dee03` | Oracle | 7,194.137 | 1.002211 | 137.74 | CL | 990,906 | `0x0e6a64a2B58A6693a531E6c555f3A5d042eEA844` | yes | yes |
| BE | `0x822cc93ffd030293e9842c30bbd678f530701867` | Bloom Energy | 3,234.011 | 1.000000 | 286.43 | pool | 926,331 | – | yes | yes |
| NFLX | `0xe0444ef8bf4ed74f74fd73686e2ddf4c1c5591e8` | Netflix | 12,204.029 | 1.000000 | 71.26 | pool | 869,604 | – | yes | yes |
| RBLX | `0xf0c4bf4c582cb3836e98394b1d4e7b7281101be8` | Roblox | 17,385.495 | 1.000000 | 46.45 | pool | 807,586 | – | yes | yes |
| SKHY | `0x84cab63bc87912e71ad199ff14a0ba45de68fef8` | SK hynix Inc. American Depositary Shares | 4,067.514 | 1.000000 | 190.39 | pool | 774,422 | – | yes | yes |
| IBM | `0x980dcf6766fa79f5cf0c4aadb3ab477ff15a9619` | IBM | 2,948.232 | 1.000000 | 225.50 | pool | 664,823 | – | yes | yes |
| MRNA | `0x43b07d15ce533bec5476d70c22a78a1b2b662155` | Moderna | 3,076.821 | 1.000000 | 199.03 | pool | 612,367 | – | yes | yes |
| USAR | `0xd917b029c761d264c6a312bbbcda868658ef86a6` | USA Rare Earth | 39,819.196 | 1.000000 | 15.20 | CL | 605,053 | `0xA994d3684e8400A6c8078226925779FdeE682DD9` | yes | yes |
| CRWV | `0x5f10a1c971b69e47e059e1dc91901b59b3fb49c3` | CoreWeave | 6,690.727 | 1.000000 | 87.76 | CL | 587,158 | `0xe1b3aABCAFAd1c94708dc1367dcfF8Aa4407487C` | yes | yes |
| BB | `0x48e39e56acdba37b09020c0b734a613c9a2f100a` | Blackberry | 69,439.844 | 1.000000 | 8.14 | pool | 565,023 | – | yes | yes |
| DELL | `0x941ae714ec6d8130c7b75d67160ca08f1e7d11dd` | Dell | 963.560 | 1.000064 | 563.38 | CL | 542,847 | `0x1C6c8cADBe02E19129c39dDB92281cE4c0bf206b` | yes | yes |
| BABA | `0xad25ac6c84d497db898fa1e8387bf6af3532a1c4` | Alibaba | 4,830.554 | 1.000000 | 109.67 | CL | 529,743 | `0x62Cc8F9b5f56a33c9C8A60c8B92779f523c4E984` | yes | yes |
| SNAP | `0xf6589f11bc40b669e584073f428b05562f568733` | Snap | 86,522.659 | 1.000000 | 5.42 | pool | 468,915 | – | yes | yes |
| RIVN | `0xb1bf26c1d20ff267a4f93550d1e0d06ac40a114b` | Rivian Automotive | 26,714.402 | 1.000000 | 15.40 | pool | 411,527 | – | yes | yes |
| LULU | `0x4e62068525ab11fe768e29dfd00ef909b9803016` | Lululemon | 3,901.770 | 1.000000 | 101.11 | pool | 394,503 | – | yes | yes |
| LMT | `0x329fcaceb9ad6f9580dd5f643fed0646900d043c` | Lockheed | 724.026 | 1.000000 | 520.34 | pool | 376,738 | – | yes | yes |
| NBIS | `0x9d9c6684f596f66a64c030b93a886d51fd4d7931` | Nebius Group | 1,391.889 | 1.000000 | 238.21 | CL | 331,557 | `0xE1D87B116Ba0fe898998f1D140339D1fA1E09705` | yes | yes |
| GLXY | `0x2d427692e928fa156ec22acfabafa0447c5805b7` | Galaxy Digital Inc. | 13,481.636 | 1.000000 | 24.29 | pool | 327,476 | – | yes | yes |
| MRVL | `0x62fd0668e10d8b72339be2dcf7643001688ff13b` | Marvell Technology | 1,235.815 | 1.000000 | 264.17 | pool | 326,462 | – | yes | yes |
| PFE | `0x7066a64c24e4206cd62e83bf198c1e7eb361f51e` | Pfizer | 10,360.440 | 1.000000 | 28.63 | pool | 296,669 | – | yes | yes |
| NNE | `0xbef75684c43c4ea7bd18dd532a2244674ee8b926` | Nano Nuclear Energy | 16,300.572 | 1.000000 | 17.50 | RH-mid* | 285,260 | – | yes | yes |
| LITE | `0x8ef20885f94e3d9bc7eb3080279188bd5ed7c08c` | Lumentum | 297.480 | 1.000000 | 942.64 | RH-mid* | 280,418 | – | yes | yes |
| UPS | `0xf23250dac154d05bb671cb0d0ebef3c635c79ce2` | UPS | 2,785.635 | 1.002209 | 93.35 | pool | 260,026 | – | yes | yes |
| FIG | `0x41f4267525a8aff329540ef24fd83d9044758b33` | Figma | 12,404.283 | 1.000000 | 20.59 | pool | 255,369 | – | yes | yes |
| JNJ | `0x03dfbbe0ac4e7bcdafd08ed41a400326b77d8c80` | Johnson & Johnson | 915.178 | 1.000021 | 271.23 | pool | 248,226 | – | yes | yes |
| BA | `0x4d21483a44bf67a86b77e3da301411880797d452` | Boeing | 1,219.487 | 1.000000 | 197.10 | pool | 240,361 | – | yes | yes |
| F | `0x25c288e6d899b9bc30160965ad9644c67e73be0c` | Ford Motor | 18,693.869 | 1.000146 | 12.72 | pool | 237,772 | – | yes | yes |
| NU | `0x408c14038a04f7bd235329e26d2bf569ee20e250` | Nu | 15,505.413 | 1.000000 | 13.57 | pool | 210,350 | – | yes | yes |
| QUBT | `0x59818904ab4ce163b3ce4ffb64f2d6ca02c434b4` | Quantum Computing | 22,878.807 | 1.000000 | 8.99 | pool | 205,687 | – | yes | yes |
| AVGO | `0x156e175dd063a8ce274c50654ef40e0032b3fbcf` | Broadcom | 579.929 | 1.001257 | 354.25 | pool | 205,439 | – | yes | yes |
| ASML | `0x47f93d52cbec7c6d2cfc080e154002370a60daea` | ASML Holding NV | 113.965 | 1.000101 | 1,744.49 | CL | 198,810 | `0xB4106147E8cce40b7d46124090d373A71b70f87D` | yes | yes |
| BULL | `0xcef9027c7d6985b85f0ba431125073529a947a68` | Webull | 27,309.206 | 1.000000 | 7.23 | pool | 197,468 | – | yes | yes |
| NET | `0x116f00968269b7bfbad4109ce591d6e74c0601d4` | Cloudflare, Inc. Class A common stock | 474.728 | 1.000000 | 350.37 | pool | 166,331 | – | yes | yes |
| SNOW | `0xba0cab75495255d0cb58e22b648bfed4ecd1f47e` | Snowflake | 487.312 | 1.000000 | 338.00 | pool | 164,713 | – | yes | yes |
| RCAT | `0xfde6b5d9bb419b10c23268c74e369abff39c0460` | Red Cat | 23,691.655 | 1.000000 | 6.74 | pool | 159,734 | – | yes | yes |
| EWY | `0x7f0abef0c07280f82c6a08ead09ded6bae2c13fc` | iShares MSCI South Korea fund | 841.738 | 1.000000 | 187.21 | CL | 157,582 | `0xEFdf54610B62A7753Ec30bDc380847c12D32e1D1` | yes | yes |
| INDA | `0xacef2e09adb47ad6abebad9ff06689e60615c2b6` | iShares MSCI India ETF | 3,123.017 | 1.000000 | 47.78 | pool | 149,203 | – | yes | yes |
| SHOP | `0xf53f66751b1eff985311b693531e3290f600c410` | Shopify | 946.108 | 1.000000 | 142.95 | pool | 135,246 | – | yes | yes |
| SMH | `0x072f979c2cac8e1391b0162a87fee094bf8744a0` | VanEck Semiconductor ETF | 214.122 | 1.000000 | 594.83 | RH-mid* | 127,365 | – | yes | yes |
| AMAT | `0x36046893810a7e7fce501229d57dc3fc8c8716d0` | Applied Materials | 254.091 | 1.000045 | 486.15 | RH-mid* | 123,525 | – | yes | yes |
| WYFI | `0x9e7abd3c9139d14e4c86dce0e455aab7a0c2fb3e` | WhiteFiber, Inc. | 6,111.000 | 1.000000 | 19.64 | pool | 120,026 | – | yes | yes |
| DDOG | `0x27c99fbde9d0d2aa4f4bfb4943f237843ddf6958` | Datadog | 427.148 | 1.000000 | 268.48 | pool | 114,680 | – | yes | yes |
| CBRS | `0x5c90450bbb4273d7b2f17cf6917aeb237a569679` | Cerebras Systems | 530.715 | 1.000000 | 208.15 | RH-mid* | 110,468 | – | yes | yes |
| WDC | `0xf52597345a8edf418bc4071b4a35112472277d3e` | Western Digital | 232.530 | 1.000218 | 456.21 | RH-mid* | 106,083 | – | yes | yes |
| PENG | `0x9b23573b156b52565012f5ce02cdf60afbaa70be` | Penguin Solutions | 1,807.807 | 1.000000 | 56.47 | pool | 102,084 | – | yes | yes |
| SOXX | `0x75742c18bc1f1c5c5f448f4c9d9c6f66dafaaa38` | iShares Semiconductor ETF | 167.865 | 1.000451 | 570.52 | pool | 95,771 | – | yes | yes |
| RKLB | `0x3b14c39e89d60d627b42a1a4ca45b5bb45fc12e2` | Rocket Lab Corporation | 1,210.450 | 1.000000 | 73.90 | CL | 89,452 | `0x045477BF65Aef6f4F2386ad0164579e48381CC74` | yes | yes |
| ON | `0xbbd09f72b025360fee5c928053dca6248d35be54` | ON Semiconductor | 830.373 | 1.000000 | 76.92 | pool | 63,876 | – | yes | yes |
| CRM | `0xd95b44124e475743a7589e68f3d74008a5536d44` | Salesforce | 263.646 | 1.001148 | 236.47 | pool | 62,344 | – | yes | yes |
| SOFI | `0x98e75885157c80992a8d41b696d8c9c6fb30a926` | SoFi Technologies | 3,009.475 | 1.000000 | 20.29 | RH-mid* | 61,062 | – | yes | yes |
| VTI | `0x0594134df3f171a354d9c85ebd65b7a6148f6d09` | Vanguard Morningstar Total Stock Market ETF | 152.369 | 1.000000 | 375.38 | pool | 57,196 | – | yes | yes |
| ZM | `0x44c4f142009036cf477ed2d09932051843137cf1` | Zoom | 620.285 | 1.000000 | 90.16 | RH-mid* | 55,925 | – | yes | yes |
| CEG | `0xae517a2903e68bd929dfd15be875f8369d53e94a` | Constellation Energy | 206.578 | 1.000000 | 263.06 | pool | 54,343 | – | yes | yes |
| SOUN | `0x6e3dfd9f7e1649baa14d25cac18c94d62db10a54` | SoundHound AI | 8,892.271 | 1.000000 | 6.06 | RH-mid* | 53,932 | – | yes | yes |
| PATH | `0xfb2664f07b6aadd29ea7a59d8859b1aeb8645cda` | UiPath | 4,265.453 | 1.000000 | 12.57 | pool | 53,625 | – | yes | yes |
| GE | `0x63b814ddbd6bf339f25fed8c36158a008d5b373e` | General Electric | 155.277 | 1.000000 | 327.06 | RH-mid* | 50,786 | – | yes | yes |
| QCOM | `0x0f17206447090e464c277571124dd2688e48aea9` | Qualcomm | 241.110 | 1.001228 | 202.88 | pool | 48,916 | – | yes | yes |
| ADBE | `0x232b8ed6377be97813853b0ac104c4cda8378d1b` | Adobe | 201.028 | 1.000000 | 237.00 | RH-mid* | 47,644 | – | yes | yes |
| RUN | `0x756bc80af765c82da966a788858d65adf14f3793` | Sunrun | 5,496.163 | 1.000000 | 8.11 | RH-mid* | 44,574 | – | yes | yes |
| ASTS | `0x1af6446f07eb1d97c546afc8c9544cbdf3ad5137` | AST SpaceMobile | 713.625 | 1.000000 | 59.91 | RH-mid* | 42,757 | – | yes | yes |
| CCL | `0x9651342cea770ae9a2969ba2a52611523146aef9` | Carnival Corporation | 1,847.222 | 1.021486 | 22.92 | pool | 42,341 | – | yes | yes |
| FUTU | `0xeb30663bdff0622ef4e4e5cbb4e975f19f33f51d` | Futu Holdings | 280.011 | 1.000000 | 149.77 | RH-mid* | 41,937 | – | yes | yes |
| SMR | `0x1eebee7f74517e0279dfb09d25b0407beec3fdd6` | NuScale Power | 2,904.419 | 1.000000 | 14.21 | RH-mid* | 41,257 | – | yes | yes |
| KTOS | `0x7fd06a4d81ccfa3f351394e144d5191874c31313` | Kratos Defense & Security Solutions | 527.551 | 1.000000 | 73.50 | RH-mid* | 38,775 | – | yes | yes |
| HPE | `0x59dd09d4900c2e4b5f75b7c0d4e6796fcc234cb1` | HP Enterprise | 589.712 | 1.001717 | 62.61 | RH-mid* | 36,920 | – | yes | yes |
| UNH | `0xcf364ea52787e289de6f32077834056e3e70d6a8` | UnitedHealth | 97.010 | 1.004242 | 380.04 | RH-mid* | 36,867 | – | yes | yes |
| XOM | `0xf9b46d3d1b22199d4d1025a9cedb540a33f1a2d5` | ExxonMobil Holdings Corporation | 228.692 | 1.001040 | 160.12 | RH-mid* | 36,618 | – | yes | yes |
| ELF | `0x39ec44bee4f6a116c6f9b8de566848a985c53c60` | e.l.f. Beauty | 292.330 | 1.000000 | 123.78 | RH-mid* | 36,186 | – | yes | yes |
| INFQ | `0xb853bc83a753342a4f8320ea680b4b1e84118d21` | Infleqtion | 2,069.169 | 1.000000 | 17.23 | RH-mid* | 35,641 | – | yes | yes |
| WDAY | `0x82da4646242e1d962e96e932269dc644c94a9caa` | Workday | 240.398 | 1.000000 | 139.25 | RH-mid* | 33,475 | – | yes | yes |
| AAOI | `0x521cf887e6531c6f667b5bc4d896e5d9bfe8eb2e` | Applied Optoelectronics | 275.117 | 1.000000 | 106.61 | RH-mid* | 29,332 | – | yes | yes |
| FLNC | `0x282e87451e10fa6679bc7d76c69be44cd3fc777c` | Fluence Energy | 1,450.434 | 1.000000 | 18.92 | RH-mid* | 27,442 | – | yes | yes |
| LUNR | `0xa5d4968421ba94814be3b136b15cf422101ac1a3` | Intuitive Machines | 1,117.655 | 1.000000 | 22.82 | RH-mid* | 25,510 | – | yes | yes |
| SMCI | `0xc01aa1fecec0605b13bc84874ff7256c0f5f562a` | Super Micro Computer | 586.126 | 1.000000 | 41.39 | RH-mid* | 24,260 | – | yes | yes |
| APP | `0xa249baf1063af884807c1e1400aef7784836917e` | AppLovin | 74.060 | 1.000000 | 325.00 | RH-mid* | 24,070 | – | yes | yes |
| NOW | `0x0c3260af4b8f13a69c4c2dfb84fd667890cdfa14` | ServiceNow | 175.317 | 1.000000 | 134.45 | RH-mid* | 23,571 | – | yes | yes |
| P | `0x1cdad396db64bda184d5182a97dd9b3c62100b7d` | Everpure | 178.566 | 1.000000 | 126.67 | RH-mid* | 22,619 | – | yes | yes |
| FIX | `0x93dbb1d2dc5d63f4abacff30485273f538df68ac` | Comfort Systems | 13.724 | 1.000000 | 1,629.66 | RH-mid* | 22,365 | – | yes | yes |
| IREN | `0xf0ab0c93be6f41369d302e55db1a96b3c430212d` | IREN Limited | 482.993 | 1.000000 | 44.79 | RH-mid* | 21,633 | – | yes | yes |
| IONQ | `0x558378e000d634a36593e338ebacdd6207640efe` | IonQ | 467.481 | 1.000000 | 45.24 | CL | 21,147 | `0x22EfeC4919baf55F360E0EDee4AbEB26DE4971eb` | yes | yes |
| TER | `0x2778c5024d5ca2cdb0f8ead671ffc69963adcd9c` | Teradyne | 51.076 | 1.000000 | 403.51 | RH-mid* | 20,610 | – | yes | yes |
| CLOV | `0x62200915e7deab1ec7f79fb246dadbb80eacddd0` | Clover Health Investments | 2,773.018 | 1.000000 | 7.24 | RH-mid* | 20,077 | – | yes | yes |
| INTU | `0x56d23bee5f41a7120170b0c603dae30128e460e9` | Intuit | 71.601 | 1.000000 | 276.00 | RH-mid* | 19,762 | – | yes | yes |
| CSCO | `0xf543967eebb6f1917992ef0e68de63ab07a5a0da` | Cisco Systems | 183.066 | 1.000000 | 106.88 | RH-mid* | 19,567 | – | yes | yes |
| POET | `0xcf6b2d875361be807eafa57458c80f28521f9333` | POET Technologies | 2,456.108 | 1.000000 | 7.75 | RH-mid* | 19,047 | – | yes | yes |
| WULF | `0x348be1a8663f15edde5cdf8a96bb69078f7ab6fd` | TeraWulf | 1,195.879 | 1.000000 | 15.85 | pool | 18,960 | – | yes | yes |
| TTD | `0x0b5fb4031cae9163db10b169ee72685f0edc8545` | Trade Desk | 1,027.655 | 1.000000 | 18.27 | RH-mid* | 18,770 | – | yes | yes |
| RDW | `0x92ef19e82bd8ff36661de838d5eae7e5cef0effe` | Redwire | 1,749.575 | 1.000000 | 10.69 | RH-mid* | 18,703 | – | yes | yes |
| FLY | `0x03bc731ffb162cdd7b98d3c6542bfc291126075d` | Firefly Aerospace Inc. | 772.338 | 1.000000 | 24.04 | RH-mid* | 18,563 | – | yes | yes |
| RGTI | `0x284358abc07f9359f19f4b5b4ac91901be2597ba` | Rigetti Computing | 1,061.683 | 1.000000 | 16.70 | CL | 17,725 | `0x2A045cF1C49c61c166C036d2f06FA2D2d984f765` | yes | yes |
| OKLO | `0x8b2f88497f15a18e9d4ffa1a8ffb8538399ae774` | Oklo | 390.585 | 1.000000 | 43.00 | RH-mid* | 16,795 | – | yes | yes |
| MXL | `0x48961813349333209994750ffa89b3c5c22ec969` | MaxLinear | 176.910 | 1.000000 | 94.15 | RH-mid* | 16,656 | – | yes | yes |
| XLK | `0x15cd20759ce7f3285c29a319de2d1a2e098c6f43` | State Street Technology Select Sector SPDR ETF | 80.979 | 1.000804 | 200.74 | RH-mid* | 16,255 | – | yes | yes |
| CELH | `0x8cf07c5a878945185d327aaa6e33faa95f95e7bf` | Celsius | 579.836 | 1.000000 | 28.02 | RH-mid* | 16,250 | – | yes | yes |
| APLD | `0xb8dbf92f9741c9ac1c32115e78581f23509916fd` | Applied Digital | 598.194 | 1.000000 | 27.00 | RH-mid* | 16,151 | – | yes | yes |
| AXTI | `0x141eea040c2250eec0314e336975e81f85f6585e` | AXT | 201.055 | 1.000000 | 78.77 | RH-mid* | 15,836 | – | yes | yes |
| CVNA | `0xa4f319104089fe321dc8093c6e707d4fe190a988` | Carvana | 236.680 | 1.000000 | 65.20 | RH-mid* | 15,433 | – | yes | yes |
| JOBY | `0xb334c5ce741b80b5b671f47f5c269cb193fe8e24` | Joby Aviation | 2,517.294 | 1.000000 | 6.06 | RH-mid* | 15,267 | – | yes | yes |
| ABCL | `0x3139d77ace0cbaa5bdfd38bd1f1911a794af0b0e` | Abcellera Biologics | 1,055.727 | 1.000000 | 14.44 | RH-mid* | 15,245 | – | yes | yes |
| CLS | `0xbf449977089c718c004a66c554b26b94ef3ad4de` | Celestica | 39.238 | 1.000000 | 388.05 | RH-mid* | 15,226 | – | yes | yes |
| LRCX | `0x57b0030166db0c31690d1a5aa167e2e26e2c29a4` | Lam Research Corp | 48.460 | 1.000733 | 313.81 | RH-mid* | 15,207 | – | yes | yes |
| AUR | `0x373c06c4f7bde527d7dae4ba169e42b55e393ced` | Aurora Innovation | 2,848.894 | 1.000000 | 5.30 | RH-mid* | 15,099 | – | yes | yes |
| ZS | `0x7dc013eb55e436f30d7ed1afe4e36d6e45e3c3f7` | Zscaler | 73.223 | 1.000000 | 201.50 | RH-mid* | 14,754 | – | yes | yes |
| QBTS | `0xc583c60aef9dc401da72cec1b404743a93cea1cc` | D-Wave Quantum Inc. Common Stock | 852.011 | 1.000000 | 17.30 | RH-mid* | 14,740 | – | yes | yes |
| PL | `0xaa4d64474c172010ab57719cb9951e6142a100d3` | Planet Labs | 842.284 | 1.000000 | 17.38 | RH-mid* | 14,635 | – | yes | yes |
| VST | `0x561e2a49212b7ccf47f2744ccb83e200722fadbc` | Vistra | 105.296 | 1.001115 | 138.29 | RH-mid* | 14,562 | – | yes | yes |
| TEAM | `0x5b97476b922f3305131b8f0b9d333172e87f4aae` | Atlassian Corporation | 76.705 | 1.000000 | 188.50 | RH-mid* | 14,459 | – | yes | yes |
| VRT | `0xfa78c12e6488814a0262e4e802749a4a737d5fb7` | Vertiv | 56.659 | 1.000163 | 251.77 | RH-mid* | 14,265 | – | yes | yes |
| CRWD | `0xea72ecca2d0f6bfa1394dbbcff85b52cd4233931` | CrowdStrike Holdings | 14.188 | 4.000000 | 1,001.50 | RH-mid* | 14,209 | – | yes | yes |
| TSEM | `0x89776d4cd68193597a2fc132cfac1fde36ccea8a` | Tower Semiconductor | 60.537 | 1.000000 | 233.24 | RH-mid* | 14,119 | – | yes | yes |
| ALAB | `0x748c32c3ca24edf31ea597db1f3d330a7a6da3dc` | Astera Labs, Inc. | 45.058 | 1.000000 | 307.49 | RH-mid* | 13,855 | – | yes | yes |
| DOCN | `0xc02f12b9fe9e707079ec0d546f3050d3f6c1f8bd` | DigitalOcean | 97.998 | 1.000000 | 140.09 | RH-mid* | 13,729 | – | yes | yes |
| EWT | `0x1c690498150252222c275a5ced69d3a6b1f52d5e` | iShares MSCI Taiwan Capped ETF | 118.740 | 1.000000 | 115.59 | RH-mid* | 13,725 | – | yes | yes |
| FICO | `0xa48f22a46c0f1c46ca7d111cb6c137c271987180` | Fair Isaac | 13.487 | 1.000000 | 991.50 | RH-mid* | 13,372 | – | yes | yes |
| AMBA | `0x99d9d8663545151603863c5acbd6fc3218899009` | Ambarella | 160.647 | 1.000000 | 82.84 | RH-mid* | 13,308 | – | yes | yes |
| SCHD | `0xd63abb2c13d7a8421a8017a712802053568e3c1d` | Schwab US Dividend Equity ETF | 379.971 | 1.005539 | 34.44 | RH-mid* | 13,086 | – | yes | yes |
| CRDO | `0x4d67253bc223e6b0e104f1084c1fb2b669ddc41b` | Credo Technology Group | 62.442 | 1.000000 | 205.25 | RH-mid* | 12,817 | – | yes | yes |
| AVAV | `0xf6290b5e7c26502e2da514c31509849718ea76a5` | AeroVironment | 80.935 | 1.000000 | 153.53 | RH-mid* | 12,426 | – | yes | yes |
| INOD | `0xf1953dab6fad537488d5a022361ffaa8b4c95ec6` | Innodata | 176.370 | 1.000000 | 70.00 | RH-mid* | 12,345 | – | yes | yes |
| MPWR | `0x52d50d0280ad1054b43f052bd70a49a212a1b128` | Monolithic Power Systems | 8.990 | 1.000000 | 1,368.38 | RH-mid* | 12,302 | – | yes | yes |
| FTNT | `0x3fb8976980d486084b2eb4a404bd12e72823958f` | Fortinet | 70.023 | 1.000000 | 173.62 | RH-mid* | 12,158 | – | yes | yes |
| GLW | `0x7c04e6a3368f2a1de3874f0e80d2e0a1a9915da6` | Corning | 76.147 | 1.000000 | 156.76 | RH-mid* | 11,937 | – | yes | yes |
| TE | `0xb1969f6604ca1ae7a2cd3f1827876e914594ca2d` | T1 Energy | 2,851.090 | 1.000000 | 4.14 | RH-mid* | 11,818 | – | yes | yes |
| IBRX | `0x7c148f74ac7445d1f28366b7fcdc6792a9fcd0cf` | ImmunityBio, | 1,338.482 | 1.000000 | 8.78 | RH-mid* | 11,752 | – | yes | yes |
| SHY | `0xbe274710bf3d9567e1b290ef6a5f9f90ca016fd8` | iShares 1-3 Year Treasury Bond ETF | 141.777 | 1.000000 | 82.19 | RH-mid* | 11,652 | – | yes | yes |
| COHR | `0x92f9f459f1a9a5ad266b182be7bffd1c6c666894` | Coherent | 36.583 | 1.000000 | 314.34 | RH-mid* | 11,499 | – | yes | yes |
| KLAC | `0x96b933c74ecb4a0926b9210cef7b743ef46be2e9` | KLA | 60.696 | 1.000000 | 188.31 | RH-mid* | 11,429 | – | yes | yes |
| POWL | `0x237c16d66590f67b886d978acd362eaead8b18c7` | Powell Industries | 66.883 | 1.000000 | 170.50 | RH-mid* | 11,404 | – | yes | yes |
| KSS | `0x12e3c047bf9aecaf9ddc98c05c31bfd1dd043993` | Kohls Corporation | 617.098 | 1.004610 | 18.40 | RH-mid* | 11,357 | – | yes | yes |
| CLSK | `0xcbb95bbf36099d34da091dc6fa6f49efa257cee3` | CleanSpark | 813.786 | 1.000000 | 13.95 | CL | 11,348 | `0x810c12D3a554Bc47fd39597Fe3b3AAC4941F50eF` | yes | yes |
| UMC | `0x0e6e67ba88e7b5d9b67636a215c76779b948de79` | United Microelectronics | 449.414 | 1.000000 | 25.16 | RH-mid* | 11,310 | – | yes | yes |
| PANW | `0xb039597ed45cba7b6e2fb9e8be51802969cee5be` | Palo Alto Networks | 29.686 | 1.000000 | 375.29 | RH-mid* | 11,141 | – | yes | yes |
| HWM | `0xaea445c5f3db1a462998ccc422a875a361ee5d99` | Howmet Aerospace | 47.694 | 1.000000 | 232.98 | RH-mid* | 11,112 | – | yes | yes |
| MDB | `0xddf2266b79abf0b48898959b0ed6e6adf512be74` | MongoDB | 27.519 | 1.000000 | 399.38 | RH-mid* | 10,990 | – | yes | yes |
| ANET | `0x28babd556b60e53663b8615036479a29c2cdd1bf` | Arista | 51.848 | 1.000000 | 208.09 | RH-mid* | 10,789 | – | yes | yes |
| MTSI | `0xc93f4d80e268ab922e871bd169156c3cc41894e6` | MACOM | 38.515 | 1.000000 | 279.27 | RH-mid* | 10,756 | – | yes | yes |
| ONTO | `0x8ff63eaeee3fe54ba450c4f5538064ec5a893aef` | Onto Innovation | 38.854 | 1.000000 | 275.18 | RH-mid* | 10,692 | – | yes | yes |
| LHX | `0x48d60243c66437c6ac3c2495be94747aed5dfe25` | L3Harris | 43.385 | 1.004922 | 243.75 | RH-mid* | 10,575 | – | yes | yes |
| TEM | `0xb1cc0ec7db69cf43539119814df40071b9d61793` | Tempus AI | 124.400 | 1.000000 | 84.70 | RH-mid* | 10,537 | – | yes | yes |
| AEHR | `0x5f604fba1162193a4388a5dfa56f556f3e133cc2` | Aehr | 104.750 | 1.000000 | 97.99 | RH-mid* | 10,264 | – | yes | yes |
| NVTS | `0xbe6702d7b70315376dc48a3293f24f0982f86386` | Navitas Semiconductor | 842.151 | 1.000000 | 12.09 | RH-mid* | 10,177 | – | yes | yes |
| SPMO | `0xad622320e520de39e72d41ef07438c3fd3354875` | Invesco S&P 500 Momentum ETF | 64.942 | 1.002025 | 156.33 | RH-mid* | 10,152 | – | yes | yes |
| OUST | `0x40e7a279850e443f582059ae5dc1c3b6563e6395` | Ouster | 246.408 | 1.000000 | 40.95 | RH-mid* | 10,090 | – | yes | yes |
| JBL | `0xeaf2512dfc1beac608f8794b3793cd4e02894aa6` | Jabil Inc. | 31.456 | 1.000000 | 319.12 | RH-mid* | 10,038 | – | yes | yes |
| GEV | `0x94b8aae43a1ccc08aa64b7d1f29b4d920af4a0c9` | GE Vernova | 10.476 | 1.000000 | 954.76 | RH-mid* | 10,002 | – | yes | yes |
| VICR | `0x6006ed4b2f94110851ff7509d97d034f0eed9226` | Vicor | 34.980 | 1.000000 | 275.50 | RH-mid* | 9,637 | – | yes | yes |
| SIMO | `0x77e655e37f4d913fb9540e0d541d824171a60e81` | Silicon Motion | 37.894 | 1.000000 | 251.63 | RH-mid* | 9,535 | – | yes | yes |
| FISV | `0x9ece29a4a2397c0a35fb5fa8ee2b9509130a98cc` | Fiserv | 201.975 | 1.000000 | 46.53 | RH-mid* | 9,397 | – | yes | yes |
| MOD | `0xc6cbad1016b38b797610c25e1dc7d95988b1f362` | Modine | 46.440 | 1.000000 | 198.33 | RH-mid* | 9,211 | – | yes | yes |
| AEIS | `0xfaf9cb261b5fcc1f404bb10cd39c5c6c1974e612` | Advanced Energy | 31.345 | 1.000000 | 283.00 | RH-mid* | 8,871 | – | yes | yes |
| SLS | `0x285b231728c7e4333799183df1094d775246a535` | SELLAS Life Sciences | 697.000 | 1.000000 | 11.75 | RH-mid* | 8,193 | – | yes | yes |
| XNDU | `0xa8eb3bccbf2017ee7cbfb652eb51cf2e1b153289` | Xanadu Quantum | 1,532.000 | 1.000000 | 5.20 | RH-mid* | 7,966 | – | yes | yes |
| AMKR | `0xdd356aa38f40a7b7076755ac854b6fbb1f0d305b` | Amkor Technology | 142.885 | 1.000867 | 53.80 | RH-mid* | 7,687 | – | yes | yes |
| PWR | `0x9ab02ead789b6903c3c44d0ed32f9c707cdf12fd` | Quanta | 10.955 | 1.000000 | 651.54 | RH-mid* | 7,138 | – | yes | yes |
| VSAT | `0x26dcbfb34fc83cabd6990f449674efdc6097ff85` | ViaSat | 99.165 | 1.000000 | 71.55 | RH-mid* | 7,095 | – | yes | yes |
| CTSH | `0x63d5a3b6939a33f1e75d8bcd85759858239600db` | Cognizant | 99.539 | 1.000000 | 57.33 | RH-mid* | 5,707 | – | yes | yes |
| CIEN | `0x44f6d488021f8233b9416294d1fe9b1fee28382d` | Ciena | 15.478 | 1.000000 | 357.20 | RH-mid* | 5,529 | – | yes | yes |
| HII | `0xeb61c0ed490a367d4e3631ccf8a74b3bfc7e775d` | Huntington Ingalls | 20.347 | 1.000000 | 253.95 | RH-mid* | 5,167 | – | yes | yes |
| PR | `0x4189f0c66ebbb0bfef1c31f763131361ef32f77c` | Permian Resources | 236.716 | 1.004478 | 21.51 | RH-mid* | 5,091 | – | yes | yes |
| AXON | `0xc27dbd474af5181c5a8777903690d8d262d12648` | Axon | 10.450 | 1.000000 | 427.03 | RH-mid* | 4,463 | – | yes | yes |
| NAVN | `0xf7181b63fdb858558a74ba96bc42732684cd7965` | Navan | 96.045 | 1.000000 | 22.12 | RH-mid* | 2,125 | – | yes | yes |
| SATS | `0x95052ddcd5dc25641657424a8cf04834997e1730` | EchoStar | 0.103 | 1.000000 | 91.06 | RH-mid* | 9 | – | yes | yes |
| WEEK | `0xc93a8c440cea26d7445df01729f193b27965099f` | Roundhill Weekly T-Bill ETF | 5.949 | 2.006183 | – | – | – | – | – | no |
| ARM | `0x666716999e75d2652398ff830bbc2e485946e140` | Arm Holdings plc | 0.000 | 1.000000 | – | – | – | – | – | no |
| NASA | `0x6ddb95405db6179012bff2fff7e0f8d49cf00137` | Tema Space Innovators ETF | 0.000 | 1.000000 | – | – | – | – | – | no |
| RVI | `0xb02e3e1b7f68559427c2d9100566e4f3cc5b7611` | Robinhood Ventures Fund I | 0.000 | 1.000000 | – | – | – | – | – | no |
| NOK | `0x25ee805ac369b6e3f8bf5764c682d34a37cb7175` | Nokia | 0.000 | 1.000000 | – | – | – | – | – | no |
| DRAM | `0x33c18e2cc8ae9ae486e785090d86b2ce632ff994` | Roundhill Memory ETF | 0.000 | 1.000000 | – | – | – | – | – | no |
| QNT | `0xb7edfe2f33c1ac06830a971dfb559bde8a2a3d76` | Quantinuum Inc. Class A | 0.000 | 1.000000 | 47.84 | RH-mid* | 0 | – | yes | yes |
| ZETA | `0xe674c5c071821f48bb2d12cadb83617eff438f9e` | Zeta Global | 0.000 | 1.000000 | – | – | – | – | – | no |
| JEPQ | `0x565d3ff42d7d880287e5796b4c708632be0ca098` | J.P. Morgan Exchange-Traded Fund Trust JPMorgan Nasdaq Equity Premium Income ETF | 0.000 | 1.000000 | – | – | – | – | – | no |
| BND | `0x2f62fc9fabb470c690f141c28340ed832bb27020` | Vanguard Total Bond Market ETF | 0.000 | 1.000000 | 73.79 | RH-mid* | 0 | – | yes | yes |
| PEACH_DEFI_1 | `0xbbb6c29bcc3a1028a2b54310df73f4f7a3bcb373` | PEACH_DEFI_1 | 1.000 | 1.000000 | – | – | – | – | – | no |

---

## 10. File index (`/home/claude/evm/recon/`)

- **Pools**:
  - `v3_poolcreated.jsonl.gz`: all 436,362 raw PoolCreated logs.
  - `v3_pools_list.json`
  - `univ3_known_side_all.json`: known-side USD per pool.
  - `univ3_all_pools_top.json`: top 4,000 with full state, prices and TVL.
  - `v4_initialize.jsonl.gz`: all 895,598 Initialize records.
  - `univ4_hooks.json`
  - `univ4_pools_raw.json` / `univ4_live_state.json` / `univ4_stock_pools_tvl.json`: the earlier v4 stock-pool pass.
  - `stock_pool_depth.json`: exact tick-walk TVL and depth, v3 and v4.
  - `univ2_pairs.json`
  - `steer_vaults.json`
- **Markets**:
  - `morpho_markets_live.json`: 284 markets with IRM rates.
  - `morpho_markets_state.json`, `morpho_oracles.json`, `morpho_usdg_positions.json`, `morpho_api.json` (VaultV2 list).
- **Tokens**:
  - `stock_token_proxies.json`, `stock_tokens.json`, `stock_tokens_live.json`, `stock_prices_best.json` (the prices used in §9), `stock_float_all_204.json`, `stock_token_events.json`, `registry.json`. `stock_mcap.json` and `stock_float_in_defi.json` are earlier passes priced with RH mids and are superseded.
  - `rh-assets.json`, `rh-prices.json`, `rh-corporate-actions.json`
  - `src/stock/*.sol`: verified Stock sources.
  - `src/FablesRWA.sol`
- **Oracles**: `chainlink_feeds_live.json`, `cl-feeds-robinhood.json` (RDD), `feed_descriptions.json` (non-Chainlink feeds used by Morpho oracles).
- **Compliance**: `filtered_tx_events.json` (6,096 FilteredTransactionAdded events).
- **Venues**: `lighter_rh_orderbooks.json`, `lighter_rh_stats.json`, `arcus_markets.json`, `arcus_ptokens.json`.
- **Infrastructure**: `infra_probe.json`.
- **Docs snapshots**: `docs/*.txt|json|md`, covering RH chain docs, Chainlink, CCIP, LayerZero, Hyperlane, Arcus, Across, Steer, Beefy and the Arbitrum compliance docs.
- **Scripts**: `rpc.py` (RPC plus multicall helpers), `scan.py` / `scan_v4.py` (parallel adaptive log scanner), `01_…18_*.py`, `99_build_tables.py`. `DOSSIER.tmpl.md` plus `tables/*.md` render to `DOSSIER.md`.
- **Reference repos**: `gitprobe/`, shallow clones of EthWiz/subway, penguinpecker/moleswap-pro, mdlog/vigil and the lending-protocol deployment registries.
