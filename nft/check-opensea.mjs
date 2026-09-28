// Read-only OpenSea indexing/drop status and on-chain mint gates. Never mints.
import {readFileSync,writeFileSync} from 'node:fs';
import {createPublicClient,http,parseAbi} from 'viem';

const plan=JSON.parse(readFileSync('artifacts/nft-deployment/unsigned.json','utf8'));
if(plan.chainId!==4663||plan.collections.length!==4)throw Error('Expected four Robinhood editions');
const client=createPublicClient({transport:http(process.env.ROBINHOOD_RPC_URL||'https://rpc.mainnet.chain.robinhood.com')});
if(await client.getChainId()!==4663)throw Error('Wrong chain');
const block=await client.getBlock();
const headers={accept:'application/json'};
if(process.env.OPENSEA_API_KEY)headers['x-api-key']=process.env.OPENSEA_API_KEY;
const abi=parseAbi(['function paused() view returns(bool)','function totalMinted() view returns(uint256)','function totalSupply() view returns(uint256)','function ready() view returns(bool)','function balanceOf(address) view returns(uint256)']);
const read=(address,functionName,args=[])=>client.readContract({address,abi,functionName,args,blockNumber:block.number});
const get=async path=>{
 const r=await fetch(`https://api.opensea.io/api/v2/${path}`,{headers,signal:AbortSignal.timeout(20000)});
 return {status:r.status,data:r.ok?await r.json():null};
};
const records=[];
for(const collection of plan.collections){
 const address=collection.address;
 const code=await client.getCode({address,blockNumber:block.number});
 const deployed=!!code&&code!=='0x';
 const lookup=await get(`chain/robinhood/contract/${address}`);
 const data=lookup.data;
 const indexed=lookup.status===200&&data?.chain==='robinhood'&&data.address?.toLowerCase()===address.toLowerCase()&&typeof data.collection==='string'&&data.collection.length>0;
 const record={denomination:collection.denomination,address,deployed,indexed,lookupHttpStatus:lookup.status};
 if(deployed){
  record.paused=await read(address,'paused');
  record.totalMinted=String(await read(address,'totalMinted'));
 }
 if(indexed){
  record.collectionSlug=data.collection;
  record.collectionURL=`https://opensea.io/collection/${encodeURIComponent(data.collection)}`;
  record.contractStandard=data.contract_standard;
  const drop=await get(`drops/${encodeURIComponent(data.collection)}`);
  record.dropLookupHttpStatus=drop.status;
  if(drop.status===200){
   const matches=drop.data?.chain==='robinhood'&&drop.data.contract_address?.toLowerCase()===address.toLowerCase();
   record.dropMatchesContract=matches;
   record.openSeaActiveStage=matches?drop.data.active_stage??null:null;
  }
 }
 records.push(record);
}
const adapterCode=await client.getCode({address:plan.adapter,blockNumber:block.number});
let adapter=null;
if(adapterCode&&adapterCode!=='0x')adapter={address:plan.adapter,paused:await read(plan.adapter,'paused'),ready:await read(plan.adapter,'ready'),receiptInventory:String(await read(plan.dependencies.receipt.address,'balanceOf',[plan.adapter]))};
const report={at:new Date().toISOString(),chainId:4663,block:String(block.number),receiptSupply:String(await read(plan.dependencies.receipt.address,'totalSupply')),adapter,collections:records,note:'Read-only snapshot. OpenSea indexing and an active stage do not prove a mint will succeed; fresh adapter quotes, available inventory and transaction simulation are also required.'};
writeFileSync('artifacts/nft-deployment/opensea-status.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
