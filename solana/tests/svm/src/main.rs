//! End-to-end proof against mainnet-cloned Kamino Lend + Orca Whirlpool state (fixtures/),
//! with the SVM clock frozen at the snapshot so Scope prices are "fresh".
//!
//!   init → farms → sync → deposit → [begin → hedge(borrow) → place → end] → sync → withdraw
//!        → [begin → hedge(repay+withdraw) → end] → withdraw-all
//! plus the guard negatives (stale sync, wrong phase, not-crank, delta too large).

use base64::Engine;
use dlp_math::clmm;
use dlp_vault::{instruction as ixn, state::*, venue};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_address::{address, Address};
use solana_clock::Clock;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use std::{fs, path::PathBuf};

const KLEND: Address = address!("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const FARMS: Address = address!("FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr");
const WHIRLPOOL_PROG: Address = address!("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
const MARKET: Address = address!("7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF");
const R_USDC: Address = address!("D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59");
const R_SOL: Address = address!("d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q");
const SCOPE: Address = address!("3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH");
const WSOL: Address = address!("So11111111111111111111111111111111111111112");
const USDC: Address = address!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const TOKEN: Address = address!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022: Address = address!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATA_PROG: Address = address!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYSTEM: Address = address!("11111111111111111111111111111111");
const RENT: Address = address!("SysvarRent111111111111111111111111111111111");
const SYSVAR_IX: Address = address!("Sysvar1nstructions1111111111111111111111111");
const MEMO: Address = address!("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const METADATA_UPDATE_AUTH: Address = address!("3axbTs2z5GBy6usVbNVoqEgZMng3vZvMnAoX29BFfwhr");
const COMPUTE_BUDGET: Address = address!("ComputeBudget111111111111111111111111111111");

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

struct Meta {
    slot: u64,
    unix_timestamp: i64,
    pool: Address,
    tick_spacing: u16,
    tick_current: i32,
}

fn load_fixtures(svm: &mut LiteSVM) -> Meta {
    let dir = root().join("fixtures/accounts");
    let mut n = 0;
    for e in fs::read_dir(&dir).unwrap() {
        let p = e.unwrap().path();
        let j: serde_json::Value = serde_json::from_str(&fs::read_to_string(&p).unwrap()).unwrap();
        let pk: Address = j["pubkey"].as_str().unwrap().parse().unwrap();
        let owner: Address = j["owner"].as_str().unwrap().parse().unwrap();
        let data = base64::engine::general_purpose::STANDARD.decode(j["data"].as_str().unwrap()).unwrap();
        let acc = Account { lamports: j["lamports"].as_u64().unwrap(), data, owner, executable: j["executable"].as_bool().unwrap(), rent_epoch: 0 };
        svm.set_account(pk, acc).unwrap();
        n += 1;
    }
    let m: serde_json::Value = serde_json::from_str(&fs::read_to_string(root().join("fixtures/meta.json")).unwrap()).unwrap();
    let meta = Meta {
        slot: m["slot"].as_u64().unwrap(),
        unix_timestamp: m["unix_timestamp"].as_i64().unwrap(),
        pool: m["pool"].as_str().unwrap().parse().unwrap(),
        tick_spacing: m["tick_spacing"].as_u64().unwrap() as u16,
        tick_current: m["tick_current"].as_i64().unwrap() as i32,
    };
    println!("loaded {n} fixture accounts; snapshot slot {} ts {} tick {}", meta.slot, meta.unix_timestamp, meta.tick_current);
    meta
}

fn token_account(mint: &Address, owner: &Address, amount: u64) -> Account {
    let mut d = vec![0u8; 165];
    d[0..32].copy_from_slice(mint.as_array());
    d[32..64].copy_from_slice(owner.as_array());
    d[64..72].copy_from_slice(&amount.to_le_bytes());
    d[108] = 1; // initialized
    if *mint == WSOL {
        d[109..113].copy_from_slice(&1u32.to_le_bytes()); // is_native = Some(rent)
        d[113..121].copy_from_slice(&2_039_280u64.to_le_bytes());
    }
    Account { lamports: 2_039_280 + if *mint == WSOL { amount } else { 0 }, data: d, owner: TOKEN, executable: false, rent_epoch: 0 }
}

fn ata(wallet: &Address, mint: &Address, token_program: &Address) -> Address {
    Address::find_program_address(&[wallet.as_ref(), token_program.as_ref(), mint.as_ref()], &ATA_PROG).0
}

fn cu(limit: u32) -> Instruction {
    let mut d = vec![2u8];
    d.extend_from_slice(&limit.to_le_bytes());
    Instruction { program_id: COMPUTE_BUDGET, accounts: vec![], data: d }
}

struct Env {
    svm: LiteSVM,
    meta: Meta,
    program: Address,
    payer: Keypair,
    user: Keypair,
    vault: Address,
    receipt: Address,
    base_ata: Address,
    quote_ata: Address,
    obligation: Address,
    user_meta: Address,
    lma: Address,
    farm_usdc: Address,
    farm_user_usdc: Address,
    rq: ReserveKeys,
    rb: ReserveKeys,
    pool: PoolKeys,
}

#[derive(Clone)]
struct ReserveKeys {
    reserve: Address,
    liq_mint: Address,
    liq_supply: Address,
    fee_vault: Address,
    coll_mint: Address,
    coll_supply: Address,
    farm_collateral: Address,
}

#[derive(Clone)]
struct PoolKeys {
    pool: Address,
    vault_a: Address,
    vault_b: Address,
    tick_spacing: u16,
}

fn pk(d: &[u8], o: usize) -> Address {
    Address::new_from_array(d[o..o + 32].try_into().unwrap())
}

fn reserve_keys(svm: &LiteSVM, reserve: Address) -> ReserveKeys {
    let d = svm.get_account(&reserve).unwrap().data;
    ReserveKeys { reserve, liq_mint: pk(&d, 128), liq_supply: pk(&d, 160), fee_vault: pk(&d, 192), coll_mint: pk(&d, 2560), coll_supply: pk(&d, 2600), farm_collateral: pk(&d, 64) }
}

fn send(env: &mut Env, ixs: Vec<Instruction>, signers: &[&Keypair], label: &str) -> Result<u64, String> {
    let mut all = vec![cu(1_400_000)];
    all.extend(ixs);
    let msg = Message::new(&all, Some(&env.payer.pubkey()));
    let bh = env.svm.latest_blockhash();
    let mut sv: Vec<&Keypair> = vec![&env.payer];
    for s in signers {
        if s.pubkey() != env.payer.pubkey() {
            sv.push(s);
        }
    }
    let tx = Transaction::new(&sv, msg, bh);
    match env.svm.send_transaction(tx) {
        Ok(m) => {
            println!("  ✔ {label}: {} CU", m.compute_units_consumed);
            Ok(m.compute_units_consumed)
        }
        Err(e) => {
            let logs = e.meta.logs.join("\n    ");
            Err(format!("{label}: {:?}\n    {logs}", e.err))
        }
    }
}

fn expect_err(env: &mut Env, ixs: Vec<Instruction>, signers: &[&Keypair], label: &str, needle: &str) {
    match send(env, ixs, signers, label) {
        Ok(_) => panic!("{label}: expected failure containing {needle:?} but it succeeded"),
        Err(e) => {
            assert!(e.contains(needle), "{label}: expected {needle:?} in error, got:\n{e}");
            println!("  ✔ {label}: rejected as expected ({needle})");
        }
    }
}

fn advance_slot(env: &mut Env) {
    let mut clock: Clock = env.svm.get_sysvar();
    clock.slot += 1;
    clock.unix_timestamp += 1;
    env.svm.warp_to_slot(clock.slot);
    env.svm.set_sysvar(&clock);
    env.svm.expire_blockhash();
}

fn custom(code: u32) -> String {
    format!("Custom({code})")
}

fn vault_state(env: &Env) -> Vec<u8> {
    env.svm.get_account(&env.vault).unwrap().data
}
fn v_u64(d: &[u8], off: usize) -> u64 {
    u64::from_le_bytes(d[off..off + 8].try_into().unwrap())
}
fn token_amt(env: &Env, a: &Address) -> u64 {
    v_u64(&env.svm.get_account(a).unwrap().data, 64)
}
fn mint_supply(env: &Env, a: &Address) -> u64 {
    v_u64(&env.svm.get_account(a).unwrap().data, 36)
}

// field offsets in Vault (repr(C), u8 arrays only)
const V_PHASE: usize = 11;
const V_FLAGS: usize = 13;
const V_EQUITY: usize = 8 + 8 + 32 * 14 + 16; // disc(8)+8 header bytes + 14 keys + params
const V_SUPPLY: usize = V_EQUITY + 8;
const V_SYNC_SLOT: usize = V_EQUITY + 16;
const V_PRICE: usize = V_EQUITY + 24;
const V_HEDGE_BASE: usize = V_EQUITY + 32;
const V_LP_BASE: usize = V_EQUITY + 40;
const V_HEALTH: usize = V_EQUITY + 48;
const V_TICK_LOWER: usize = V_EQUITY + 56;
const V_LIQ: usize = V_EQUITY + 64;
const V_EPOCH: usize = V_EQUITY + 80;

fn params_bytes(max_mint_bps: u16, max_burn_bps: u16, eps_bps: u16, min_health_x100: u16, max_price_dev_bps: u16, max_swap_bps: u16) -> Vec<u8> {
    let mut p = Vec::new();
    for x in [max_mint_bps, max_burn_bps, eps_bps, min_health_x100, max_price_dev_bps, max_swap_bps] {
        p.extend_from_slice(&x.to_le_bytes());
    }
    p.extend_from_slice(&[0u8; 4]);
    p
}

fn print_vault(env: &Env, label: &str) {
    let d = vault_state(env);
    println!(
        "  [{label}] phase={} flags={} equity={} supply={} sync_slot={} price_e12={} hedge_base={} lp_base={} health={} tick=[{},{}] L={} epoch={}",
        d[V_PHASE],
        d[V_FLAGS],
        v_u64(&d, V_EQUITY),
        v_u64(&d, V_SUPPLY),
        v_u64(&d, V_SYNC_SLOT),
        v_u64(&d, V_PRICE),
        v_u64(&d, V_HEDGE_BASE),
        v_u64(&d, V_LP_BASE),
        u32::from_le_bytes(d[V_HEALTH..V_HEALTH + 4].try_into().unwrap()),
        i32::from_le_bytes(d[V_TICK_LOWER..V_TICK_LOWER + 4].try_into().unwrap()),
        i32::from_le_bytes(d[V_TICK_LOWER + 4..V_TICK_LOWER + 8].try_into().unwrap()),
        u128::from_le_bytes(d[V_LIQ..V_LIQ + 16].try_into().unwrap()),
        v_u64(&d, V_EPOCH),
    );
}

// ------------------------------------------------------------------ instruction builders

fn ix_init_vault(env: &Env) -> Instruction {
    let mut data = vec![ixn::INIT_VAULT, HedgeKind::Klend as u8];
    // eps 5%: a 3-tick pool/oracle gap on a ±60-tick range moves a(P) by ~2.5% (gamma); crank sizes to the midpoint in prod
    data.extend(params_bytes(0, 0, 500, 150, 100, 5000));
    Instruction {
        program_id: env.program,
        accounts: vec![
            AccountMeta::new(env.payer.pubkey(), true),
            AccountMeta::new_readonly(env.payer.pubkey(), true),
            AccountMeta::new(env.vault, false),
            AccountMeta::new_readonly(env.pool.pool, false),
            AccountMeta::new_readonly(WSOL, false),
            AccountMeta::new_readonly(USDC, false),
            AccountMeta::new(env.receipt, false),
            AccountMeta::new(env.base_ata, false),
            AccountMeta::new(env.quote_ata, false),
            AccountMeta::new_readonly(TOKEN, false),
            AccountMeta::new_readonly(ATA_PROG, false),
            AccountMeta::new_readonly(SYSTEM, false),
            AccountMeta::new_readonly(RENT, false),
            AccountMeta::new_readonly(KLEND, false),
            AccountMeta::new_readonly(MARKET, false),
            AccountMeta::new(env.user_meta, false),
            AccountMeta::new(env.obligation, false),
            AccountMeta::new_readonly(R_USDC, false),
            AccountMeta::new_readonly(R_SOL, false),
        ],
        data,
    }
}

fn ix_init_farms(env: &Env) -> Instruction {
    Instruction {
        program_id: env.program,
        accounts: vec![
            AccountMeta::new(env.payer.pubkey(), true),
            AccountMeta::new_readonly(env.vault, false),
            AccountMeta::new(env.obligation, false),
            AccountMeta::new_readonly(env.lma, false),
            AccountMeta::new(R_USDC, false),
            AccountMeta::new(env.farm_usdc, false),
            AccountMeta::new(env.farm_user_usdc, false),
            AccountMeta::new_readonly(MARKET, false),
            AccountMeta::new_readonly(FARMS, false),
            AccountMeta::new_readonly(RENT, false),
            AccountMeta::new_readonly(SYSTEM, false),
            AccountMeta::new_readonly(KLEND, false),
        ],
        data: vec![ixn::INIT_FARMS, 0],
    }
}

fn sync_metas(env: &Env, position: Address) -> Vec<AccountMeta> {
    vec![
        AccountMeta::new(env.vault, false),
        AccountMeta::new_readonly(env.pool.pool, false),
        AccountMeta::new_readonly(position, false),
        AccountMeta::new_readonly(env.base_ata, false),
        AccountMeta::new_readonly(env.quote_ata, false),
        AccountMeta::new_readonly(env.receipt, false),
        AccountMeta::new_readonly(KLEND, false),
        AccountMeta::new_readonly(MARKET, false),
        AccountMeta::new(env.obligation, false),
        AccountMeta::new(R_USDC, false),
        AccountMeta::new(R_SOL, false),
        AccountMeta::new_readonly(SCOPE, false),
    ]
}

fn ix_sync(env: &Env, position: Address) -> Instruction {
    Instruction { program_id: env.program, accounts: sync_metas(env, position), data: vec![ixn::SYNC] }
}

fn ix_end(env: &Env, position: Address) -> Instruction {
    let mut accounts = vec![AccountMeta::new_readonly(env.payer.pubkey(), true)];
    accounts.extend(sync_metas(env, position));
    Instruction { program_id: env.program, accounts, data: vec![ixn::END_REBALANCE] }
}

fn ix_user(env: &Env, tag: u8, amount: u64, min_out: u64) -> Instruction {
    let mut data = vec![tag];
    data.extend_from_slice(&amount.to_le_bytes());
    data.extend_from_slice(&min_out.to_le_bytes());
    Instruction {
        program_id: env.program,
        accounts: vec![
            AccountMeta::new_readonly(env.user.pubkey(), true),
            AccountMeta::new(env.vault, false),
            AccountMeta::new(ata(&env.user.pubkey(), &USDC, &TOKEN), false),
            AccountMeta::new(env.quote_ata, false),
            AccountMeta::new(env.receipt, false),
            AccountMeta::new(ata(&env.user.pubkey(), &env.receipt, &TOKEN), false),
            AccountMeta::new_readonly(TOKEN, false),
        ],
        data,
    }
}

fn tick_array(pool: &Address, start: i32) -> Address {
    Address::find_program_address(&[b"tick_array", pool.as_ref(), start.to_string().as_bytes()], &WHIRLPOOL_PROG).0
}

fn ix_init_tick_array(env: &Env, start: i32) -> Instruction {
    let mut data = vec![41u8, 33, 165, 200, 120, 231, 142, 50];
    data.extend_from_slice(&start.to_le_bytes());
    data.push(1); // idempotent
    Instruction {
        program_id: WHIRLPOOL_PROG,
        accounts: vec![
            AccountMeta::new_readonly(env.pool.pool, false),
            AccountMeta::new(env.payer.pubkey(), true),
            AccountMeta::new(tick_array(&env.pool.pool, start), false),
            AccountMeta::new_readonly(SYSTEM, false),
        ],
        data,
    }
}

fn liquidity_block(env: &Env, position: Address, position_ta: Address, tl: i32, tu: i32) -> Vec<AccountMeta> {
    let ts = env.pool.tick_spacing;
    vec![
        AccountMeta::new(env.pool.pool, false),
        AccountMeta::new_readonly(TOKEN, false),
        AccountMeta::new_readonly(TOKEN, false),
        AccountMeta::new_readonly(MEMO, false),
        AccountMeta::new(position, false),
        AccountMeta::new(position_ta, false),
        AccountMeta::new_readonly(WSOL, false),
        AccountMeta::new_readonly(USDC, false),
        AccountMeta::new(env.base_ata, false),
        AccountMeta::new(env.quote_ata, false),
        AccountMeta::new(env.pool.vault_a, false),
        AccountMeta::new(env.pool.vault_b, false),
        AccountMeta::new(tick_array(&env.pool.pool, clmm::tick_array_start_index(tl, ts as u16)), false),
        AccountMeta::new(tick_array(&env.pool.pool, clmm::tick_array_start_index(tu, ts as u16)), false),
        AccountMeta::new_readonly(WHIRLPOOL_PROG, false),
    ]
}

fn ix_begin(env: &Env, position: Address, position_ta: Address, tl: i32, tu: i32) -> Instruction {
    let mut accounts = vec![AccountMeta::new_readonly(env.payer.pubkey(), true), AccountMeta::new(env.vault, false)];
    accounts.extend(liquidity_block(env, position, position_ta, tl, tu));
    let mut data = vec![ixn::BEGIN_REBALANCE];
    data.extend_from_slice(&0u64.to_le_bytes());
    data.extend_from_slice(&0u64.to_le_bytes());
    Instruction { program_id: env.program, accounts, data }
}

fn ix_place(env: &Env, position_mint: Address, position: Address, position_ta: Address, tl: i32, tu: i32, liquidity: u128, max_a: u64, max_b: u64) -> Instruction {
    let mut accounts = vec![
        AccountMeta::new(env.payer.pubkey(), true),
        AccountMeta::new(env.vault, false),
        AccountMeta::new(position_mint, false),
        AccountMeta::new_readonly(TOKEN_2022, false),
        AccountMeta::new_readonly(SYSTEM, false),
        AccountMeta::new_readonly(ATA_PROG, false),
        AccountMeta::new_readonly(METADATA_UPDATE_AUTH, false),
    ];
    accounts.extend(liquidity_block(env, position, position_ta, tl, tu));
    let mut data = vec![ixn::PLACE];
    data.extend_from_slice(&tl.to_le_bytes());
    data.extend_from_slice(&tu.to_le_bytes());
    data.extend_from_slice(&liquidity.to_le_bytes());
    data.extend_from_slice(&max_a.to_le_bytes());
    data.extend_from_slice(&max_b.to_le_bytes());
    Instruction { program_id: env.program, accounts, data }
}

fn ix_hedge(env: &Env, collateral_delta: i64, debt_delta: i64) -> Instruction {
    let mut data = vec![ixn::HEDGE_KLEND];
    data.extend_from_slice(&collateral_delta.to_le_bytes());
    data.extend_from_slice(&debt_delta.to_le_bytes());
    Instruction {
        program_id: env.program,
        accounts: vec![
            AccountMeta::new_readonly(env.payer.pubkey(), true),
            AccountMeta::new(env.vault, false),
            AccountMeta::new(env.quote_ata, false),
            AccountMeta::new(env.base_ata, false),
            AccountMeta::new_readonly(KLEND, false),
            AccountMeta::new_readonly(MARKET, false),
            AccountMeta::new_readonly(env.lma, false),
            AccountMeta::new(env.obligation, false),
            AccountMeta::new(R_USDC, false),
            AccountMeta::new(R_SOL, false),
            AccountMeta::new_readonly(SCOPE, false),
            AccountMeta::new_readonly(env.rq.liq_mint, false),
            AccountMeta::new(env.rq.liq_supply, false),
            AccountMeta::new(env.rq.coll_mint, false),
            AccountMeta::new(env.rq.coll_supply, false),
            AccountMeta::new(env.farm_user_usdc, false),
            AccountMeta::new(env.farm_usdc, false),
            AccountMeta::new_readonly(env.rb.liq_mint, false),
            AccountMeta::new(env.rb.liq_supply, false),
            AccountMeta::new(env.rb.fee_vault, false),
            AccountMeta::new_readonly(KLEND, false), // no SOL debt farm → None
            AccountMeta::new_readonly(KLEND, false),
            AccountMeta::new_readonly(FARMS, false),
            AccountMeta::new_readonly(TOKEN, false),
            AccountMeta::new_readonly(SYSVAR_IX, false),
        ],
        data,
    }
}

fn ix_swap(env: &Env, amount: u64, other_threshold: u64, amount_is_input: bool, a_to_b: bool) -> Instruction {
    let ts = env.pool.tick_spacing;
    let cur = read_pool(env).tick_current_index;
    let span = 88 * ts as i32;
    let start = clmm::tick_array_start_index(cur, ts);
    let dir = if a_to_b { -1 } else { 1 };
    let (oracle, _) = Address::find_program_address(&[b"oracle", env.pool.pool.as_ref()], &WHIRLPOOL_PROG);
    let limit: u128 = if a_to_b { clmm::MIN_SQRT_PRICE_X64 } else { clmm::MAX_SQRT_PRICE_X64 };
    let mut data = vec![ixn::SWAP];
    data.extend_from_slice(&amount.to_le_bytes());
    data.extend_from_slice(&other_threshold.to_le_bytes());
    data.extend_from_slice(&limit.to_le_bytes());
    data.push(amount_is_input as u8);
    data.push(a_to_b as u8);
    Instruction {
        program_id: env.program,
        accounts: vec![
            AccountMeta::new_readonly(env.payer.pubkey(), true),
            AccountMeta::new(env.vault, false),
            AccountMeta::new_readonly(TOKEN, false),
            AccountMeta::new_readonly(TOKEN, false),
            AccountMeta::new_readonly(MEMO, false),
            AccountMeta::new(env.pool.pool, false),
            AccountMeta::new_readonly(WSOL, false),
            AccountMeta::new_readonly(USDC, false),
            AccountMeta::new(env.base_ata, false),
            AccountMeta::new(env.pool.vault_a, false),
            AccountMeta::new(env.quote_ata, false),
            AccountMeta::new(env.pool.vault_b, false),
            AccountMeta::new(tick_array(&env.pool.pool, start), false),
            AccountMeta::new(tick_array(&env.pool.pool, start + dir * span), false),
            AccountMeta::new(tick_array(&env.pool.pool, start + 2 * dir * span), false),
            AccountMeta::new(oracle, false),
            AccountMeta::new_readonly(WHIRLPOOL_PROG, false),
        ],
        data,
    }
}

fn read_pool(env: &Env) -> venue::whirlpool::WhirlpoolView {
    let d = env.svm.get_account(&env.pool.pool).unwrap().data;
    venue::whirlpool::WhirlpoolView {
        tick_spacing: u16::from_le_bytes(d[41..43].try_into().unwrap()),
        fee_rate: u16::from_le_bytes(d[45..47].try_into().unwrap()),
        liquidity: u128::from_le_bytes(d[49..65].try_into().unwrap()),
        sqrt_price: u128::from_le_bytes(d[65..81].try_into().unwrap()),
        tick_current_index: i32::from_le_bytes(d[81..85].try_into().unwrap()),
        token_mint_a: d[101..133].try_into().unwrap(),
        token_vault_a: d[133..165].try_into().unwrap(),
        token_mint_b: d[181..213].try_into().unwrap(),
        token_vault_b: d[213..245].try_into().unwrap(),
    }
}

fn main() {
    let mut svm = LiteSVM::new().with_blockhash_check(false).with_sigverify(true).with_transaction_history(0);
    let meta = load_fixtures(&mut svm);
    // freeze the clock at the snapshot so klend's oracle-age checks pass
    svm.warp_to_slot(meta.slot);
    let mut clock: Clock = svm.get_sysvar();
    clock.slot = meta.slot;
    clock.unix_timestamp = meta.unix_timestamp + 25; // later than every fixture's last-update ts, still inside Scope's 120s window
    clock.epoch = meta.slot / 432_000;
    svm.set_sysvar(&clock);

    // programs
    let prog_dir = root().join("fixtures/programs");
    svm.add_program_from_file(KLEND, prog_dir.join("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD.so")).unwrap();
    svm.add_program_from_file(WHIRLPOOL_PROG, prog_dir.join("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc.so")).unwrap();
    svm.add_program_from_file(FARMS, prog_dir.join("FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr.so")).unwrap();
    let kp: Vec<u8> = serde_json::from_str(&fs::read_to_string(root().join("target/deploy/dlp_vault-keypair.json")).unwrap()).unwrap();
    let program = Keypair::try_from(kp.as_slice()).unwrap().pubkey();
    svm.add_program_from_file(program, root().join("target/deploy/dlp_vault.so")).unwrap();

    let payer = Keypair::new();
    let user = Keypair::new();
    svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();
    svm.airdrop(&user.pubkey(), 10_000_000_000).unwrap();

    let pool = {
        let d = svm.get_account(&meta.pool).unwrap().data;
        PoolKeys { pool: meta.pool, vault_a: pk(&d, 133), vault_b: pk(&d, 213), tick_spacing: meta.tick_spacing }
    };
    let (vault, _) = Address::find_program_address(&[b"vault", pool.pool.as_ref(), MARKET.as_ref(), &[HedgeKind::Klend as u8]], &program);
    let (receipt, _) = Address::find_program_address(&[b"receipt", vault.as_ref()], &program);
    let (user_meta, _) = Address::find_program_address(&[b"user_meta", vault.as_ref()], &KLEND);
    let (obligation, _) = Address::find_program_address(&[&[0u8], &[0u8], vault.as_ref(), MARKET.as_ref(), &[0u8; 32], &[0u8; 32]], &KLEND);
    let (lma, _) = Address::find_program_address(&[b"lma", MARKET.as_ref()], &KLEND);
    let rq = reserve_keys(&svm, R_USDC);
    let rb = reserve_keys(&svm, R_SOL);
    let farm_usdc = rq.farm_collateral;
    let (farm_user_usdc, _) = Address::find_program_address(&[b"user", farm_usdc.as_ref(), obligation.as_ref()], &FARMS);
    let base_ata = ata(&vault, &WSOL, &TOKEN);
    let quote_ata = ata(&vault, &USDC, &TOKEN);

    // user holds 10,000 USDC
    svm.set_account(ata(&user.pubkey(), &USDC, &TOKEN), token_account(&USDC, &user.pubkey(), 10_000_000_000)).unwrap();

    let mut env = Env { svm, meta, program, payer, user, vault, receipt, base_ata, quote_ata, obligation, user_meta, lma, farm_usdc, farm_user_usdc, rq, rb, pool };
    println!("program {} vault {} receipt {}", env.program, env.vault, env.receipt);

    // ---------------------------------------------------------------- init
    let ix = ix_init_vault(&env);
    send(&mut env, vec![ix], &[], "InitVault (vault PDA + receipt mint + ATAs + klend user_metadata + obligation)").unwrap();
    assert!(env.svm.get_account(&env.obligation).is_some(), "obligation created");
    let ix = ix_init_farms(&env);
    send(&mut env, vec![ix], &[], "InitFarms (USDC collateral farm user state)").unwrap();
    // user receipt ATA (fabricated, empty) + tiny SOL cushion in the vault base ATA for repay rounding
    env.svm.set_account(ata(&env.user.pubkey(), &env.receipt, &TOKEN), token_account(&env.receipt, &env.user.pubkey(), 0)).unwrap();
    let base_ata_acc = env.svm.get_account(&env.base_ata).unwrap();
    let cushion = 20_000u64; // 0.00002 SOL
    let mut d = base_ata_acc.data.clone();
    d[64..72].copy_from_slice(&cushion.to_le_bytes());
    env.svm.set_account(env.base_ata, Account { lamports: base_ata_acc.lamports + cushion, data: d, ..base_ata_acc }).unwrap();

    // ---------------------------------------------------------------- sync + deposit
    let no_pos = env.vault; // placeholder while no position exists
    let ix = ix_sync(&env, no_pos);
    send(&mut env, vec![ix], &[], "Sync (empty vault)").unwrap();
    print_vault(&env, "after sync");

    let user_kp = Keypair::try_from(env.user.to_bytes().as_slice()).unwrap();
    let dep = ix_user(&env, ixn::DEPOSIT, 1_000_000_000, 1_000_000_000);
    advance_slot(&mut env);
    expect_err(&mut env, vec![dep.clone()], &[&user_kp], "Deposit without Sync in this slot", &custom(1003));
    let ix = ix_sync(&env, no_pos);
    send(&mut env, vec![ix, dep], &[&user_kp], "Sync + Deposit 1000 USDC").unwrap();
    print_vault(&env, "after deposit");
    assert_eq!(mint_supply(&env, &env.receipt), 1_000_000_000);
    assert_eq!(token_amt(&env, &env.quote_ata), 1_000_000_000);

    // ---------------------------------------------------------------- rebalance #1: borrow + place
    let pool_view = read_pool(&env);
    let ts = env.pool.tick_spacing as i32;
    let cur = pool_view.tick_current_index;
    let tl = (cur - 60).div_euclid(ts) * ts;
    let tu = (cur + 60).div_euclid(ts) * ts;
    println!("  range [{tl},{tu}] around tick {cur} (±0.6%)");
    // target: 600 USDC collateral, 200 USDC in the LP, borrow the matching SOL
    let sqrt_lower = clmm::sqrt_price_from_tick_index(tl);
    let sqrt_upper = clmm::sqrt_price_from_tick_index(tu);
    let l_from_b = clmm::liquidity_from_b(sqrt_lower, pool_view.sqrt_price, 200_000_000).unwrap();
    let (need_a, need_b) = clmm::position_amounts(cur, pool_view.sqrt_price, tl, tu, l_from_b, true).unwrap();
    println!("  L={l_from_b} needs a={need_a} lamports ({:.4} SOL) b={need_b} ({:.2} USDC)", need_a as f64 / 1e9, need_b as f64 / 1e6);
    let _ = sqrt_upper;

    let epoch0 = 0u64;
    let (pmint, _) = Address::find_program_address(&[b"pmint", env.vault.as_ref(), &epoch0.to_le_bytes()], &env.program);
    let (position, _) = Address::find_program_address(&[b"position", pmint.as_ref()], &WHIRLPOOL_PROG);
    let position_ta = ata(&env.vault, &pmint, &TOKEN_2022);

    // negatives first: non-crank begin, deposit while not idle (after begin)
    let bad = {
        let mut i = ix_begin(&env, position, position_ta, tl, tu);
        i.accounts[0] = AccountMeta::new_readonly(env.user.pubkey(), true);
        i
    };
    expect_err(&mut env, vec![bad], &[&user_kp], "Begin signed by non-crank", &custom(1001));

    let ta0 = ix_init_tick_array(&env, clmm::tick_array_start_index(tl, ts as u16));
    let ta1 = ix_init_tick_array(&env, clmm::tick_array_start_index(tu, ts as u16));
    let begin = ix_begin(&env, position, position_ta, tl, tu);
    send(&mut env, vec![ta0, ta1, begin], &[], "Begin (no position yet) + tick arrays").unwrap();
    print_vault(&env, "after begin");
    let dep2 = ix_user(&env, ixn::DEPOSIT, 1_000_000, 0);
    let s = ix_sync(&env, no_pos);
    expect_err(&mut env, vec![s, dep2], &[&user_kp], "Deposit while phase != Idle", &custom(1000));

    let hedge = ix_hedge(&env, 600_000_000, need_a as i64 + 1);
    send(&mut env, vec![hedge], &[], "HedgeKlend: +600 USDC collateral, borrow SOL").unwrap();
    print_vault(&env, "after hedge");
    let sol_now = token_amt(&env, &env.base_ata);
    println!("  vault wSOL after borrow: {sol_now} lamports; USDC idle: {}", token_amt(&env, &env.quote_ata));
    assert!(sol_now >= need_a);

    // holding the borrowed SOL idle is delta-neutral; selling it is not → End must fail the delta guard
    let sw = ix_swap(&env, sol_now, 0, true, true);
    send(&mut env, vec![sw], &[], "Swap: sell all borrowed SOL → USDC (crank error simulation)").unwrap();
    println!("  after sell: wSOL {} USDC {}", token_amt(&env, &env.base_ata), token_amt(&env, &env.quote_ata));
    let e = ix_end(&env, no_pos);
    expect_err(&mut env, vec![e], &[], "End with debt but no SOL / no LP", &custom(1006));
    let sw = ix_swap(&env, sol_now, u64::MAX, false, false);
    send(&mut env, vec![sw], &[], "Swap: buy the SOL back (exact out)").unwrap();
    println!("  after buy-back: wSOL {} USDC {} (round-trip swap cost)", token_amt(&env, &env.base_ata), token_amt(&env, &env.quote_ata));
    assert!(token_amt(&env, &env.base_ata) >= need_a);

    let place = ix_place(&env, pmint, position, position_ta, tl, tu, l_from_b, need_a + need_a / 100, need_b + need_b / 100);
    send(&mut env, vec![place], &[], "Place (open position + increase liquidity)").unwrap();
    print_vault(&env, "after place");

    let e = ix_end(&env, position);
    send(&mut env, vec![e], &[], "End (sync + guards → Idle)").unwrap();
    print_vault(&env, "after end");
    let d = vault_state(&env);
    assert_eq!(d[V_PHASE], 0);
    let equity = v_u64(&d, V_EQUITY);
    println!("  NAV = {:.6} USDC/receipt   idle USDC = {}", equity as f64 / 1e6 / (v_u64(&d, V_SUPPLY) as f64 / 1e6), token_amt(&env, &env.quote_ata));
    assert!(equity > 995_000_000 && equity <= 1_000_000_000, "equity {equity}");

    // ---------------------------------------------------------------- withdraw 100 at NAV
    let s = ix_sync(&env, position);
    let w = ix_user(&env, ixn::WITHDRAW, 100_000_000, 99_000_000);
    let before = token_amt(&env, &ata(&env.user.pubkey(), &USDC, &TOKEN));
    send(&mut env, vec![s, w], &[&user_kp], "Sync + Withdraw 100 receipt").unwrap();
    let got = token_amt(&env, &ata(&env.user.pubkey(), &USDC, &TOKEN)) - before;
    println!("  withdrew {} USDC for 100 receipt", got as f64 / 1e6);
    assert!(got > 99_000_000 && got <= 100_000_000);
    // over-withdraw beyond idle quote → InsufficientIdleQuote
    let s = ix_sync(&env, position);
    let w = ix_user(&env, ixn::WITHDRAW, 800_000_000, 0);
    expect_err(&mut env, vec![s, w], &[&user_kp], "Withdraw more than idle quote", &custom(1007));

    // ---------------------------------------------------------------- rebalance #2: full unwind
    let begin = ix_begin(&env, position, position_ta, tl, tu);
    send(&mut env, vec![begin], &[], "Begin (pull liquidity + collect fees)").unwrap();
    print_vault(&env, "after begin#2");
    let sol_back = token_amt(&env, &env.base_ata);
    let d = vault_state(&env);
    let debt = v_u64(&d, V_HEDGE_BASE);
    println!("  wSOL in vault {sol_back}, debt {debt}");
    assert!(sol_back >= debt, "need enough SOL to repay");
    let hedge = ix_hedge(&env, -600_000_000, -(debt as i64));
    send(&mut env, vec![hedge], &[], "HedgeKlend: repay all SOL, withdraw 600 USDC collateral").unwrap();
    print_vault(&env, "after unwind hedge");
    let e = ix_end(&env, position);
    send(&mut env, vec![e], &[], "End (flat: no LP, no debt)").unwrap();
    print_vault(&env, "after end#2");
    let d = vault_state(&env);
    assert_eq!(d[V_PHASE], 0);
    assert_eq!(v_u64(&d, V_HEDGE_BASE), 0);
    let ob_acc = env.svm.get_account(&env.obligation);
    println!("  obligation after full unwind: {} (klend closes it; rent → vault PDA: {} lamports)", if ob_acc.is_none() { "closed".to_string() } else { format!("owner {}", ob_acc.as_ref().unwrap().owner) }, env.svm.get_balance(&env.vault).unwrap());
    assert!(ob_acc.map(|a| a.owner != KLEND).unwrap_or(true));
    let reopen = Instruction {
        program_id: env.program,
        accounts: vec![
            AccountMeta::new(env.payer.pubkey(), true),
            AccountMeta::new(env.vault, false),
            AccountMeta::new(env.obligation, false),
            AccountMeta::new_readonly(MARKET, false),
            AccountMeta::new_readonly(SYSTEM, false),
            AccountMeta::new_readonly(env.user_meta, false),
            AccountMeta::new_readonly(RENT, false),
            AccountMeta::new_readonly(KLEND, false),
        ],
        data: vec![ixn::REOPEN_OBLIGATION],
    };
    send(&mut env, vec![reopen], &[], "ReopenObligation").unwrap();
    assert_eq!(env.svm.get_account(&env.obligation).unwrap().owner, KLEND);

    // withdraw (almost) everything: the equity also counts the SOL dust cushion, which is not idle USDC
    let supply = mint_supply(&env, &env.receipt) - 10_000; // leave 0.01 receipt of dust
    let s = ix_sync(&env, position);
    let w = ix_user(&env, ixn::WITHDRAW, supply, 0);
    let before = token_amt(&env, &ata(&env.user.pubkey(), &USDC, &TOKEN));
    send(&mut env, vec![s, w], &[&user_kp], "Sync + Withdraw all").unwrap();
    let got = token_amt(&env, &ata(&env.user.pubkey(), &USDC, &TOKEN)) - before;
    println!("  withdrew {} USDC for {} receipt; receipt supply now {}", got as f64 / 1e6, supply as f64 / 1e6, mint_supply(&env, &env.receipt));
    let total_back = got + 100_000_000 - (100_000_000 - (100_000_000 - 0)); // just print
    let _ = total_back;
    let user_usdc = token_amt(&env, &ata(&env.user.pubkey(), &USDC, &TOKEN));
    println!("  user USDC end balance {} (started 10000.000000) → round-trip cost {:.6} USDC", user_usdc as f64 / 1e6, (10_000_000_000i64 - user_usdc as i64) as f64 / 1e6);
    assert_eq!(mint_supply(&env, &env.receipt), 10_000);
    assert!(user_usdc > 9_990_000_000, "round trip lost too much: {user_usdc}");
    println!("ALL GOOD");
}

#[cfg(test)]
mod t {
    #[test]
    fn e2e() {
        super::main();
    }
}
