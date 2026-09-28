import {z} from 'zod';
import type {Address} from 'viem';
import {SEA_DROP,strategyNative,type NftSaleState} from '../strategy/nft-sale.js';
import {nftDeployment} from '../strategy/nft-deployment.js';
import type {Call} from '../keeper/model.js';

const integer=z.string().regex(/^[1-9]\d*$/).transform(BigInt);
export const nftSaleSchema=z.object({
  prices:z.tuple([integer,integer,integer,integer]).refine(a=>a.every(x=>x>=100n&&x<2n**80n),'Prices must fit uint80.'),
  startTime:z.number().int().positive().max(2**48-1),endTime:z.number().int().positive().max(2**48-1),
  walletLimit:z.number().int().min(1).max(10000),
  slippageBps:z.number().int().min(1).max(500),
  referenceRate:integer,maxRateDeviationBps:z.number().int().min(1).max(2000),
}).strict().refine(p=>p.endTime>p.startTime,'The sale must end after it starts.');
export type NftSalePolicy=z.infer<typeof nftSaleSchema>;
const WAD=10n**18n;
export function priceForDollars(dollars:number,usdPerEth:bigint){
  if(![1,2,5,10].includes(dollars)||usdPerEth<=0n)throw new Error('Invalid target price or exchange rate.');
  return (BigInt(dollars)*1_000_000n*WAD+usdPerEth-1n)/usdPerEth;
}
export function quoteFloor(samples:{native:bigint;usdg:bigint}[],p:Pick<NftSalePolicy,'slippageBps'|'referenceRate'|'maxRateDeviationBps'>){
  if(samples.length<2||p.slippageBps<1||p.slippageBps>500||p.referenceRate<=0n)throw new Error('Invalid quote policy.');
  const rates=samples.map(s=>{
    if(s.native<=0n||s.usdg<=0n)throw new Error('The pool returned an empty quote.');
    const rate=s.usdg*WAD/s.native;
    const delta=rate>p.referenceRate?rate-p.referenceRate:p.referenceRate-rate;
    if(delta*10000n>p.referenceRate*BigInt(p.maxRateDeviationBps))throw new Error('ETH/USDG moved outside the reviewed sale range; quotes will expire until the owner reviews prices.');
    return rate;
  });
  const minimum=rates.reduce((a,b)=>a<b?a:b)*BigInt(10000-p.slippageBps)/10000n;
  if(minimum===0n)throw new Error('The funding floor rounded to zero.');
  return minimum;
}
export function quoteSizes(p:NftSalePolicy){return [strategyNative(p.prices[0]),strategyNative(p.prices[3]*20n)];}
export function planNftSale(p:NftSalePolicy,states:NftSaleState[],minimum:bigint,now:number):Call[]{
  if(!nftDeployment||states.length!==4||minimum<=0n)throw new Error('Incomplete NFT sale observation.');
  if(states.some(s=>now-s.timestamp>90||s.timestamp>now+15))throw new Error('Stale NFT sale observation.');
  if(now>=p.endTime)return [];
  const call=(address:Address,name:string,args:readonly unknown[],reason:string):Call=>({target:'nft',address,name,args,reason,expiresAt:(now+60)*1000});
  const setup:Call[]=[];
  states.forEach((s,i)=>{
    const drop={mintPrice:p.prices[i],startTime:p.startTime,endTime:p.endTime,maxTotalMintableByWallet:p.walletLimit,feeBps:1000,restrictFeeRecipients:true};
    if(Object.entries(drop).some(([key,value])=>s.drop[key as keyof typeof drop]!==value)){
      if(!s.paused||s.totalMinted!==0n)throw new Error('An existing sale differs from the reviewed settings. Pause and review it explicitly.');
      setup.push(call(nftDeployment!.collections[i].address,'updatePublicDrop',[SEA_DROP,drop],'Configure the reviewed public sale.'));
    }
  });
  if(setup.length)return setup;
  const cap=states.reduce((sum,s,i)=>sum+strategyNative(p.prices[i]*(10000n-s.totalMinted)),0n);
  if(cap===0n)return [];
  const adapter=states[0].adapter,refresh:Call[]=[];
  // Every quote has a bounded lifetime. Capacity never exceeds unsold inventory.
  // A stale/failed quote produces no new signature; existing quotes expire.
  const expiry=Math.min(now+600,p.endTime);
  if(expiry<=now+60)return [];
  const refreshAll=adapter.validUntil<now+300||adapter.cap<quoteSizes(p)[1]&&adapter.cap<cap||states.some(s=>s.quoteValidUntil<now+300);
  if(refreshAll)
    refresh.push(call(nftDeployment.adapter,'setQuote',[minimum,cap,expiry],'Refresh executable funding quote.'));
  states.forEach((s,i)=>{
    if(refreshAll)refresh.push(call(nftDeployment!.collections[i].address,'setFundingQuote',[minimum,expiry],'Refresh collection funding floor.'));
  });
  if(refresh.length)return refresh;
  if(adapter.paused)return [call(nftDeployment.adapter,'setPaused',[false],'Enable reviewed mint funding.')];
  if(!adapter.ready)throw new Error('The deployed funding adapter is not ready.');
  return states.flatMap((s,i)=>s.paused?[call(nftDeployment!.collections[i].address,'setPaused',[false],'Open the reviewed public mint.')]:[]);
}
