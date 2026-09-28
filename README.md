# delta-LP

One receipt over a tight-range CLMM LP and a hedge sized so net delta ≈ 0, recentered as one object.
The position is a token, not an account: LP it, route it, hook it.

**Strategy readiness and live markets:** [deltalp.fun](https://deltalp.fun).
**Oil subscription waitlist:** [deltalp.fun/oil](https://deltalp.fun/oil).
Leveraged strategy execution is not live; the homepage labels estimates and venue links explicitly.
The Robinhood NVDA/USDG vault is deployed with deposits closed at
`0x32C47683D0E41DAc58A750fccb7200ad031D3993`.
See [launch configuration, points rules, and verification](docs/LAUNCH.md).

```
r ≈ clmm_fees − recenter_tax − hedge_carry − leftover_IL
```

| dir | chain | CLMM leg | hedge leg | status |
|---|---|---|---|---|
| [`solana/`](solana/) | Solana (pinocchio, `no_std`, hand-rolled CPI) | Orca Whirlpool | Kamino Lend borrow (live) · Drift/Velocity perp (ABI-verified, venue not live) | e2e green on mainnet-cloned state (LiteSVM) |
| [`evm/`](evm/) | Robinhood Chain 4663 (Foundry) | Uniswap v3 | Morpho Blue borrow | fork tests green on 4663 mainnet state |

Same core in both: phase machine `Idle → Pulled → Hedged → Placed → Idle`, NAV deposit/withdraw
gated on a same-slot/same-block permissionless `Sync`, LP valued at the oracle (never the pool tick),
guards on delta / health / oracle-vs-pool / swap notional / epoch caps. Hedge venues are adapters:
the five gates (PDA owner, plain CPI open/resize/collateral/close, on-chain mark, one owner per
market, who liquidates) decide whether a venue gets a file.

Each directory has its own README with the instruction table, seeds/addresses, proofs and the
honest not-done list. `evm/docs/RECON-robinhood-chain.md` is the full on-chain recon of 4663.
