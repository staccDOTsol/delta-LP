import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeFunctionData,zeroAddress} from 'viem';
import {nftSaleSchema,priceForDollars,quoteFloor,quoteSizes,planNftSale} from '../nft/sale-policy.js';
import {mintUnavailable,strategyNative,type NftSaleState,seaDropAbi,SEA_DROP,NFT_FEE_RECIPIENT} from '../strategy/nft-sale.js';
import {nftDeployment} from '../strategy/nft-deployment.js';
import {nftOperation} from '../keeper/nft-sale.js';
import {transactionFor} from '../keeper/execute.js';
import {cloudHealth} from '../keeper/cloud-health.js';

const now=1800000000,rate=2500n*1000000n;
const input={prices:[1,2,5,10].map(n=>String(priceForDollars(n,rate))),startTime:now-60,endTime:now+86400,walletLimit:10000,
  slippageBps:100,referenceRate:String(rate),maxRateDeviationBps:1000};
const policy=nftSaleSchema.parse(input);
function states():NftSaleState[]{return policy.prices.map(mintPrice=>({block:10n,timestamp:now,paused:true,configured:true,totalMinted:0n,mintedBy:0n,
  quoteValidUntil:0,floor:0n,drop:{mintPrice:0n,startTime:0,endTime:0,maxTotalMintableByWallet:0,feeBps:0,restrictFeeRecipients:false},
  adapter:{paused:true,ready:false,floor:0n,cap:0n,validUntil:0}}));}
function configured(){const s=states();s.forEach((x,i)=>x.drop={mintPrice:policy.prices[i],startTime:policy.startTime,endTime:policy.endTime,maxTotalMintableByWallet:10000,feeBps:1000,restrictFeeRecipients:true});return s;}
function quoted(){const s=configured();s.forEach(x=>{x.floor=rate;x.quoteValidUntil=now+600;x.adapter={paused:true,ready:false,floor:rate,cap:10n**18n,validUntil:now+600};});return s;}
function open(){const s=quoted();s.forEach(x=>{x.paused=false;x.adapter.paused=false;x.adapter.ready=true;});return s;}
test('USDG6/ETH18 target prices round up, never through floating point',()=>{
  assert.equal(priceForDollars(1,rate),400000000000000n);
  assert.equal(priceForDollars(10,3_000_000_001n),3333333332222223n);
  assert.throws(()=>priceForDollars(100,rate));assert.throws(()=>priceForDollars(1,0n));
});
test('funding quote uses the worse executable sample and respects reviewed rate range',()=>{
  assert.equal(quoteFloor([{native:10n**18n,usdg:rate},{native:10n**18n,usdg:2490n*1000000n}],policy),2465100000n);
  for(const usdg of [0n,2000n*1000000n,3000n*1000000n])assert.throws(()=>quoteFloor([{native:10n**18n,usdg:rate},{native:10n**18n,usdg}],policy));
  assert.deepEqual(quoteSizes(policy),[356000000000000n,71200000000000000n]);
});
test('sale schema rejects malformed, unsafe and incomplete operator settings',()=>{
  for(const bad of [{...input,prices:['NaN',...input.prices.slice(1)]},{...input,prices:[String(2n**80n),...input.prices.slice(1)]},
    {...input,slippageBps:10000},{...input,referenceRate:'0'},{...input,endTime:input.startTime},{...input,walletLimit:0},{...input,extra:true}])assert.equal(nftSaleSchema.safeParse(bad).success,false);
});
test('sale plans configure, quote, enable adapter, then enable collections in separate confirmed stages',()=>{
  let calls=planNftSale(policy,states(),rate,now);assert.equal(calls.length,4);assert.ok(calls.every(c=>c.name==='updatePublicDrop'));
  calls=planNftSale(policy,configured(),rate,now);assert.equal(calls.length,5);assert.equal(calls[0].name,'setQuote');
  assert.equal(calls[0].args[1],6408n*10n**16n); // 89% of $180k / $2500.
  calls=planNftSale(policy,quoted(),rate,now);assert.deepEqual(calls.map(c=>[c.address,c.name,c.args]),[[nftDeployment!.adapter,'setPaused',[false]]]);
  const s=quoted();s.forEach(x=>{x.adapter.paused=false;x.adapter.ready=true;});
  calls=planNftSale(policy,s,rate,now);assert.equal(calls.length,4);assert.ok(calls.every(c=>c.name==='setPaused'));
  assert.deepEqual(planNftSale(policy,open(),rate,now),[]);
});
test('small price movements do not cause endless quote writes or starve activation',()=>{
  assert.equal(planNftSale(policy,quoted(),rate-1n,now)[0].name,'setPaused');
  assert.deepEqual(planNftSale(policy,open(),rate-1n,now),[]);
});
test('expired quotes refresh and sold-out or ended sales stop refreshing',()=>{
  const s=open();s[0].adapter.validUntil=now+200;
  assert.equal(planNftSale(policy,s,rate,now).length,5);
  s.forEach(x=>x.totalMinted=10000n);assert.deepEqual(planNftSale(policy,s,rate,now),[]);
  assert.deepEqual(planNftSale({...policy,endTime:now},open(),rate,now),[]);
});
test('changing an open or previously minted sale requires explicit owner review',()=>{
  const s=open();s[0].drop.mintPrice++;
  assert.throws(()=>planNftSale(policy,s,rate,now),/review/i);
  s[0].paused=true;s[0].totalMinted=1n;assert.throws(()=>planNftSale(policy,s,rate,now),/review/i);
  s[0].timestamp=now-91;assert.throws(()=>planNftSale(policy,s,rate,now),/Stale/);
});
test('mint gating checks timing, account limit, capacity and freshness independently',()=>{
  const s=open()[0];assert.equal(mintUnavailable(s,1,now),null);
  const variants:NftSaleState[]=[{...s,paused:true},{...s,configured:false},{...s,timestamp:now-91},{...s,timestamp:now+16},
    {...s,totalMinted:10000n},{...s,mintedBy:10000n},{...s,quoteValidUntil:now+20},{...s,adapter:{...s.adapter,cap:0n}},
    {...s,adapter:{...s.adapter,ready:false}},{...s,drop:{...s.drop,startTime:now+1}},{...s,drop:{...s.drop,endTime:now}},
    {...s,drop:{...s.drop,feeBps:1}},{...s,drop:{...s.drop,restrictFeeRecipients:false}}];
  for(const v of variants)assert.ok(mintUnavailable(v,1,now));
  for(const q of [0,21,1.5,NaN])assert.ok(mintUnavailable(s,q,now));
  assert.equal(strategyNative(101n),90n); // Match contract fee rounding exactly.
});
test('executor only encodes known NFT destinations and fixed sale operations with zero value',()=>{
  const calls=planNftSale(policy,states(),rate,now);
  for(const c of calls){const tx=transactionFor(c);assert.equal(tx.to,c.address);assert.equal('value' in tx,false);const decoded=decodeFunctionData({abi:nftOperation(c.address!,c.name),data:tx.data});assert.equal(decoded.functionName,'updatePublicDrop');}
  assert.throws(()=>nftOperation(zeroAddress,'setQuote'));
  assert.throws(()=>nftOperation(nftDeployment!.adapter,'transferOwnership'));
  assert.throws(()=>nftOperation(nftDeployment!.collections[0].address,'setQuote'));
});
test('NFT-only health still requires a fresh observation from this process',()=>{
  const at=now*1000,status={kind:'nft-sale',mode:'execution',at:new Date(at).toISOString(),block:'10',quoteExpiresAt:now+600,
    collections:nftDeployment!.collections.map(c=>({address:c.address,paused:true,minted:'0'}))};
  assert.equal(cloudHealth(status,'execution',at-1,at).ok,true);
  assert.equal(cloudHealth(status,'execution',at+1,at).ok,false);
  assert.equal(cloudHealth(status,'observation',at-1,at).ok,false);
  assert.equal(cloudHealth({...status,collections:[]},'execution',at-1,at).ok,false);
});
