# Weighted NFT fanout integration

The confirmed launch is $1/$2/$5/$10: 40,000 NFTs, totalWeight180000.
$20/$50/$100 are excluded from this immutable pool and retained only for a possible
later release. All four launch asset sets are published and verified. Their
catalog and provenance URLs are in `public/nft-editions.json`.

The four-recipient fanout is deployed at
`0x5D38705D0c40c814CF2Eeb67d9ECD885cd9708FC` on Robinhood Chain4663. It remains
unconfigured. ZERO NFT calls were broadcast before the launch flow correction.
The 13 four-edition fanout tests pass; root also ran the original complete
four-edition suite (102 Solidity /153 application passing,17 environment skips).

## Pending contribution launch

The user explicitly confirmed that NFT sales contribute toward the collective
DN batch threshold. There is no 2,000 USDG upfront requirement for the creator.
The initial inventory-backed NFT bundle was wrong for that bootstrap and is
marked superseded in `artifacts/nft-deployment/superseded-inventory/`.

The new path is `DnPendingSeaDropEdition` + `DnPendingAdapter` +
`NftContributionBatch`. Real mint proceeds become pending USDG claims owned by
fixed NFT accounts. Receipt claims arise only from actual vault activation.
The adapter/collection's 13 fork tests pass with zero existing DN supply. Root
owns the batch's settlement/recovery tests and corrected fee-aware vault.

`nft/prepare-deployment.mjs` requires explicit pending-contribution mode, the
final receipt address/hash,3%/6% fees,a bounded1% post-fee execution-loss check,
and exactly these four fee recipients. The new actual-target plan and complete
fork simulation must pass before the sole deployment writer broadcasts it.
No historical inventory-plan simulation validates this new code.

Source verification compares live runtime with the tested plan. Marketplace
indexing is checked independently with `nft/check-opensea.mjs`; deployment alone
is not proof of indexing, a sale opening, or invested DN funds.

## Exact interface

```solidity
constructor(address initializer);
function configure(address[4] calldata editions) external;
function configured() external view returns (bool);
function initializer() external view returns (address);
function tokenCount() external view returns (uint256); // 40000
function totalWeight() external view returns (uint256); // 180000
function collections(uint256 index) external view returns (address);
function weight(uint8 index) external pure returns (uint256);
function harvest(address token) external;
function claimable(address token, uint8 collectionIndex, uint256 id)
    external view returns (uint256);
function claim(address token, uint8[] calldata collectionIndices,
    uint256[] calldata ids) external;
function claimed(address token, uint8 collectionIndex, uint256 id)
    external view returns (uint256);
function distributions(address token) external view returns
    (uint256 received, uint256 paid, uint256 accountedBalance);
```

Registration order is $1, $2, $5, $10. Registration is one-time,
checks deployed code, ERC-721 support, the exact `denominationUsd()` and
`MAX_SUPPLY() == 10000`, rejects duplicate addresses, then erases initialization
authority. The array is never replaceable. No withdrawal, recipient redirect,
asset sweep or administrator entitlement exists.

The pending-funding `DnPendingSeaDropEdition` exposes the required methods. Token IDs
are sequential 1–10000. **No mint-registration hook is needed** under the fixed
full-collection entitlement policy requested by root. A mint checkpoint design
was considered before root specified that unminted entitlements are reserved;
that is not the implemented policy.

## Entitlement and rounding policy

Every valid ID has its fixed denomination weight even before it is minted. The
full denominator is 10000 * (1+2+5+10) = 180,000. Revenue reserved for
an unminted ID remains in the distributor. That entitlement becomes claimable
after minting; this intentionally gives later minters access to their ID's share
of earlier fees. A never-minted or unowned/burned ID's reserve cannot be swept.

A claim batch accepts at most 50 index/ID pairs. The caller must be the current
`ownerOf` for every item; proceeds go only to the caller. Transfers carry unclaimed
entitlement to the new owner, while already-paid history stays with the ID.
A duplicate ID in a batch contributes zero after its first entry.

Whole-unit cumulative entitlement is exactly
`floor(totalReceived[token] * denomination / 180000) - previouslyClaimed`.
It is computed with overflow-safe `mulDiv`, without truncating each harvest.
Fractional entitlement is retained implicitly across future receipts/claims.
Every ERC-20 has a separate ledger. `claimable` includes donations not yet
harvested and also exposes the reserved entitlement of valid unminted IDs;
claiming still requires an actual current NFT owner.

`harvest(token)` measures the actual balance increase. Claims update accounting
before transfer and reject reentrancy, sender surcharges, negative rebases, and
fee-on-transfer payouts by checking both final balances. Use standard WETH/USDG;
rebasing or callback tokens are not promised support. Native ETH must be wrapped
by the router before transfer. The router must check `configured()` before
routing and may call `harvest()` after sending the NFT portion.

## Fee separation and deployment order

Root reports the user's revised deltaLP 3% entry / 6% exit policy and 50/50 house
split. Existing live v3 remains 2%/4% all-Wizards on the old deployment; v4 uses the revised fees.

The existing primary NFT 10% OpenSea / 1% Wizards / 89% DN split remains separate.
At 3% DN entry, illustrative backing is 86.33% of gross before conversion/execution
costs. The 2.67% DN entry portion is split 1.335% each to Wizards and the NFT pool.
The explicitly all-Wizards primary 1% and secondary 10% must keep using a direct
Wizards router; passing them through the split house router would change policy.

1. Deploy the unconfigured distributor with the operator as initializer.
2. Deploy the replacement fee/controller/receipt stack and the pending-contribution adapter.
3. Deploy four paused editions with the pending-contribution adapter and direct Wizards
   router; publish their metadata and provenance.
4. Configure this distributor once with those four exact addresses.
5. Verify source, destinations, fee rates, pending-cash funding, recovery and readiness before
   any funding or opening of sales.

The collection constructor does not reference the new distributor, so registration
avoids a circular CREATE2 dependency. The pending adapter binds `(owner, NeutralVault vault, expectedVaultHash)`.
It issues no receipt tokens and requires no seed inventory; mint proceeds are
credited as actual USDG in batch escrows. The bound vault charges its entry fee
when those contributions are eventually invested.
