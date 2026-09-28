# dlp — one receipt over (tight-range CLMM LP) + (base hedge)

`$1 receipt = tight-range X/USDC on Orca + hedge of the LP's base delta, sized net-delta ≈ 0,
recentered as one object.` The position is a **token**, not an account: LP it, route it, hook it.

```
r ≈ clmm_fees − recenter_tax − hedge_carry − leftover_IL
```
Hedge carry is SOL borrow APR on Kamino (always paid, ~5.7% at 89% util on 2026‑09‑25) or perp
funding on Drift/Velocity (bidirectional). IL and the recenter tax still exist. Do not say "only yield".

## Status (2026‑09‑25)

| piece | state |
|---|---|
| `crates/math` | Orca tick/liquidity math (ported, bit-exact), Drift margin + funding math (ported), U256, NAV/delta guards — **15 unit tests green** |
| `programs/vault` | pinocchio 0.11, `no_std`, hand-rolled CPI, 194 KB `.so`. Phase machine, NAV deposit/withdraw, permissionless `Sync`, crank ixs |
| hedge = **Kamino Lend** (`KLend2g…` v1.25) | **live on mainnet, e2e proven** in `tests/svm` against cloned mainnet state |
| CLMM = **Orca Whirlpool** | live, e2e proven (open/reset range, increase/decrease, collect, swap) |
| hedge = **Drift / Velocity** (`dRiftyHA…`, protocol-v2 ≥ 2.150) | ABI-verified against on-chain + master IDL and live account bytes; **compiles, not exercised** — v2 mainnet has not traded since 2026‑04‑01, Velocity (same program id, master 2.162.0) is pre-launch |
| Derpetual | no program id / IDL public → cannot be adapted yet (gates in §Gates) |

## Why klend as the v0 short leg

Every live Solana perp fails at least one gate today (Jupiter: keeper-executed fills; Flash: trading
moved to a MagicBlock rollup, mainnet ixs deprecated; Adrena: oracle feed dead since 09‑11; Drift:
frozen). klend passes all five, synchronously, and a third-party program already does our exact
flow on mainnet (PDA owner, `refresh_reserve ×2 → refresh_obligation → deposit_v2 → refresh →
borrow_v2` in one ix, tx `2RMsHqij…`, 296k CU).

Shape: don't *short* the base, **borrow** it. USDC → klend collateral, borrow `a` SOL, put that SOL
plus LP USDC into the tight range. For an in-range CLMM position `V(P) = a·P + b` and
`dV/dP = a(P)` exactly, so debt = a(P) ⇒ net delta 0. Rebalance = repay/borrow the difference.
Health = LTV; the LP's own SOL backs the debt, so the liq surface is LTV drift as P rises.

Live main-market numbers: USDC LTV 80 / LT 90, SOL borrow factor 1.25 → max SOL debt = 64 % of
USDC collateral, liquidation at 72 % raw. No e-mode for USDC→SOL (stay in group 0).

Capital: ~1.5× LP value at 50 % LTV vs ~1.2× with a 3× perp. Costlier; nobody's keeper in the loop.

## Layout

```
crates/math/        no_std math shared by program, tests, crank
  clmm.rs           tick ↔ sqrt price, amount deltas, position amounts, liquidity from amounts
  drift.rs          maintenance margin, funding payment, size premium — ported from protocol-v2
  nav.rs            oracle → sqrt price (U256 isqrt), fair LP value, delta guard
  u256.rs           minimal 256-bit mul/div
programs/vault/src/
  state.rs          Vault (repr(C), byte-array fields), Params, Phase, HedgeKind
  ix/init.rs        InitVault, InitFarms, ReopenObligation
  ix/user.rs        Deposit / Withdraw at NAV
  ix/sync.rs        Sync (permissionless) + EndRebalance (guards)
  ix/rebalance.rs   BeginRebalance (pull), Swap (recenter inventory), Place (new range)
  ix/hedge_klend.rs HedgeKlend: ±collateral, ±debt with in-ix refreshes
  ix/hedge_drift.rs HedgeDrift: ±collateral, place_and_take market order
  ix/admin.rs       SetCrank, SetParams (authority: rotates crank/params, never touches funds)
  venue/klend.rs    readers (Reserve/Obligation offsets) + CPI (init_*, refresh_*, *_v2)
  venue/whirlpool.rs readers (Whirlpool/Position) + CPI (open/reset/increase/decrease/collect/swap)
  venue/drift.rs    readers (User/PerpMarket/SpotMarket) + CPI (init user, deposit/withdraw, place_and_take, settle_pnl) + health
tests/svm/          LiteSVM e2e against fixtures/ (mainnet snapshot, slot 450500070)
fixtures/           28 cloned accounts (klend market/reserves/vaults/farm/Scope, Orca pool/vaults/tick arrays, mints) + fetch.py
```

## Accounts & seeds

| account | seeds | notes |
|---|---|---|
| vault | `["vault", whirlpool, hedge_market, [hedge_kind]]` | one per (pool, hedge market, kind); authority of everything |
| receipt mint | `["receipt", vault]` | plain SPL, 6 dp, mint authority = vault. Not Token‑2022: Raydium CPMM gates hooked mints |
| base/quote ATA | ATA(vault, mint) | idle inventory; deposits land here |
| position mint | `["pmint", vault, epoch u64]` | PDA-signed, no client keypair; reused across epochs via `reset_position_range` |
| klend obligation | `[[0],[0], vault, lending_market, sys, sys]` @ klend | tag 0 / id 0; user_metadata `["user_meta", vault]` |
| drift user | `["user", vault, 0u16]`, `["user_stats", vault]` @ drift | sub-account 0 |

## Instructions

| # | name | signer | phase | data |
|---|---|---|---|---|
| 0 | InitVault | payer, authority | – | `hedge_kind u8, Params(16)` |
| 1 | Deposit | user | Idle, synced this slot, flags 0 | `amount_q u64, min_receipt u64` |
| 2 | Withdraw | user | Idle, synced this slot | `receipt u64, min_q u64` (pays from idle quote only) |
| 3 | Sync | anyone | any | – |
| 4 | BeginRebalance | crank | Idle → Pulled | `min_a u64, min_b u64` |
| 5 | Swap | crank | Pulled/Hedged | `amount, other_threshold, sqrt_limit u128, is_input u8, a_to_b u8` |
| 6 | HedgeKlend | crank | Pulled/Hedged → Hedged | `collateral_delta i64, debt_delta i64` |
| 7 | Place | crank (funder) | Hedged → Placed | `tick_lower i32, tick_upper i32, liquidity u128, max_a u64, max_b u64` |
| 8 | EndRebalance | crank | non-Idle → Idle | – (Sync + guards) |
| 9 | SetCrank | authority | any | `new_crank` |
| 10 | SetParams | authority | Idle | `Params(16)` |
| 11 | InitFarms | anyone | – | `mode u8` (klend farm user state for a reserve) |
| 12 | HedgeDrift | crank | Pulled/Hedged → Hedged | `collateral_delta i64, base_delta i64, limit_price u64` |
| 13 | ReopenObligation | anyone | – | – (klend closes a fully-unwound obligation) |

Account orders are documented at the top of each handler in `programs/vault/src/ix/`.

`Params`: `max_mint_bps_per_epoch, max_burn_bps_per_epoch, eps_bps, min_health_x100,
max_price_dev_bps, max_swap_bps` (u16 each, +4 pad).

## Guards (the whole point)

- **NAV never stale**: Deposit/Withdraw require `Sync` in the same slot. `Sync` is permissionless
  and pure (CPI refreshes + reads), so any client prepends it.
- **Fair value at the oracle, not the pool**: LP amounts are computed at the Scope-implied sqrt
  price; a pool/oracle divergence > `max_price_dev_bps` sets `FLAG_PRICE_DEVIATION` (deposits and
  withdrawals blocked — withdrawals because NAV is unreliable, not to trap anyone).
- **Delta**: `|lp_base + idle_base − hedge_base| ≤ max(eps_bps · max(hedge, long), dust)` at End.
  Holding borrowed SOL idle *is* delta-neutral; selling it is not (tested).
- **Health**: klend `unhealthy_borrow_value / bf_adjusted_debt ≥ min_health/100` checked after
  every hedge op and at End; Drift `total_collateral / maintenance_margin`. Under-health sets
  `FLAG_UNDER_HEALTH` (deposits blocked, withdrawals allowed).
- **Phase machine**: deposits/withdrawals only in Idle; a rebalance is atomic across transactions
  by construction (nothing user-facing can run mid-rebalance).
- **Swap notional** ≤ `max_swap_bps` of equity per swap at the last-synced price.
- **Epoch mint/burn caps** (optional) as bps of supply at epoch start.
- Never mint-the-loser. Never reduce hedge collateral to fake leverage — `HedgeKlend` orders ops
  add-collateral → repay → borrow → withdraw-collateral so health never dips mid-instruction.

## Gamma note (surfaced by the e2e)

On a ±60‑tick range a 3‑tick pool/oracle gap moves `a(P)` by ~2.5 %. `eps_bps` must be ≥
`gap_ticks / half_range_ticks`, or the crank sizes debt to the midpoint of `a(P_pool)` and
`a(P_oracle)`. Tight range ⇒ tight eps budget ⇒ frequent recenters. That is the strategy, not a
bug — but it is also why "often" in "rebalanced often" is load-bearing.

## Build / test

```
cargo test -p dlp-math                                 # 15 unit tests
cargo build-sbf --manifest-path programs/vault/Cargo.toml
python3 fixtures/fetch.py                              # refresh the mainnet snapshot (needs RPC)
solana program dump KLend2g… fixtures/programs/KLend2g….so   (+ whirLbMi…, FarmsPZpW…)
cargo run -p dlp-svm-tests --release                   # e2e
```

## Gates (for any new hedge venue)

1. position owner can be a PDA (`Signer` satisfied by `invoke_signed`)
2. open / resize / add_collateral / close are plain instructions, no keeper-only step
3. mark + funding/borrow rate readable from an account, no UI
4. one PDA ⇒ one position per market
5. who liquidates: permissionless vs their keeper

klend: 5/5. Drift/Velocity: 5/5 (when live). Jupiter: PDA ok, keeper-async → wrap only.
Flash: rollup → fail. Adrena: 5/5 in design, oracle dead. Derpetual: unknown, ask.

## What's not done

- Drift/Velocity adapter has never hit a live program. When their testnet drops: point
  `hedge_market` at the perp market, `hedge_quote` at the quote spot market; `HedgeDrift` needs
  the oracle accounts in Drift's remaining-accounts order (oracles, spot, perps) — already built.
- No withdrawal queue: `Withdraw` pays from idle quote only. The crank keeps a buffer or the user
  waits for a rebalance that frees quote. Pro-rata in-kind exit is a v1 item.
- klend collateral withdrawals are subject to the reserve's daily withdrawal cap; borrow to
  Scope price staleness (≤120 s). Both surface as klend errors, not silent.
- Uncollected LP fees are only counted after `update_fees_and_rewards`; between rebalances NAV is
  conservative by that amount.
- Single crank key (rotatable by `authority`). Permissionless rebalancing needs a bounded
  parameter policy first (tick range width, sizing rule) — not in v0.
