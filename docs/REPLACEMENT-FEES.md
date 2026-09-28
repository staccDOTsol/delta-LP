# Replacement fee stack: 3% / 6%, Wizards and seven collections

The September 28 revision is implemented in source. It does not modify the
already deployed v3 contracts, which remain 2% entry / 4% exit and all-Wizards.
No replacement contract deployment or opening transaction has been submitted by
the assistant. The production website and its RPC/balance fixes are deployed.

## Economics

- Member issuance charges 3% of gross USDG. Member redemption charges 6% of
  the gross claim. Exit escrow cash uses the same 6% rule, exactly once.
- `SplitFeeMemberController` routes these fees through `SplitHouseFeeRouter`:
  half to Homecoming's existing 8,010-share Wizards fanout and half to
  `WeightedNftFeeFanout`.
- The NFT recipient covers **seven separate collections, 10,000 IDs each**.
  Their weights are 1, 2, 5, 10, 20, 50 and 100 according to the mint tier.
  The total weight is 1,880,000. Changing ETH/USD or a resale price does not
  change these fixed weights.
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
replacement admin. The initializer can register the seven editions once; that
authority is then erased.

## Operator deployment sequence

These commands are for the operator to run. Do not run another signer against
the same EOA concurrently. Preserve the existing Fly volume and every signed
journal. First put the old worker in observation mode and inspect unresolved
transactions; changing mode does not cancel transactions already accepted.

```sh
cd /Users/stacc/delta-LP
flyctl secrets set DELTA_KEEPER_MODE=observe --app delta-lp-keeper
```

The replacement contracts start empty and closed. The first simulation reads no
key and estimates only the first dependency; the remaining dependencies are
estimated against actual preceding deployments by the broadcast command.

```sh
cd /Users/stacc/delta-LP/evm
~/.foundry/bin/forge build
cd /Users/stacc/delta-LP
node --env-file=.env.keeper.local evm/scripts/deploy-members.mjs --version=v4 --split-fees --neutral --operator=0x26E8134eCC3af5cCE32f34B03E7BD2f318B25158
node --env-file=.env.keeper.local evm/scripts/deploy-members.mjs --version=v4 --split-fees --neutral --broadcast
node --env-file=.env.keeper.local evm/scripts/register-neutral-family.mjs --version=v4 --broadcast
```

The existing key file is read only by the operator's broadcast commands.
Deployment journals retain exact transaction hashes and privately saved signed
transactions. Core deployment has a 0.001 ETH gas cap; member registration has
a separate 0.006 ETH cap. Neither command transfers strategy collateral or trades.

After all seven artwork/metadata sets have been published and verified, prepare
the NFT collections against the new receipt and distributor:

```sh
node --env-file=.env.keeper.local nft/prepare-deployment.mjs --version=v4
```

This emits the unsigned deployment/configuration bundle at
`artifacts/nft-deployment/unsigned.json`. Review and submit it from the recorded
operator wallet. It includes one-time `WeightedNftFeeFanout.configure` with the
seven collection addresses, and leaves NFT mints paused. Source/runtime checks
reject v3 as a substitute for the replacement receipt.

Once the replacement stack, all 100 members, and the seven-collection registry
exist on-chain, generate local bindings from verified chain state:

```sh
node --env-file=.env.keeper.local evm/scripts/publish-stack-bindings.mjs --version=v4
npm run check
```

This checks the rates, router/distributor wiring, bytecode hashes, registry,
empty closed vault and member identities. It does not accept placeholder addresses
or turn deposits on. Keep the v3 deployment records for historical verification.
Submit source verification using `verify-members-sourcify.mjs --version=v4`
and `verify-neutral-members.mjs --version=v4`.

The site and keeper must then be rebuilt against those bindings. Before restarting
execution, reconcile the old controller's journal and all operator deployment
transactions. A v3 journal is bound to its controller and must not be reused as a
v4 journal, discarded, or silently reset to bypass an unresolved nonce. Preserve
the old directory and use a separately reviewed v4 state directory only after
that reconciliation. The supplied server RPC is already staged on Fly.

Final activation is an operator action. The keeper opens entries after initial
reports and enabled members; the replacement vault additionally refuses opening
until the seven fee recipients are configured. The 2,000 USDG threshold is the
minimum allocation batch, not a prerequisite for collecting deposits. Receipt
issuance still waits for reconciled positions and actual V4 liquidity.

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
