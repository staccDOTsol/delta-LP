import {useState} from 'react';
import {ArrowUpRight} from 'lucide-react';
import {NFT_DENOMINATIONS, type NftDenomination} from '../strategy/nft-editions.ts';
import './nft-editions.css';

const usd = new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4});
const design = 'https://github.com/staccDOTsol/delta-LP/blob/codex/fuel-platform/docs/NFT-EDITIONS.md';

export function NftEditions() {
  const [edition, setEdition] = useState<NftDenomination>(1);
  return <section className="nft-editions" id="nft-editions" aria-labelledby="nft-editions-title">
    <div className="nft-editions-heading">
      <div><span className="wl-kicker">SEVEN EDITIONS · 10,000 EACH</span><h2 id="nft-editions-title">An NFT with its own portfolio.</h2></div>
      <span className="state-pill">Mint not open</span>
    </div>
    <p className="nft-editions-intro">Each NFT has an ERC-6551 account that owns its delta-neutral strategy shares. Transfer the NFT and control of that account follows. Seven price points, the same ownership model.</p>
    <fieldset className="nft-pricepoints"><legend>Explore a target mint price</legend><div>
      {NFT_DENOMINATIONS.map(value => <button key={value} type="button" aria-pressed={edition === value} onClick={() => setEdition(value)}>${value}</button>)}
    </div></fieldset>
    <div className="nft-mint-breakdown" aria-live="polite" aria-atomic="true">
      <div className="nft-price-summary"><span>Target mint price</span><strong>${edition}</strong><small>Paid in ETH · 10,000 NFTs in this edition</small></div>
      <dl>
        <div><dt>OpenSea mint fee · 10%</dt><dd>{usd.format(edition * 0.10)}</dd></div>
        <div><dt>Wizards mint fee · 1%</dt><dd>{usd.format(edition * 0.01)}</dd></div>
        <div><dt>Into the DN strategy · 89%</dt><dd>{usd.format(edition * 0.89)}</dd></div>
        <div className="nft-backing"><dt>Illustrative backing after DN entry fee</dt><dd>{usd.format(edition * 0.8722)}</dd></div>
      </dl>
    </div>
    <p className="nft-fee-detail">The strategy’s 2% entry fee also goes to Wizards. Backing shown is before swap costs and market changes. ETH mint prices will be quoted before launch; dollar values can move.</p>
    <div className="nft-ownership-notes"><article><h3>The NFT controls the assets</h3><p>DN shares belong to the NFT’s account. Its owner can manage or withdraw them, so account holdings must be checked before buying an NFT.</p></article><article><h3>Royalties for Wizards</h3><p>A 10% secondary royalty is designated for the 8,010-share Homecoming fanout. Payment depends on marketplace enforcement.</p></article></div>
    <div className="nft-launch-status"><p>Mint integration is in testing. Opening the editions requires the production DN funding adapter, final artwork, and OpenSea setup.</p><a className="inline-link" href={design} target="_blank" rel="noreferrer">Ownership, fees & launch status <ArrowUpRight size={15}/></a></div>
  </section>;
}
