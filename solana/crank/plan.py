#!/usr/bin/env python3
"""
dlp crank planner — reads on-chain state and emits the next rebalance plan for a klend-hedged vault.
Pure planner: no keys, nothing sent. Feed the plan into your tx builder (accounts per ix are
documented in programs/vault/src/ix/*.rs).

  python3 crank/plan.py <program_id> <vault_pubkey> [--range-ticks 60] [--ltv-target 0.40] [--lp-frac 0.5]

Sizing rule (per handoff §7, klend flavour):
  T          = equity (quote)
  collateral = T · c,    LP quote b = T · (1 − c) − buffer,    debt D = a(P) of the placed range
  c chosen so that  D·P·BF / (collateral·LTV_liq) = ltv_target  (health = 1/ltv_target)
The delta guard on-chain compares a(P_oracle) to D, so D is sized to the midpoint of
a(P_pool) and a(P_oracle) — see README "Gamma note".
"""
import json, sys, os, base64, argparse
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'abi'))
from solders.pubkey import Pubkey

RPC = os.environ.get("RPC", "https://api.mainnet-beta.solana.com")

def call(method, params):
    import urllib.request
    req = urllib.request.Request(RPC, data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(), headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())["result"]

def acct(pk):
    v = call("getAccountInfo", [str(pk), {"encoding": "base64"}])["value"]
    return base64.b64decode(v["data"][0]) if v else None

# ---------------------------------------------------------------- Orca math (same constants as crates/math/clmm.rs)
Q64 = 1 << 64
def sqrt_price_from_tick(tick: int) -> int:
    if tick >= 0:
        ratio = 79232123823359799118286999567 if tick & 1 else 79228162514264337593543950336
        for bit, k in [(2, 79236085330515764027303304731), (4, 79244008939048815603706035061), (8, 79259858533276714757314932305), (16, 79291567232598584799939703904), (32, 79355022692464371645785046466), (64, 79482085999252804386437311141), (128, 79736823300114093921829183326), (256, 80248749790819932309965073892), (512, 81282483887344747381513967011), (1024, 83390072131320151908154831281), (2048, 87770609709833776024991924138), (4096, 97234110755111693312479820773), (8192, 119332217159966728226237229890), (16384, 179736315981702064433883588727), (32768, 407748233172238350107850275304), (65536, 2098478828474011932436660412517), (131072, 55581415166113811149459800483533), (262144, 38992368544603139932233054999993551)]:
            if tick & bit:
                ratio = (ratio * k) >> 96
        return ratio >> 32
    t = -tick
    ratio = 18445821805675392311 if t & 1 else 18446744073709551616
    for bit, k in [(2, 18444899583751176498), (4, 18443055278223354162), (8, 18439367220385604838), (16, 18431993317065449817), (32, 18417254355718160513), (64, 18387811781193591352), (128, 18329067761203520168), (256, 18212142134806087854), (512, 17980523815641551639), (1024, 17526086738831147013), (2048, 16651378430235024244), (4096, 15030750278693429944), (8192, 12247334978882834399), (16384, 8131365268884726200), (32768, 3584323654723342297), (65536, 696457651847595233), (131072, 26294789957452057), (262144, 37481735321082)]:
        if t & bit:
            ratio = (ratio * k) >> 64
    return ratio

def amount_a(s0, s1, L, up):
    lo, hi = min(s0, s1), max(s0, s1)
    n = (L * (hi - lo)) << 64; d = hi * lo
    q, r = divmod(n, d)
    return q + (1 if up and r else 0)

def amount_b(s0, s1, L, up):
    lo, hi = min(s0, s1), max(s0, s1)
    p = L * (hi - lo)
    return (p >> 64) + (1 if up and (p & (Q64 - 1)) else 0)

def position_amounts(tick, sp, tl, tu, L, up):
    lo, hi = sqrt_price_from_tick(tl), sqrt_price_from_tick(tu)
    if tick < tl: return amount_a(lo, hi, L, up), 0
    if tick < tu: return amount_a(sp, hi, L, up), amount_b(lo, sp, L, up)
    return 0, amount_b(lo, hi, L, up)

def liquidity_from_b(s0, s1, b):
    lo, hi = min(s0, s1), max(s0, s1)
    return (b << 64) // (hi - lo)

def liquidity_from_a(s0, s1, a):
    lo, hi = min(s0, s1), max(s0, s1)
    return (a * lo * hi // (hi - lo)) >> 64

def tick_from_price_raw(p):  # rough: for range centering only
    import math
    return int(math.floor(math.log(p) / math.log(1.0001)))

# ---------------------------------------------------------------- readers
def u64(d, o): return int.from_bytes(d[o:o+8], 'little')
def u128(d, o): return int.from_bytes(d[o:o+16], 'little')
def i32(d, o): return int.from_bytes(d[o:o+4], 'little', signed=True)
def pk(d, o): return Pubkey.from_bytes(d[o:o+32])

V_EQUITY = 8 + 8 + 32 * 14 + 16
def read_vault(d):
    keys = ['crank', 'authority', 'quote_mint', 'base_mint', 'receipt_mint', 'quote_ata', 'base_ata', 'whirlpool', 'position', 'position_mint', 'hedge_account', 'hedge_market', 'hedge_quote', 'hedge_base']
    v = {k: pk(d, 16 + 32 * i) for i, k in enumerate(keys)}
    v.update(phase=d[11], hedge_kind=d[12], flags=d[13], quote_dec=d[14], base_dec=d[15],
             equity=u64(d, V_EQUITY), supply=u64(d, V_EQUITY + 8), sync_slot=u64(d, V_EQUITY + 16), price_e12=u64(d, V_EQUITY + 24),
             hedge_base=u64(d, V_EQUITY + 32), lp_base=u64(d, V_EQUITY + 40), health=int.from_bytes(d[V_EQUITY+48:V_EQUITY+52], 'little'),
             tick_lower=i32(d, V_EQUITY + 56), tick_upper=i32(d, V_EQUITY + 60), liquidity=u128(d, V_EQUITY + 64), epoch=u64(d, V_EQUITY + 80))
    p = d[16 + 32 * 14: 16 + 32 * 14 + 16]
    v['params'] = dict(zip(['max_mint_bps', 'max_burn_bps', 'eps_bps', 'min_health_x100', 'max_price_dev_bps', 'max_swap_bps'], [int.from_bytes(p[i:i+2], 'little') for i in range(0, 12, 2)]))
    return v

def read_pool(d):
    return dict(tick_spacing=int.from_bytes(d[41:43], 'little'), sqrt_price=u128(d, 65), tick=i32(d, 81), vault_a=pk(d, 133), vault_b=pk(d, 213))

def read_reserve(d):
    return dict(ltv=d[4872], lt=d[4873], bf=u64(d, 5008) / 100, price=u128(d, 248) / 2**60, avail=u64(d, 224), farm_collateral=pk(d, 64), farm_debt=pk(d, 96),
                liq_supply=pk(d, 160), fee_vault=pk(d, 192), coll_mint=pk(d, 2560), coll_supply=pk(d, 2600), liq_mint=pk(d, 128))

def token_amount(pubkey):
    d = acct(pubkey)
    return u64(d, 64) if d else 0

# ---------------------------------------------------------------- plan
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('program'); ap.add_argument('vault')
    ap.add_argument('--range-ticks', type=int, default=60, help='half-width in ticks around the oracle tick')
    ap.add_argument('--ltv-target', type=float, default=0.40, help='target raw debt/collateral (liq at LT/BF)')
    ap.add_argument('--buffer', type=float, default=0.02, help='fraction of equity kept idle in quote for withdrawals')
    a = ap.parse_args()
    program = Pubkey.from_string(a.program); vault_pk = Pubkey.from_string(a.vault)
    v = read_vault(acct(vault_pk))
    pool = read_pool(acct(v['whirlpool']))
    rq = read_reserve(acct(v['hedge_quote'])); rb = read_reserve(acct(v['hedge_base']))
    ts = pool['tick_spacing']
    P_raw_oracle = rb['price'] / rq['price'] * 10 ** v['quote_dec'] / 10 ** v['base_dec']
    P_raw_pool = (pool['sqrt_price'] / Q64) ** 2
    tick_oracle = tick_from_price_raw(P_raw_oracle)
    dev_bps = abs(P_raw_pool / P_raw_oracle - 1) * 1e4
    idle_q = token_amount(v['quote_ata']); idle_b = token_amount(v['base_ata'])
    T = v['equity']  # quote units, from the last Sync
    print(f"vault {vault_pk} phase={v['phase']} epoch={v['epoch']} equity={T/1e6:.6f} supply={v['supply']/1e6:.6f} health={v['health']/100 if v['health']<2**32-1 else 'inf'}")
    print(f"pool tick {pool['tick']} (P={P_raw_pool*1e3:.4f}) | oracle tick {tick_oracle} (P={P_raw_oracle*1e3:.4f}) | dev {dev_bps:.1f} bps (max {v['params']['max_price_dev_bps']})")
    print(f"idle quote {idle_q/1e6:.6f} idle base {idle_b/1e9:.6f} | debt {v['hedge_base']/1e9:.6f} | lp_base {v['lp_base']/1e9:.6f}")

    # ---- target range around the oracle tick, aligned to spacing
    tl = ((tick_oracle - a.range_ticks) // ts) * ts
    tu = ((tick_oracle + a.range_ticks) // ts) * ts
    # ---- capital split: collateral c·T such that health = LT/(ltv_target·BF)
    # debt value D·P = a·P ; LP quote b ≈ a·P (centered) ; collateral C = a·P / ltv_target
    # T·(1−buffer) = C + b = a·P·(1/ltv_target + 1)
    usable = T * (1 - a.buffer)
    aP = usable / (1 / a.ltv_target + 1)          # quote value of the LP's base side
    b_target = int(aP)                              # LP quote
    C_target = int(usable - b_target)               # klend collateral
    sp_oracle = int((P_raw_oracle ** 0.5) * Q64)
    L = liquidity_from_b(sqrt_price_from_tick(tl), sp_oracle, b_target)
    a_oracle, b_oracle = position_amounts(tick_oracle, sp_oracle, tl, tu, L, True)
    a_pool, b_pool = position_amounts(pool['tick'], pool['sqrt_price'], tl, tu, L, True)
    D_target = (a_oracle + a_pool) // 2 + 1         # midpoint sizing vs the on-chain oracle-valued delta
    max_debt_q = C_target * rq['ltv'] / 100 / rb['bf']
    health = (C_target * rq['lt'] / 100) / (D_target * P_raw_oracle * rb['bf']) if D_target else float('inf')
    print(f"\nPLAN epoch {v['epoch']+1}: range [{tl},{tu}] (±{a.range_ticks} ticks, spacing {ts})")
    print(f"  collateral C = {C_target/1e6:.6f} USDC   LP b = {b_target/1e6:.6f} USDC   L = {L}")
    print(f"  a(P_oracle) = {a_oracle/1e9:.6f}  a(P_pool) = {a_pool/1e9:.6f}  → debt D = {D_target/1e9:.6f} SOL  (gap {abs(a_oracle-a_pool)/max(a_oracle,1)*1e4:.0f} bps vs eps {v['params']['eps_bps']})")
    print(f"  D·P·BF = {D_target*P_raw_oracle*rb['bf']/1e6:.2f} vs allowed {max_debt_q/1e6:.2f} → health {health:.2f} (min {v['params']['min_health_x100']/100})")
    print(f"  klend SOL available {rb['avail']/1e9:,.0f} SOL")
    collateral_delta = C_target - int(v.get('collateral_q', 0) or 0)  # collateral currently in klend (read obligation for exact)
    debt_delta = D_target - v['hedge_base']
    plan = dict(
        tick_lower=tl, tick_upper=tu, liquidity=L,
        max_a=int(max(a_oracle, a_pool) * 1.01) + 1, max_b=int(max(b_oracle, b_pool) * 1.01) + 1,
        collateral_delta_q=collateral_delta, debt_delta_base=debt_delta,
        sequence=["Begin(min_a,min_b from current position amounts·0.995)",
                  "Swap only if idle inventory ratio is off (bounded by max_swap_bps)",
                  f"HedgeKlend(collateral_delta={collateral_delta}, debt_delta={debt_delta})",
                  f"Place(tl={tl}, tu={tu}, L={L}, max_a, max_b)", "End"],
        tick_arrays=[((tl // (88 * ts)) * 88 * ts), ((tu // (88 * ts)) * 88 * ts)],
        farm_accounts=dict(usdc_farm=str(rq['farm_collateral']), sol_debt_farm=str(rb['farm_debt']) if str(rb['farm_debt']) != '11111111111111111111111111111111' else None),
    )
    print("\n" + json.dumps(plan, indent=1, default=str))

if __name__ == '__main__':
    main()
