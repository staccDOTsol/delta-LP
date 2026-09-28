# Run the v3 operator

The keeper is a separate long-running Node process. Vercel serves the website;
it does not keep this process alive. The deployed controller assigns both keeper
and reporter roles to `0x26E8134eCC3af5cCE32f34B03E7BD2f318B25158`.

The service has been tested with mocked venue execution, the real vendored signing
WASM, and read-only snapshots of all 100 deployed members. It has **not** completed
a funded mainnet lifecycle. The September 28 deployment left entries closed and
strategy accounts unfunded. The Fly worker is running in **observation mode**;
transaction signing is disabled and no private key was uploaded during deployment.

## Fly deployment

[`delta-lp-keeper`](https://fly.io/apps/delta-lp-keeper/monitoring) runs one Machine
in Toronto (`yyz`), with 1 shared CPU and 512 MB memory. Its encrypted 1 GB
`keeper_data` volume mounts at `/data`; status and transaction journals live at
`/data/keeper-v3`. Keep exactly one worker for this operator account. The app has
no public HTTP service or public IP; its internal `/healthz` check requires a fresh
snapshot of all 100 distinct members from the current process.
The [September 28 deployment record](deployments/fly-keeper-2026-09-28.json)
contains the image, Machine, volume and verified observation state.

```sh
cd /Users/stacc/delta-LP
flyctl status --app delta-lp-keeper
flyctl checks list --app delta-lp-keeper
flyctl logs --app delta-lp-keeper
```

The deployed image includes only explicitly allowed source, public deployment
metadata and the vendored signer. Local environment files, keys and journals are
excluded from the Docker build context. For subsequent deployments:

```sh
flyctl deploy --app delta-lp-keeper --config fly.toml --ha=false --no-public-ips
```

Use `--ha=false` to avoid creating a second worker. The persistent volume has daily
snapshots with seven-day retention. It survives a Machine restart, but it is not a
shared or automatically replicated journal. Do not create a fresh empty volume
to get past a signing or recovery failure.

### Activate signing on Fly yourself

```sh
cd /Users/stacc/delta-LP
npm run keeper:fly-launch
```

The interactive helper asks for your per-member USDG limit, per-order notional
limit, ETH gas budget and existing key-file path. It checks that there is exactly
one Fly Machine and refuses an active local worker or existing local transaction
history that has not been migrated. Type `START` only to authorize real execution.
The helper sends the key and configuration to Fly's encrypted secrets through
stdin, stages `DELTA_KEEPER_MODE=execute`, and deploys the single worker. It never
puts the key in shell arguments or image layers. This is an explicit upload of
signing authority to Fly; the cloud worker writes restricted runtime files under
`/run/delta-keeper`, outside the persistent journal volume.

To return the worker to observation mode, run:

```sh
flyctl secrets set DELTA_KEEPER_MODE=observe --app delta-lp-keeper
```

Fly secrets override `fly.toml` environment settings: editing the TOML default
alone does not disable an already activated signer. Switching modes does not
cancel accepted transactions, close entries or close existing positions. Reconcile
pending journal entries before another signer uses this account.

## Check without signing

```sh
cd /Users/stacc/delta-LP
npm run keeper:observe -- --once
```

This mode never reads a private key, sends a transaction, or opens entries.
`artifacts/keeper-v3/status.json` records per-member decisions and the current
vault phase. `ready` means an unsigned next operation was identified; it does
not mean trading is live. On the empty deployment those operations are initial
zero-equity reports, proven by unused custody state and the L1 account registry.

## Local alternative: choose limits and start

For the guided interactive startup, run this yourself:

```sh
cd /Users/stacc/delta-LP
npm run keeper:launch
```

It asks for your per-member USDG limit, per-order notional limit and ETH gas budget,
then the existing key-file path. New settings enable owner bootstrap. Type `START`
only when you intend to run real transactions. The script saves the settings and
starts the keeper in the foreground. It refuses non-interactive invocation.
For existing settings it displays them and asks you to confirm reuse; it does not
silently increase a budget. The manual equivalent follows.

Use an always-on machine with Node 24, installed dependencies and a reliable
connection. Only one process may write transactions from the operator account;
other scripts or wallets using the same EOA can cause a nonce conflict.

```sh
cd /Users/stacc/delta-LP
mkdir -p artifacts/keeper-v3
chmod 700 artifacts/keeper-v3
cp keeper/config.example.json artifacts/keeper-v3/config.json
chmod 600 artifacts/keeper-v3/config.json ~/staccoverflow.eth
```

Edit `artifacts/keeper-v3/config.json` and replace the three zero limits:

| Setting | Meaning |
| --- | --- |
| `maxMemberAssets` | Maximum accounted NAV for each individual member, in USDG micro-units. `1000000` is 1 USDG. There are 100 members. |
| `maxOrderNotional` | Maximum notional of any single rebalance, in USDG micro-units, including reductions. It must accommodate the tiers you operate. |
| `maximumGasWei` | Lifetime ETH gas budget for this journal, in wei. `1000000000000000` is 0.001 ETH. Unconfirmed transactions reserve their maximum cost. |
| `ownerBootstrap` | Set `true` to initialize unused members, open deposit collection, register first venue keys, and configure cross margin. It never rotates an existing configured key. |

Capital and gas limits are operator decisions, not defaults supplied by the app.
Keep the polling, cancellation and reporting intervals from the example initially.
The gas budget includes ongoing reports for 100 members; the displayed deployment
gas cost is not an estimate of ongoing operating cost.

Start the signing process yourself:

```sh
DELTA_KEEPER_CONFIG="$PWD/artifacts/keeper-v3/config.json" \
DELTA_KEEPER_STATE="$PWD/artifacts/keeper-v3" \
DELTA_KEEPER_KEY_FILE="$HOME/staccoverflow.eth" \
npm run keeper:run
```

This local command can move the members' accounted collateral and place real leveraged
orders. It uses the existing key file locally; do not paste the key into commands.
It does not take USDG from the operator wallet. Keep the terminal/process running;
Ctrl-C stops after the current cycle and preserves its journals. No OS service
or automatic restart job was installed locally. Stop the Fly signer before using
this alternative, and migrate its transaction history rather than resetting it.

## Deposit and activation

After bootstrap opens collection, connect a wallet at [deltalp.fun](https://deltalp.fun/)
on Robinhood Chain and use **Enter delta neutral**. Approve the exact USDG amount
and confirm the deposit. The 50-tier vault requires **2,000 USDG pooled per batch**;
that threshold is not a suggested personal deposit. The operator's per-member
limits must fit the batch. A small deposit remains pending until the batch fills.

The keeper starts the allocation with NAV-based minimums, issues all 100 claims
atomically, funds their isolated accounts, binds the actual venue indices, and
configures first-time margin where needed. It then submits bounded L1 orders,
cancels unfilled remainders and reports actual account state. Receipts are minted
only after `activate` passes every contract check and adds the real V4 liquidity.
The 2% entry fee is taken at member claim issuance, before external trading has
necessarily completed. Recovery paths remain available if activation stalls.

Transfers and swaps request fresh family checks. The worker checks current targets
and avoids obsolete intermediate work. This is asynchronous venue execution, not
a guarantee of a completed rebalance within each ERC-20 transfer.

For an exit, the wallet requests redemption once. The keeper discovers the vault's
exit escrow, queues pairs in batches of 20 members, reduces positions, withdraws
and collects USDG, settles requests and calls `finish` when the recorded payout
minimum is met. It never lowers that minimum or extends an owner's deadline.
An expired request or unachievable minimum requires the owner's recovery action.

## Failure and restart behavior

- Pending signed L1 transactions are saved with their exact hash, raw bytes,
  sender nonce and maximum gas cost before submission. A timeout cannot create a
  new order. Recovery looks up that hash and may rebroadcast only identical bytes.
- Unknown expired submissions, changed nonces, reverted transactions, changed
  bytecode or recent receipt reorganizations stop execution. Inspect the chain and
  journal before restarting; do not delete them just to force a retry.
- Margin setup persists the venue hash before submission and does not resend on
  timeout. A missing or failed hash requires operator investigation. Private
  venue keys are derived in memory from an owner signature, matching `/operator`.
- A process lock rejects a second worker. After a crash, confirm the old process
  is gone and reconcile pending transactions before removing only `worker.lock`.
  On Fly this lock is `/data/keeper-v3/worker.lock`. A graceful SIGTERM restart
  removes it after the current cycle; a forced kill can leave it behind. Automatic
  process restart deliberately does not erase that lock or the signed journal.
- API errors, wrong custody identity, unprocessed priority requests, foreign
  positions/collateral, remaining orders or stale data block reporting and trading.
  An accepted order transaction is never treated as a guaranteed full fill.
- Entries are not automatically closed when the machine stops; deposited cash
  remains subject to the vault's cancellation/recovery rules. Fresh reports and
  actual matching-engine execution are still required for activation and USDG exits.

The reporter remains trusted. A 100-account funded run, sustained reporting
throughput, independent mark validation and a tested operational recovery procedure
remain requirements before presenting this as a proven live trading service.

Implementation: `keeper/`. Run `npm run check`. Public deployment/source records
are under `evm/deployments/`; signed operator journals stay in ignored `artifacts/`.
