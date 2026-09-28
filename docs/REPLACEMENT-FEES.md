# Replacement fee stack: 3% / 6%, Wizards and four collections

> Superseded deployment record: v6 replaces the entire immutable fee/NFT stack. Use [V6-REPLACEMENT.md](V6-REPLACEMENT.md) for current addresses and activation steps. Keep v5 available for deposit recovery. The v5 commands below document its historical deployment.

The September 28 replacement core is deployed on Robinhood Chain 4663. It does
not modify the older v3 contracts, which retain 2% entry / 4% exit and all-Wizards.
The reused v4 controller reports 3% entry / 6% exit. All 100 members and the
corrected v5 receipt are deployed and configured. The four NFT collections and contribution adapter are
deployed, configured and paused; all 30 transactions succeeded. No opening
transaction has been submitted.

| Replacement component | Confirmed address |
| --- | --- |
| Member controller | `0xae3600b13a2F894f81F6565DD207492601B2Ce3E` |
| DN receipt vault | `0x3D4Ee6D147AF67371073e74206D6d49e64960f9c` |
| Split house-fee router | `0x0264C6739483f80285B4e6ebd342B22b3785A9F0` |
| Four-collection NFT fanout | `0x5D38705D0c40c814CF2Eeb67d9ECD885cd9708FC` |

All core transaction receipts succeeded and their runtime hashes are recorded in
`evm/deployments/4663-tokenized-v5.json`. The old empty v4 receipt is superseded;
v5 measures the execution loss bound after entry fees. All seven canonical core
contracts have matching creation and runtime source verification on Sourcify. The v5 keeper is healthy in observation mode; all nine
transactions in its preserved v3 journal were independently receipt-verified.
The website now uses v5 addresses and returns the 3%/6% rates. All 200 child
contracts and five NFT/adapter contracts also have Sourcify creation/runtime
matches. NFT sales and DN entries remain closed.

## Economics

- Member issuance charges 3% of gross USDG. Member redemption charges 6% of
  the gross claim. Exit escrow cash uses the same 6% rule, exactly once.
- `SplitFeeMemberController` routes these fees through `SplitHouseFeeRouter`:
  half to Homecoming's existing 8,010-share Wizards fanout and half to
  `WeightedNftFeeFanout`.
- The NFT recipient covers **four separate collections, 10,000 IDs each**.
  Their weights are 1, 2, 5 and 10 according to the mint tier.
  The total weight is 180,000. Changing ETH/USD or a resale price does not
  change these fixed weights.
- The $20/$50/$100 source art is retained for later and has no entitlement in
  this launch's fee pool. All 40,000 launch assets are published and URL-verified.
- Unminted IDs retain their reserved share; minting one later acquires that
  accumulated entitlement. Early minters do not divide the entire NFT half
  among themselves. Unclaimed fees follow current NFT ownership. Claims require
  an existing token and support up to 50 IDs per transaction.
- All ERC-20 transfers remain untaxed. AMM fees belong to their pools/LPs.
- Separate NFT primary fees (1%) and secondary royalties (10%) continue to use
  the legacy Wizards-only router. They are not silently split by this change.

At unchanged NAV and before other costs, 100 USDG becomes 97 USDG backing and
91.18 USDG on redemption. Wizards and the NFT distributor each receive 4.41 USDG.
The combined fees are 8.82%, not a promise of yield. The NFT primary illustration
is 89% routed into DN and 86.33% backing after a 3% DN issuance fee, before swaps.

Each asset has independent rounding/accounting. The router carries odd units
across payments, so splitting fees into tiny payments cannot bias the lifetime
split. The NFT distributor uses cumulative entitlements, so frequent harvests
do not discard fractional claims. Neither contract has a withdrawal or recipient
replacement admin. The initializer can register the four editions once; that
authority is then erased.

## Operator deployment sequence

The v5 core and all 100 member/custody pairs already exist. Do not repeat their
deployment. Version v5 reuses the v4 components and replaces only the empty
receipt vault. The fee-aware vault has a 1% execution-loss allowance after the
3% entry fee; it still checks actual position and liquidity backing.

These commands are for the operator to run. Do not run another signer against
the same EOA concurrently. Preserve the existing Fly volume and every signed
journal. First put the old worker in observation mode and inspect unresolved
transactions; changing mode does not cancel transactions already accepted.

```sh
cd /Users/stacc/delta-LP
flyctl secrets set DELTA_KEEPER_MODE=observe --app delta-lp-keeper
```

The replacement vault is configured, empty and closed. Public deployment records
retain exact transaction hashes; signed transaction bytes stay in ignored,
private files. No deployment command transfers strategy collateral or trades.

After all four artwork/metadata sets have been published and verified, prepare
the NFT collections against the new receipt and distributor:

```sh
node --env-file=.env.keeper.local nft/prepare-deployment.mjs --version=v5
```

This emits the pending-contribution deployment/configuration bundle at
`artifacts/nft-deployment/unsigned.json`. Review and submit it from the recorded
operator wallet. The reviewed broadcaster is
`evm/scripts/deploy-nft-bundle.mjs --version=v5 --broadcast`. It includes one-time `WeightedNftFeeFanout.configure` with the
four collection addresses, and leaves NFT mints paused. Source/runtime checks
reject v3 as a substitute for the replacement receipt.

Once the replacement stack, all 100 members, and the four-collection registry
exist on-chain, generate local bindings from verified chain state:

```sh
node --env-file=.env.keeper.local evm/scripts/publish-stack-bindings.mjs --version=v5
npm run check
```

This checks the rates, router/distributor wiring, bytecode hashes, registry,
empty closed vault and member identities. It does not accept placeholder addresses
or turn deposits on. Keep the v3 deployment records for historical verification.
Submit source verification using `verify-members-sourcify.mjs --version=v5`
and `verify-neutral-members.mjs --version=v5`.

The site and keeper must then be rebuilt against those bindings. Before restarting
execution, reconcile the old controller's journal and all operator deployment
transactions. A v3 journal is bound to its controller and must not be reused as a
v5 journal, discarded, or silently reset to bypass an unresolved nonce. Preserve
the old directory and use a separately reviewed v5 state directory only after
that reconciliation. The supplied server RPC is already staged on Fly.

Final activation is an operator action. The keeper opens entries after initial
reports and enabled members; the replacement vault additionally refuses opening
until the four fee recipients are configured. The 2,000 USDG threshold is the
minimum pooled allocation batch. NFT mint proceeds contribute real USDG toward
it; the creator does not need to supply this capital. Pending NFT contributions
can begin with zero receipt supply, and their owners can withdraw before the
batch is queued. Receipt issuance still waits for reconciled positions and
actual V4 liquidity. See `NFT-EDITIONS.md` for pending contribution recovery.

## Runtime changes

Browser reads use `VITE_ROBINHOOD_RPC_URL`; server/keeper/deployment tooling use
`ROBINHOOD_RPC_URL`. Do not put the server credential in browser variables, source,
public deployment records or documents. Both endpoints were checked for chain 4663.

The keeper waits when RPC pending nonces trail its signed journal, retains the
same signed hash on lost acknowledgments and retries recognized temporary
transport failures. Forward nonce conflicts, expiry, reverts and missing receipts
still require reconciliation. These repairs do not prove a funded mainnet cycle.

Wallet USDG reads run independently of pool valuation and exit history. The site
reports live contract rates rather than pretending the replacement is already
active. Receipt minimums and keeper allocation amounts use the bound fee policy.
