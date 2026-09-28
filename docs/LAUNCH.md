# Robinhood launch and public waitlist

Public site: https://deltalp.fun

Previous site: https://delta-lp.stacc.bio (redirects to the primary domain).

The homepage now includes browser-wallet execution on Lighter's Robinhood domain:
USDG deposits, trading-key authorization, isolated 3×/5×/10× directional orders,
fill/position reconciliation, reduce-only closes, and USDG withdrawal requests.
Orders are signed in the user's browser; the web server has no trading key.
The adapter has unit/transport tests and real offline WASM-signing tests, but a funded
mainnet deposit/open/close/withdraw round trip has **not** been verified. Positions
belong to the user's Lighter account and do not mint deltaLP vault receipts.

The separate delta-neutral LP vault remains closed: LP inventory integration,
asynchronous hedge rebalancing, and combined NAV/receipt accounting are unfinished.
See [execution and recovery details](LIGHTER-ROUTE.md).
The newer [tokenized Lighter member / V4 contracts](TOKENIZED-MEMBERS.md) implement
the 2% mint / 4% redeem fee policy and pool activity checks in an experimental,
undeployed package. They are separate from both the browser's direct-perps flow
and the older NVDA/Morpho vault. No tokenized strategy launch is implied by the site deployment.
The oil-subscription waitlist is at https://deltalp.fun/oil. Email verification, private
passes, ranking, and referral points use the real database. No fuel subscription is sold.
The preserved `platform/` code is a local fuel-operations sandbox with synthetic payments,
supplier orders, and a SQLite ledger.

## Contract

- Chain: Robinhood mainnet, 4663.
- Vault: `0x32C47683D0E41DAc58A750fccb7200ad031D3993`.
- Transaction: `0xd8471efd3c080bcca224b6f6f0285ba17feb18ee272db8e3d02039df86479401`.
- Receipt: `dlpNVDA`, NVDA/USDG, Uniswap v3 and Morpho Blue.
- Deployment state: deposits disabled, zero shares, no funded strategy position.
- Authority/crank: `0x26E8134eCC3af5cCE32f34B03E7BD2f318B25158`.
- [Sourcify source verification](https://sourcify.dev/server/verify-ui/jobs/75b4a38d-eac6-431d-b1de-fbd347660d80): exact match.
- [Public deployment manifest](../evm/deployments/4663.json) includes dependencies,
  constructor parameters, transaction, gas cost, and bytecode hashes.

Both existing NVDA-loan/USDG-collateral markets had zero supply during launch preflight.
No lender supply, user funds, LP position, or live crank was created. Opening deposits
requires available borrowing supply, an operating crank, and a funded pilot decision.
Five mainnet fork tests cover the existing cycle and launch gate. Fork lender liquidity
is supplied by the test fixture, not evidence of live liquidity. This is not an audit.

`depositWithSync` and `withdrawWithSync` refresh NAV in the same transaction. The
authority can close deposits without closing withdrawals. Withdrawals still require
Idle phase, acceptable price deviation, and enough idle quote.

Deployment scripts default to simulation. `DELTA_KEY_FILE` selects a local key file;
the key is read inside the process and never included in arguments or deployment output.
The broadcast script refuses a second deployment when its manifest exists.

## Product interest

The oil waitlist records heating oil, propane, or natural gas and an optional region.
Supplier agreements, geography, pricing, billing, and delivery remain unlaunched.
The storage API retains strategy-preference compatibility from the earlier combined page;
strategy access is no longer presented as an email waitlist.

Preferences submitted with signup are applied only when that email link is verified.
Members can edit preferences with a valid session; changes do not affect points or rank.
The separate sign-in flow preserves saved preferences.

## Waitlist rules

- Signup becomes active only after a single-use, 20-minute email confirmation.
- 100 points for verification; 50 for each new confirmed referral.
- Attribution is fixed at initial signup. Duplicate sign-ins award nothing.
- Points and referral awards have unique database constraints. Verification, credit,
  and session creation commit atomically in Postgres.
- Rank: points descending, initial signup sequence ascending. No fabricated queue sizes.
- Tiers: Waitlist below 250, Priority at 250, Early circle at 600. Tiers do not grant
  vault permissions or guarantee admission, tokens, yield, or an airdrop.
- Gmail/Googlemail dots and plus aliases normalize to one identity. Email verification
  demonstrates control of an address, not a unique human; it is not Sybil-proof.
- Session tokens are hashed in storage and sent through HttpOnly, Secure, SameSite=Lax
  cookies. Public endpoints do not list member emails or referral identities.
- Leaving removes the account and associated referral credit. Login reuses the same email.
- Signup is limited per address and client IP. A daily authenticated cleanup removes
  expired tokens/sessions/rate limits and unverified accounts older than 14 days.

## Infrastructure and operations

- Vercel project `delta-lp`, Node 24, Vite frontend plus an Express serverless API.
- Neon resource `delta-lp-waitlist`; production namespace `delta_waitlist`.
- Resend resource `delta-lp-mail`; verified sender domain `mail.delta-lp.stacc.bio`.
- DNS records are scoped to the new site and mail subdomains; existing apex services remain.
- Production configuration is in Vercel, not this repository. `.env.example` lists names.
- `CRON_SECRET` authenticates the daily maintenance endpoint.

```sh
npm ci
vercel env pull .env.local --yes
npm run db:migrate
npm run dev
npm run build
npm test
npm run test:waitlist
# Opt in with a database URL to execute the isolated Postgres integration suite:
WAITLIST_TEST_DATABASE_URL=... npm test
cd evm && forge test -vv
```

Integration tests create a unique `wl_test_*` schema and remove it afterward; they never
truncate the production waitlist. Resend's documented `delivered+label@resend.dev` addresses
are used for deployment smoke tests, and those exact test entries are removed afterward.

The public function serves `/api/waitlist/*`, read-only `/api/strategies/*`, and health routes. The fuel sandbox APIs are not
part of the public function. Contract source, deployment scripts, local databases,
secrets, and test artifacts are excluded from website upload by `.vercelignore`.

### Verification limits

The integration suite exercises real Postgres with a captured mailer. Production smoke
tests exercise the real Resend API using its delivery simulator, then confirm the links
through the deployed API/browser. This does not measure real-world inbox placement.
Blockscout's verification API was blocked by its edge challenge; Sourcify succeeded.
