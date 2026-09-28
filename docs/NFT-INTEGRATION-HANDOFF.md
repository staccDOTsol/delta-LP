# NFT launch handoff — September 28, 2026

The four confirmed editions ($1/$2/$5/$10, 10,000 NFTs each) are deployed on
Robinhood Chain 4663 and indexed on OpenSea. All four collections and their
pending-funding adapter have matching creation and runtime source on Sourcify.
All remain paused with zero mints. OpenSea's drop endpoint returns 404 for each
collection: collection indexing is complete, paid-drop publication is not.
Etherscan accepted the five source submissions and still reports them queued.

The public snapshot is
[`4663-nft-v5-verification.json`](../evm/deployments/4663-nft-v5-verification.json).
It records observation times, source results, collection links and launch gates.
Source verification establishes a code match, not an audit or a successful
funded mainnet lifecycle.

| Edition | Deployed collection | OpenSea |
| --- | --- | --- |
| $1 | `0xa8dC97388FD0919A654bc05E21034afaafd1FF43` | [Money Doubler $1](https://opensea.io/collection/money-doubler-1) |
| $2 | `0x95fc6306d95F8264Ad6cc5336FB8df7e58BCbb7A` | [Money Doubler $2](https://opensea.io/collection/money-doubler-2) |
| $5 | `0xA09255F0D9cF94475369A962B3Df6Fd7ac926761` | [Money Doubler $5](https://opensea.io/collection/money-doubler-5) |
| $10 | `0xDa66c3e243D15813E6810c0370823A67b1497672` | [Money Doubler $10](https://opensea.io/collection/money-doubler-10) |

Adapter: `0x7518E5121A2841568dDE5A81eec8C962EcfCc0C5`.
Canonical v5 vault: `0x3D4Ee6D147AF67371073e74206D6d49e64960f9c`.
Four-edition fanout: `0x5D38705D0c40c814CF2Eeb67d9ECD885cd9708FC`.
The permanent registry is configured, its initializer erased, tokenCount 40,000
and totalWeight 180,000. Higher tiers are excluded from this registry.

## Assets and deployment evidence

All 40,000 launch image/metadata pairs are published. Every public metadata body
was fetched and hash-checked; every PNG was checked for type/size; eleven full
PNG downloads per edition were hash-checked. Local PNGs passed CRC/decompression
and source-hash checks. Original art and higher editions remain unchanged.
The public catalog is [`public/nft-editions.json`](../public/nft-editions.json).
Versioned Blob hosting depends on the hosting account remaining available.

All 30 deployment/configuration transactions succeeded. The manifest is
[`4663-nft-v5.json`](../evm/deployments/4663-nft-v5.json), pinned to plan hash
`0x6039e4dcdf61f194a666ab7300fd643eb5f09ef20e9092fd45891967da725d96`.
Deployment used 0.000395971166982 ETH in gas. The old inventory-backed bundle
was never broadcast and remains explicitly superseded.

Before deployment, all 30 calls passed the isolated fork simulation. A separate
exact-address smoke test used canonical SeaDrop and the real ETH/USDG pool to
mint two editions with zero DN supply, pool USDG, transfer an NFT and withdraw
only that NFT's pending cash through its new owner's ERC-6551 account. These
were local-fork transactions, not mainnet mints or venue trades. The pending
adapter/edition suite passed 13 tests; the deployment task reports the complete
128-test Solidity suite passing. Batch tests cover refunds, timeout recovery,
one-payer aggregation and bounded in-kind recovery.

## Funding and ownership

There is no creator-funded 2,000 USDG reserve. Actual mint proceeds are converted
to USDG and credited in `NftContributionBatch` to claims controlled by each NFT's
fixed ERC-6551 account. Initial backing is pending cash. Before queueing, that
account can withdraw its own contribution; primary sale fees are not refunded.
Transferring the NFT transfers control of the account and its unclaimed rights.

The 2,000 USDG threshold applies collectively to queued strategy investment.
One escrow is one vault payer/receiver, avoiding the 32-depositor epoch limit.
Fresh mints can collect in another escrow while the previous one settles.
Canonical receipts can be claimed to the fixed accounts only after actual vault
activation. Cash refunds and in-kind recovery are separate outcomes, including
24-hour timeout recovery and paginated member claims. The adapter creates no
substitute receipt token. `contributedAssets(account)` becomes historical weight
after settlement; UI holdings must also inspect batch state and claimed assets.

Primary split: 10% OpenSea / 1% direct Wizards / 89% pending strategy cash.
Strategy entry/exit fees are 3%/6%, split 50/50 between Wizards and the fixed NFT
pool. The later entry fee is charged when invested. Secondary royalty is 10%
to the direct Wizards router; ERC-2981 does not force every marketplace to pay it.
Ordinary member-token transfers are untaxed.

## Exact remaining work

[`nft/sale-inputs.template.json`](../nft/sale-inputs.template.json) lists the
unsigned inputs without selecting financial limits. The accompanying
[`sale setup instructions`](../nft/SALE-SETUP.md) identify the contract methods,
argument units and order. No private key or broadcast operation is included.

The missing operator values are four fixed mint prices in wei; each edition's
start/end timestamps and wallet mint limit; executable lower-bound USDG6/ETH
swap quotes; an aggregate incoming strategy-ETH cap; and fresh quote expiries.
The cap limits mint proceeds accepted during a quote window, not an upfront
operator payment. Quotes must be refreshed while the sale operates: the adapter
allows at most 15 minutes and the collections at most 30 minutes. The deployed
observer does not provide an active NFT quote refresh service.

OpenSea still needs creator-authorized drop configuration/publication. The
existing public API key proves indexing only. Review the publish transaction
against this custom collection's ABI: it supports individual SeaDrop setters,
but does not implement `multiConfigure`. Generic Studio publish compatibility
has not been demonstrated. After configuration, verify matching drop details
and simulate the actual buyer mint route before advertising it as available.

Funded DN execution remains a distinct launch dependency. The production worker
is in observation mode; zero receipt supply is not evidence of invested backing.
Opening cash collection must disclose the pending state and available refunds.
No operator activation, quote refresh, funded strategy execution or mainnet paid
mint was performed by this NFT verification task.

See also [the runbook](../nft/README.md) and
[the fixed fanout interface](NFT-FANOUT-INTERFACE.md).
