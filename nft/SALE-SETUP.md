# Paid-sale setup for the deployed four editions

The collections and adapter are deployed and paused. Collections are indexed on
OpenSea, but no drop is returned for them. This document and
[`sale-inputs.template.json`](sale-inputs.template.json) are unsigned preparation,
not executable transactions or proof of activation.

## Missing operator values

Fill every null in the template. No financial limits have been selected. Fixed
addresses and fees come from the deployed
[`v6 manifest`](../evm/deployments/4663-nft-v6.json).

| Input | Meaning and bounds |
| --- | --- |
| `publicDrops[].mintPriceWei` | Fixed ETH price per NFT, integer wei, uint80 and at least 100. $1/$2/$5/$10 are price targets, not ETH/USD or redemption pegs. |
| `publicDrops[].startTime` / `endTime` | Unix seconds, uint48, start > 0 and end > start. |
| `publicDrops[].maxTotalMintableByWallet` | Positive uint16 public-drop wallet limit. Supply is 10,000 per edition; a transaction is separately capped at 20 NFTs. |
| `adapterQuote.minimumUSDG6PerETH` | Positive integer lower bound on actual USDG output per 1 ETH, in USDG's six-decimal units. Obtain an executable fixed-pool quote for intended mint sizes, accounting for fees/slippage. This is not a DN-share rate. |
| `adapterQuote.nativeCapWei` | Positive aggregate strategy ETH accepted until refreshed. Counts the 89% strategy portion of incoming mint payments. It is not an operator funding requirement. |
| `adapterQuote.expiresAt` | Unix seconds, strictly after transaction inclusion and at most 900 seconds after inclusion. |
| `collectionQuotes[].minimumUSDG6PerETH` | Positive lower bound on each edition's pending USDG credit, in the same units as the adapter quote. Consistent floors avoid conflicting mint guards. |
| `collectionQuotes[].expiresAt` | Unix seconds, strictly after inclusion and at most 1,800 seconds after inclusion. Both quote gates must remain valid at mint time. |

Represent large integers as decimal strings. Public-drop constants are
`feeBps = 1000` and `restrictFeeRecipients = true`. The allowed OpenSea recipient
is `0x0000a26b00c1F0DF003000390027140000fAa719`.

## Unsigned call sequence

Use the existing owner and sole transaction writer. Configuration calls carry
zero ETH; gas is separate. Recheck chain ID, ownership, code hashes and current
state before constructing/signing transactions.

1. While each edition is paused, call its
   `updatePublicDrop(address seaDropImpl, PublicDrop value)` using SeaDrop
   `0x00005EA00Ac477B1030CE78506496e8C2dE24bf5`. The tuple is
   `(uint80 mintPrice, uint48 startTime, uint48 endTime,
   uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients)`.
2. Immediately before opening, set adapter
   `setQuote(uint256 minimumUsd, uint256 nativeCap, uint48 expiry)` and each
   edition's `setFundingQuote(uint256 minimum, uint48 validUntil)` with fresh,
   reviewed values.
3. Activation is separate: adapter `setPaused(false)`, then each edition
   `setPaused(false)`. Edition activation requires `adapter.ready()` and its own
   valid quote. The SeaDrop schedule must also be active for buyers.

This is four public-drop settings, five quote settings and five activation calls.
Do not encode nulls or expired quotes as executable calldata. ABIs are in
`evm/out/DnPendingAdapter.sol/DnPendingAdapter.json` and
`evm/out/DnPendingSeaDropEditionV2.sol/DnPendingSeaDropEditionV2.json`.

**Quote refresh is still an operational dependency.** Adapter quotes expire
within 15 minutes and can exhaust their cap sooner. Minting fails when either
quote expires or the cap is insufficient. Sustained sales require an
owner-operated refresh process with explicit quote policy and cap limits. The user-run `npm run nft:fly-launch` configures the shared worker for this service. A software deployment alone keeps observation mode; it does not enable paid mints.

## OpenSea publication

Creator operations need wallet-scoped authorization in addition to the public
API key. Use the owner's authenticated Studio session or a scoped wallet token
for drop management. See [OpenSea authentication](https://docs.opensea.io/reference/auth).

Use the four v6 collection addresses from the manifest. Old v5 Studio drafts belong to different contracts and must not be republished for this replacement. Creator payout must be each collection's own address, preserving atomic mint funding.

`DnPendingSeaDropEditionV2` implements Studio's `multiConfigure`, supply events, idempotent payer updates and signed-stage configuration. The actual captured Studio publish payload passes a Robinhood fork regression after rebinding only its collection payout. Public and signed mints retain the same fixed price, 10% OpenSea fee and funding checks. Unsupported allowlist and token-gated stages revert. This test does not itself publish a mainnet drop.

After publication, check [drop details](https://docs.opensea.io/reference/get_drop_by_slug)
for the correct chain/address and schedule, and simulate the actual buyer mint
transaction with its quantity and value. OpenSea's
[primary-drop guide](https://docs.opensea.io/docs/create-a-drop) treats configuring
and publishing a drop as separate steps from contract deployment.

## Funding disclosure and separate DN execution

The mint flow must explain: 10% of gross goes to OpenSea, 1% directly to Wizards,
and 89% becomes pending USDG in a pooled escrow. The NFT's ERC-6551 account
controls its contribution. Its owner can withdraw before the batch queues,
excluding fees already paid. The 2,000 USDG investment threshold is collective;
no creator seed capital is required. Canonical DN shares arise only after actual
investment activation. Subsequent strategy fees and recovery conditions apply.

The production worker is in observation mode and receipt supply is zero in the
verification snapshot. Funded DN execution remains a separate production step.
Do not describe pending cash as active DN shares or promise settlement times or
returns. No mainnet activation, mint or strategy funding is performed here.
