// Execute the complete unsigned software plan on a LOCAL Anvil fork only.
import {readFileSync,writeFileSync} from 'node:fs';
import {createPublicClient,http,toHex,keccak256} from 'viem';
const endpoint=process.env.NFT_SIM_RPC_URL||'http://127.0.0.1:9557';
const url=new URL(endpoint);
if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.port==='')throw Error('Only an explicit loopback Anvil port is allowed');
const client=createPublicClient({transport:http(endpoint)});
const version=await client.request({method:'web3_clientVersion'});
if(!version.toLowerCase().includes('anvil')||await client.getChainId()!==4663)throw Error('Expected a local Robinhood Anvil fork');
const plan=JSON.parse(readFileSync('artifacts/nft-deployment/unsigned.json','utf8'));
if(plan.chainId!==4663||plan.status!=='unsigned-paused-deployment')throw Error('Unexpected plan');
for(const [name,dependency] of Object.entries(plan.dependencies)){
 const code=await client.getCode({address:dependency.address});
 if(!code||keccak256(code)!==dependency.runtimeCodeHash)throw Error(`Fork dependency mismatch: ${name}`);
}
await client.request({method:'anvil_impersonateAccount',params:[plan.owner]});
await client.request({method:'anvil_setBalance',params:[plan.owner,toHex(100n*10n**18n)]});
const receipts=[];
for(const call of plan.calls){
 if(call.value!=='0')throw Error('Only empty software deployment/configuration permitted');
 const gas=await client.estimateGas({account:plan.owner,to:call.to,data:call.data,value:0n});
 const hash=await client.request({method:'eth_sendTransaction',params:[{from:plan.owner,to:call.to,data:call.data,value:'0x0',gas:toHex(gas*120n/100n)}]});
 const receipt=await client.waitForTransactionReceipt({hash,timeout:30000});
 if(receipt.status!=='success')throw Error(`Simulation reverted: ${call.label}`);
 receipts.push({label:call.label,gasUsed:String(receipt.gasUsed)});
}
const artifact=name=>JSON.parse(readFileSync(`evm/out/${name}.sol/${name}.json`,'utf8'));
const read=(name,address,functionName,args=[])=>client.readContract({address,abi:artifact(name).abi,functionName,args});
if(await read('DnInventoryAdapter',plan.adapter,'ENTRY_BPS')!==300n||!await read('DnInventoryAdapter',plan.adapter,'paused'))throw Error('Adapter fee/pause mismatch');
for(const collection of plan.collections){
 const check=fn=>read('DnSeaDropEdition',collection.address,fn);
 if(!await check('configured')||!await check('paused')||await check('totalMinted')!==0n||await check('MAX_SUPPLY')!==10000n
    ||Number(await check('denominationUsd'))!==collection.denomination||await check('baseURI')!==collection.baseURI
    ||await check('contractURI')!==collection.contractURI||await check('provenanceHash')!==collection.provenanceHash)throw Error('Collection configuration mismatch');
}
const fanout=plan.dependencies.weightedFanout.address;
if(!await read('WeightedNftFeeFanout',fanout,'configured')||await read('WeightedNftFeeFanout',fanout,'initializer')!=='0x0000000000000000000000000000000000000000')throw Error('Fanout not finalized');
for(let i=0;i<7;i++)if((await read('WeightedNftFeeFanout',fanout,'collections',[BigInt(i)])).toLowerCase()!==plan.collections[i].address.toLowerCase())throw Error('Fanout collection ordering mismatch');
await client.request({method:'anvil_stopImpersonatingAccount',params:[plan.owner]});
writeFileSync('artifacts/nft-deployment/fork-simulation.json',JSON.stringify({status:'local-fork-simulation-only',at:new Date().toISOString(),planHash:keccak256(toHex(readFileSync('artifacts/nft-deployment/unsigned.json','utf8'))),receipts},null,2));
console.log(JSON.stringify({status:'local-fork-simulation-passed',calls:receipts.length,totalGas:String(receipts.reduce((n,r)=>n+BigInt(r.gasUsed),0n)),collections:7,paused:true}));
