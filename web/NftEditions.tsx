import {lazy,Suspense,useState} from 'react';
import {ArrowUpRight} from 'lucide-react';
import {NFT_DENOMINATIONS, type NftDenomination} from '../strategy/nft-editions.ts';
import {nftDeployment} from '../strategy/nft-deployment.ts';
import './nft-editions.css';
const NftMintPanel=lazy(()=>import('./trading/NftMintPanel.tsx').then(m=>({default:m.NftMintPanel})));

const usd = new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4});
const design = 'https://github.com/staccDOTsol/delta-LP/blob/codex/fuel-platform/docs/NFT-EDITIONS.md';

export function NftEditions() {
  const [edition, setEdition] = useState<NftDenomination>(1);
  const collection = nftDeployment?.collections.find(item => item.denomination === edition);
  return <section className="nft-editions" id="nft-editions" aria-labelledby="nft-editions-title">
    <div className="nft-editions-heading">
      <div><span className="wl-kicker">FOUR COLLECTIONS · 10,000 EACH</span><h2 id="nft-editions-title">An NFT with its own portfolio.</h2></div>
      <span className="state-pill">{nftDeployment ? 'Contracts deployed · On-chain mint status below' : 'Mint not open'}</span>
    </div>
    <p className="nft-editions-intro">Minting helps fund the strategy. Each NFT has an ERC-6551 account with a claim on its mint’s USDG contribution. Contributions pool toward the 2,000 USDG activation threshold, then receive actual DN shares after allocation completes. Transfer the NFT and control of its account follows.</p>
    <fieldset className="nft-pricepoints"><legend>Explore a target mint price</legend><div>
      {NFT_DENOMINATIONS.map(value => <button key={value} type="button" aria-pressed={edition === value} onClick={() => setEdition(value)}>${value}</button>)}
    </div></fieldset>
    {collection&&<Suspense fallback={<p role="status">Loading mint controls…</p>}><NftMintPanel collection={collection.address}/></Suspense>}
    <div className="nft-mint-breakdown" aria-live="polite" aria-atomic="true">
      <div className="nft-price-summary"><span>Target mint price</span><strong>${edition}</strong><small>Paid in ETH · 10,000 NFTs in this edition</small></div>
      <dl>
        <div><dt>OpenSea mint fee · 10%</dt><dd>{usd.format(edition * 0.10)}</dd></div>
        <div><dt>Wizards mint fee · 1%</dt><dd>{usd.format(edition * 0.01)}</dd></div>
        <div><dt>Toward pooled USDG funding · 89%</dt><dd>{usd.format(edition * 0.89)}</dd></div>
        <div className="nft-backing"><dt>Illustrative backing after allocation and entry fee</dt><dd>{usd.format(edition * 0.8633)}</dd></div>
      </dl>
    </div>
    <p className="nft-fee-detail">The strategy charges 3% on entry and 6% on exit, split half to Wizards and half to the four NFT collections, weighted 1/2/5/10. Entry fees apply when the pooled funds are allocated. This illustration excludes swap costs and market changes. The mint panel shows the actual ETH price; dollar values can move.</p>
    <div className="nft-ownership-notes"><article><h3>Your NFT controls its contribution</h3><p>Before funds enter allocation, the NFT’s account can withdraw its pending USDG. After activation, that account can claim its proportional DN shares. Paid mint fees are not refunded. Check current holdings and claims before buying an NFT.</p></article><article><h3>Royalties for Wizards</h3><p>A 10% secondary royalty is designated for the 8,010-share Homecoming fanout. Payment depends on marketplace enforcement.</p></article></div>
    <div className="nft-launch-status"><p>All 40,000 launch assets are published and verified. {nftDeployment ? 'The four collection contracts and contribution adapter are deployed on Robinhood Chain. The mint panel reads their current sale status directly.' : 'The mint-funded contracts passed fork tests; NFT deployment and sale setup remain in progress.'} Mint proceeds build the pool, so the creator does not need to seed 2,000 USDG. Pending USDG earns no strategy fees. The $20/$50/$100 editions are saved for later and receive no share of this launch’s fee pool.</p>{collection && <a className="inline-link" href={`https://robin.etherscan.io/address/${collection.address}`} target="_blank" rel="noreferrer">Inspect the ${edition} collection <ArrowUpRight size={15}/></a>}<a className="inline-link" href={design} target="_blank" rel="noreferrer">Ownership, fees & launch status <ArrowUpRight size={15}/></a></div>
  </section>;
}
