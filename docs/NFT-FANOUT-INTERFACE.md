# Weighted NFT fanout integration

Updated September 28, 2026. Implementation:
`evm/src/tokenized/WeightedNftFeeFanout.sol`. Implementation and 13 unit/fuzz tests pass locally; it is not yet
deployed. Root owns the split router and controller, and this task owns the
weighted fanout, its tests, asset publication, NFT adapter and collection tooling.

## Validation and deployment-tool update

As of 08:17 UTC, 13 fanout tests pass, including a complete 50-NFT claim,
wrong-owner atomic rollback, uint256-max units, cumulative rounding and a 256-run
asset-conservation fuzz test. Log: `/tmp/delta-weighted-fanout-tests.log`.

The previously reported adapter constructor-test failure is fixed. Its actual
cause was unavailable historical RPC state at block 74635064 while deploying a
new test address. Tests now fork current state and wrap failing constructors in
an external call. All 12 adapter tests pass in
`/tmp/delta-nft-final-components.log` (23 combined before adding two fanout tests).
No adapter production behavior was loosened to make the test pass.

`nft/prepare-deployment.mjs` accepts `--version=v4` with
`evm/deployments/4663-tokenized-v4.json` or `--target=path` with
`{chainId, receipt: {address,runtimeCodeHash}, weightedFanout: {address,runtimeCodeHash}}`.
Versioned manifests must identify `controllerName: SplitFeeMemberController` and
have `steps.NeutralVault` plus `steps.WeightedNftFeeFanout`. The builder verifies
3%/6%, the controller's split-router fanout, exact runtime hashes, and initializer
ownership; it includes `fanout.configure()` after all seven edition deployments.
No old v3 default is silently used. It requires all seven asset sets to complete.

`nft/simulate-deployment.mjs` runs the resulting zero-value deployment/configuration
bundle only on a loopback Anvil fork, checking pauses, cap, receipt fee rate,
metadata/provenance and finalized registry order. It cannot submit to mainnet.

## Exact interface

```solidity
constructor(address initializer);
function configure(address[7] calldata editions) external;
function configured() external view returns (bool);
function initializer() external view returns (address);
function tokenCount() external view returns (uint256); // 70000
function totalWeight() external view returns (uint256); // 1880000
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

Registration order is $1, $2, $5, $10, $20, $50, $100. Registration is one-time,
checks deployed code, ERC-721 support, the exact `denominationUsd()` and
`MAX_SUPPLY() == 10000`, rejects duplicate addresses, then erases initialization
authority. The array is never replaceable. No withdrawal, recipient redirect,
asset sweep or administrator entitlement exists.

The existing `DnSeaDropEdition` already exposes the required methods. Token IDs
are sequential 1–10000. **No mint-registration hook is needed** under the fixed
full-collection entitlement policy requested by root. A mint checkpoint design
was considered before root specified that unminted entitlements are reserved;
that is not the implemented policy.

## Entitlement and rounding policy

Every valid ID has its fixed denomination weight even before it is minted. The
full denominator is 10000 * (1+2+5+10+20+50+100) = 1,880,000. Revenue reserved for
an unminted ID remains in the distributor. That entitlement becomes claimable
after minting; this intentionally gives later minters access to their ID's share
of earlier fees. A never-minted or unowned/burned ID's reserve cannot be swept.

A claim batch accepts at most 50 index/ID pairs. The caller must be the current
`ownerOf` for every item; proceeds go only to the caller. Transfers carry unclaimed
entitlement to the new owner, while already-paid history stays with the ID.
A duplicate ID in a batch contributes zero after its first entry.

Whole-unit cumulative entitlement is exactly
`floor(totalReceived[token] * denomination / 1880000) - previouslyClaimed`.
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
split. Existing live v3 remains 2%/4% all-Wizards until replacement deployment.

The existing primary NFT 10% OpenSea / 1% Wizards / 89% DN split remains separate.
At 3% DN entry, illustrative backing is 86.33% of gross before conversion/execution
costs. The 2.67% DN entry portion is split 1.335% each to Wizards and the NFT pool.
The explicitly all-Wizards primary 1% and secondary 10% must keep using a direct
Wizards router; passing them through the split house router would change policy.

1. Deploy the unconfigured distributor with the operator as initializer.
2. Deploy the replacement fee/controller/receipt stack and the inventory adapter.
3. Deploy seven paused editions with the inventory adapter and direct Wizards
   router; publish their metadata and provenance.
4. Configure this distributor once with those seven exact addresses.
5. Verify source, destinations, fee rates, real inventory and readiness before
   any funding or opening of sales.

The collection constructor does not reference the new distributor, so registration
avoids a circular CREATE2 dependency. The inventory adapter binds
`(owner, NeutralVault vault, expectedVaultHash)` and reads the selected controller's
actual entry rate; it cannot change an existing vault's economics.
