// Complete first-mint smoke test against the deployed plan on LOCAL Anvil only.
// Every balance below is fake fork ETH. Never uses a private key or live RPC.
import {readFileSync,writeFileSync} from 'node:fs';
import {createPublicClient,http,toHex,encodeFunctionData,parseAbi,keccak256} from 'viem';
const endpoint=process.env.NFT_SIM_RPC_URL||'http://127.0.0.1:9557';
const url=new URL(endpoint);
if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port)throw Error('Explicit loopback Anvil required');
const rpc=createPublicClient({transport:http(endpoint)});
if(!(await rpc.request({method:'web3_clientVersion'})).toLowerCase().includes('anvil')||await rpc.getChainId()!==4663)throw Error('Wrong local fork');
const planDir=process.argv.find(x=>x.startsWith('--plan-dir='))?.slice(11)||'artifacts/nft-deployment';
const planText=readFileSync(`${planDir}/unsigned.json`,'utf8');
const plan=JSON.parse(planText);
const simulation=JSON.parse(readFileSync(`${planDir}/fork-simulation.json`));
const planHash=keccak256(toHex(planText));
if(plan.launchMode!=='pending-contribution'||simulation.planHash!==planHash)throw Error('Untested pending plan');
const art=name=>JSON.parse(readFileSync(`evm/out/${name}.sol/${name}.json`));
for(const deployment of plan.deployments){
 const code=await rpc.getCode({address:deployment.address});
 if(!code||keccak256(code)!==simulation.runtimeHashes[deployment.address.toLowerCase()])throw Error('Fork deployment mismatch');
}
const alice='0x00000000000000000000000000000000000a11ce';
const bob='0x0000000000000000000000000000000000000b0b';
const sea=plan.dependencies.seaDrop.address;
const feeRecipient='0x0000a26b00c1F0DF003000390027140000fAa719';
const nftAbi=art(plan.editionContract??'DnPendingSeaDropEdition').abi;
const adapterAbi=art('DnPendingAdapter').abi;
const batchAbi=art('NftContributionBatch').abi;
const erc20=parseAbi(['function totalSupply() view returns(uint256)','function balanceOf(address) view returns(uint256)']);
const read=(address,abi,functionName,args=[])=>rpc.readContract({address,abi,functionName,args});
const assert=(condition,message)=>{if(!condition)throw Error(message)};
const send=async (from,to,abi,functionName,args=[],value=0n)=>{
 const data=encodeFunctionData({abi,functionName,args});
 const gas=await rpc.estimateGas({account:from,to,data,value});
 const hash=await rpc.request({method:'eth_sendTransaction',params:[{from,to,data,value:toHex(value),gas:toHex(gas*120n/100n)}]});
 const r=await rpc.waitForTransactionReceipt({hash,timeout:30000});
 assert(r.status==='success',`Local simulation failed: ${functionName}`);
 return r;
};
for(const account of [plan.owner,alice,bob]){
 await rpc.request({method:'anvil_impersonateAccount',params:[account]});
 await rpc.request({method:'anvil_setBalance',params:[account,toHex(100n*10n**18n)]});
}
const vault=plan.dependencies.receipt.address;
const usdg=plan.dependencies.usdg.address;
assert(await read(vault,erc20,'totalSupply')===0n,'Expected a zero-supply genesis test');
const now=(await rpc.getBlock()).timestamp;
await send(plan.owner,plan.adapter,adapterAbi,'setQuote',[2000n*10n**6n,10n**18n,now+600n]);
await send(plan.owner,plan.adapter,adapterAbi,'setPaused',[false]);
const minted=[];
const seaAbi=parseAbi(['function mintPublic(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity) payable']);
for(const collection of plan.collections){
 const price=400000000000000n*BigInt(collection.denomination);
 await send(plan.owner,collection.address,nftAbi,'setFundingQuote',[2000n*10n**6n,now+600n]);
 await send(plan.owner,collection.address,nftAbi,'updatePublicDrop',[sea,{mintPrice:price,startTime:now-1n,endTime:now+3600n,maxTotalMintableByWallet:20,feeBps:1000,restrictFeeRecipients:true}]);
 await send(plan.owner,collection.address,nftAbi,'setPaused',[false]);
 const mint=await send(alice,sea,seaAbi,'mintPublic',[collection.address,feeRecipient,alice,1n],price);
 const account=await read(collection.address,nftAbi,'accountOf',[1n]);
 const batch=await read(plan.adapter,adapterAbi,'batchOf',[account]);
 const contribution=await read(batch,batchAbi,'contributions',[account]);
 assert(contribution>0n,'Missing actual USDG contribution');
 assert(await read(vault,erc20,'balanceOf',[account])===0n,'Pending cash mislabeled as DN shares');
 minted.push({denomination:collection.denomination,address:collection.address,account,batch,contribution:String(contribution),gasUsed:String(mint.gasUsed)});
}
assert(minted.every(m=>m.batch.toLowerCase()===minted[0].batch.toLowerCase()),'Editions did not pool in one collecting batch');
const total=minted.reduce((n,x)=>n+BigInt(x.contribution),0n);
assert(await read(usdg,erc20,'balanceOf',[minted[0].batch])===total,'Escrow cash/credit mismatch');
assert(await read(vault,erc20,'totalSupply')===0n,'Genesis smoke unexpectedly issued DN shares');
assert(await read(usdg,erc20,'balanceOf',[plan.adapter])===0n,'Adapter stranded mint cash');
const first=minted[0];
await send(alice,first.address,nftAbi,'transferFrom',[alice,bob,1n]);
const accountAbi=parseAbi(['function execute(address to,uint256 value,bytes data,uint8 operation) payable returns(bytes)']);
await send(bob,first.account,accountAbi,'execute',[first.batch,0n,encodeFunctionData({abi:batchAbi,functionName:'withdraw'}),0]);
assert(await read(usdg,erc20,'balanceOf',[first.account])===BigInt(first.contribution),'New NFT owner did not receive pending cash into its account');
assert(await read(first.batch,batchAbi,'contributions',[first.account])===0n,'Withdrawn credit not cleared');
for(const account of [plan.owner,alice,bob])await rpc.request({method:'anvil_stopImpersonatingAccount',params:[account]});
const result={status:'LOCAL-FORK-ONLY: first mint without seed passed',at:new Date().toISOString(),planHash,minted,receiptSupply:'0',pendingWithdrawalAfterNftTransfer:'passed'};
writeFileSync(`${planDir}/pending-mint-simulation.json`,JSON.stringify(result,null,2));
console.log(JSON.stringify(result));
