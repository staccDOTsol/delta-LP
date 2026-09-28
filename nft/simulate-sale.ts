// Local-fork integration only. No key loading, remote writes, or real funds.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createPublicClient,http,toHex,encodeFunctionData,parseAbi,type Abi,type Address,type Hash} from 'viem';
import {nftDeployment} from '../strategy/nft-deployment.js';
import {nftOwner} from '../strategy/nft-pins.js';
import {readNftSale,SEA_DROP,NFT_FEE_RECIPIENT,seaDropAbi,mintUnavailable} from '../strategy/nft-sale.js';
import {verifyNftSale,executableNftQuote} from '../keeper/nft-sale.js';
import {transactionFor} from '../keeper/execute.js';
import {nftSaleSchema,priceForDollars,quoteFloor,quoteSizes,planNftSale} from './sale-policy.js';

const endpoint=process.env.NFT_SIM_RPC_URL??'http://127.0.0.1:9557',url=new URL(endpoint);
if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port)throw new Error('Explicit loopback Anvil required.');
const rpc=createPublicClient({transport:http(endpoint,{timeout:60000,retryCount:0})});
if(!(await rpc.request({method:'web3_clientVersion'})).toLowerCase().includes('anvil'))throw new Error('Anvil required.');
await verifyNftSale(rpc);
const d=nftDeployment!,alice='0x00000000000000000000000000000000000a11ce',bob='0x0000000000000000000000000000000000000b0b';
const art=(name:string)=>JSON.parse(readFileSync(`evm/out/${name}.sol/${name}.json`,'utf8')).abi as Abi;
const nft=art('DnPendingSeaDropEdition'),adapter=art('DnPendingAdapter'),batchAbi=art('NftContributionBatch');
const vaultAbi=art('NeutralVault'),tokenAbi=parseAbi(['function approve(address,uint256) returns(bool)','function transfer(address,uint256) returns(bool)','function balanceOf(address) view returns(uint256)','function totalSupply() view returns(uint256)']);
const accountAbi=parseAbi(['function execute(address to,uint256 value,bytes data,uint8 operation) payable returns(bytes)']);
const usdg='0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const read=(address:Address,abi:Abi,functionName:string,args:readonly unknown[]=[])=>rpc.readContract({address,abi,functionName,args});
const send=async(from:Address,to:Address,abi:Abi,functionName:string,args:readonly unknown[]=[],value=0n)=>{
  const data=encodeFunctionData({abi,functionName,args});
  const gas=await rpc.estimateGas({account:from,to,data,value});
  const hash=await rpc.request({method:'eth_sendTransaction' as never,params:[{from,to,data,value:toHex(value),gas:toHex(gas*120n/100n)}] as never}) as Hash;
  const receipt=await rpc.waitForTransactionReceipt({hash});assert.equal(receipt.status,'success');return receipt;
};
for(const account of [nftOwner,alice,bob]){
  await rpc.request({method:'anvil_impersonateAccount' as never,params:[account] as never});
  await rpc.request({method:'anvil_setBalance' as never,params:[account,toHex(100n*10n**18n)] as never});
}
const sample=await executableNftQuote(rpc,10n**15n),rate=sample.usdg*10n**18n/sample.native,now=Number((await rpc.getBlock()).timestamp);
const policy=nftSaleSchema.parse({prices:[1,2,5,10].map(n=>String(priceForDollars(n,rate))),startTime:now-1,endTime:now+86400,walletLimit:10000,slippageBps:100,referenceRate:String(rate),maxRateDeviationBps:1000});
const stages=[];
for(let i=0;i<5;i++){
  await rpc.request({method:'anvil_mine' as never,params:['0x21','0x0'] as never});
  const states=[];for(const c of d.collections)states.push(await readNftSale(rpc,c.address));
  const samples=[];for(const amount of quoteSizes(policy))samples.push(await executableNftQuote(rpc,amount));
  const calls=planNftSale(policy,states,quoteFloor(samples,policy),Number((await rpc.getBlock()).timestamp));
  if(!calls.length)break;
  stages.push(calls.map(c=>c.name));
  for(const call of calls){
    const tx=transactionFor(call),gas=await rpc.estimateGas({account:nftOwner,...tx});
    const hash=await rpc.request({method:'eth_sendTransaction' as never,params:[{from:nftOwner,...tx,gas:toHex(gas*120n/100n)}] as never}) as Hash;
    assert.equal((await rpc.waitForTransactionReceipt({hash})).status,'success');
  }
}
await rpc.request({method:'anvil_mine' as never,params:['0x21','0x0'] as never});
const minted=[];
for(let i=0;i<d.collections.length;i++){
  const c=d.collections[i],state=await readNftSale(rpc,c.address,alice);
  assert.equal(mintUnavailable(state,1,Number((await rpc.getBlock()).timestamp)),null);
  const r=await send(alice,SEA_DROP,seaDropAbi,'mintPublic',[c.address,NFT_FEE_RECIPIENT,alice,1n],policy.prices[i]);
  const account=await read(c.address,nft,'accountOf',[1n]) as Address;
  const batch=await read(d.adapter,adapter,'batchOf',[account]) as Address;
  const contribution=await read(batch,batchAbi,'contributions',[account]) as bigint;
  assert.ok(contribution>0n);assert.equal(await read(d.receipt,tokenAbi,'balanceOf',[account]),0n);
  minted.push({denomination:c.denomination,account,batch,contribution:String(contribution),gasUsed:String(r.gasUsed)});
}
assert.equal(new Set(minted.map(m=>m.batch)).size,1);
assert.equal(await read(d.receipt,tokenAbi,'totalSupply'),0n);
// Transfer the $10 NFT; only its new holder can recover the actual contribution.
const final=minted[3];await send(alice,d.collections[3].address,nft,'transferFrom',[alice,bob,1n]);
await assert.rejects(()=>rpc.call({account:alice,to:final.account,data:encodeFunctionData({abi:accountAbi,functionName:'execute',args:[final.batch,0n,encodeFunctionData({abi:batchAbi,functionName:'withdraw'}),0]})}));
await send(bob,final.account,accountAbi,'execute',[final.batch,0n,encodeFunctionData({abi:batchAbi,functionName:'withdraw'}),0]);
assert.equal(await read(usdg,tokenAbi,'balanceOf',[final.account]),BigInt(final.contribution));
await send(bob,final.account,accountAbi,'execute',[usdg,0n,encodeFunctionData({abi:tokenAbi,functionName:'transfer',args:[bob,3_000_000n]}),0]);
// Opening the coordinator gate needs no 2,000 USDG seed or prior minted receipts.
assert.equal(await read(d.receipt,vaultAbi,'pendingAssets'),0n);
await send(nftOwner,d.receipt,vaultAbi,'setEntriesOpen',[true]);
await send(bob,usdg,tokenAbi,'approve',[d.receipt,3_000_000n]);
await send(bob,d.receipt,vaultAbi,'enter',[3_000_000n,2n*10n**18n,bob,BigInt(now+3600)]);
assert.equal(await read(d.receipt,vaultAbi,'pendingAssets'),3_000_000n);
assert.equal(await read(d.receipt,tokenAbi,'totalSupply'),0n);
await send(bob,d.receipt,vaultAbi,'refund',[bob]);
assert.equal(await read(d.receipt,vaultAbi,'pendingAssets'),0n);
assert.equal(await read(usdg,tokenAbi,'balanceOf',[bob]),3_000_000n);
// Actual SeaDrop rejects stale funding; no partial NFT or payment survives.
await rpc.request({method:'evm_increaseTime' as never,params:[601] as never});
await rpc.request({method:'evm_mine' as never,params:[] as never});
await assert.rejects(()=>rpc.call({account:alice,to:SEA_DROP,data:encodeFunctionData({abi:seaDropAbi,functionName:'mintPublic',args:[d.collections[0].address,NFT_FEE_RECIPIENT,alice,1n]}),value:policy.prices[0]}));
assert.equal(await read(d.collections[0].address,nft,'totalMinted'),1n);
const result={at:new Date().toISOString(),mode:'LOCAL FORK ONLY — fake ETH',stages,minted,checks:['all four real SeaDrop mints','pending USDG contribution per NFT','one shared contribution batch','NFT transfer changes cash control','old owner cannot withdraw','3 USDG direct deposit before 2,000 threshold','full pending refund','zero premature DN receipt supply','stale quotes reject mint atomically']};
mkdirSync('artifacts/nft-sale',{recursive:true});writeFileSync('artifacts/nft-sale/simulation.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
