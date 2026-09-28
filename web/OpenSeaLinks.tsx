import {ArrowUpRight} from 'lucide-react';
import {nftDeployment} from '../strategy/nft-deployment.ts';
import {nftOpenSeaUrls} from '../strategy/nft-opensea.ts';

/** The four live Money Doubler collections, in mint-tier order, with their verified OpenSea pages. */
export const openSeaCollections=(nftDeployment?.collections??[])
  .map(c=>({denomination:c.denomination,address:c.address,url:nftOpenSeaUrls[c.address.toLowerCase()]}))
  .filter((c):c is typeof c&{url:string}=>Boolean(c.url));

/** Compact header strip: one pill per tier, shown on every page. */
export function OpenSeaNav(){
  if(!openSeaCollections.length)return null;
  return <span className="nav-opensea" aria-label="Money Doubler NFTs on OpenSea"><span>OpenSea</span>{openSeaCollections.map(c=><a key={c.address} href={c.url} target="_blank" rel="noreferrer" title={`$${c.denomination} Money Doubler on OpenSea`}>${c.denomination}</a>)}</span>;
}

/** Hero call to action: mint links for all four tiers. */
export function OpenSeaHero(){
  if(!openSeaCollections.length)return null;
  return <div className="opensea-hero"><span>Mint a Money Doubler on OpenSea</span>{openSeaCollections.map(c=><a key={c.address} href={c.url} target="_blank" rel="noreferrer">${c.denomination} <ArrowUpRight size={14}/></a>)}</div>;
}
