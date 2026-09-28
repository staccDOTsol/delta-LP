// Read-only chain checks plus public source-verification submission. No signer.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {createPublicClient,http,keccak256,toHex} from 'viem';
const plan=JSON.parse(readFileSync('artifacts/nft-deployment/unsigned.json','utf8'));
const simulation=JSON.parse(readFileSync('artifacts/nft-deployment/fork-simulation.json','utf8'));
if(simulation.planHash!==keccak256(toHex(readFileSync('artifacts/nft-deployment/unsigned.json','utf8'))))throw Error('Plan changed after fork simulation');
const client=createPublicClient({transport:http(process.env.ROBINHOOD_RPC_URL||'https://rpc.mainnet.chain.robinhood.com')});
if(await client.getChainId()!==4663)throw Error('Wrong chain');
const block=await client.getBlock();
const recordPath='artifacts/nft-deployment/verification.json';
const record=existsSync(recordPath)?JSON.parse(readFileSync(recordPath,'utf8')):{};
const transactionPath=process.argv.find(x=>x.startsWith('--transactions='))?.slice(15)||'artifacts/nft-deployment/transactions.json';
const transactions=existsSync(transactionPath)?JSON.parse(readFileSync(transactionPath,'utf8')):{};
const artifact=name=>JSON.parse(readFileSync(`evm/out/${name}.sol/${name}.json`,'utf8'));
const read=(name,address,functionName,args=[])=>client.readContract({address,abi:artifact(name).abi,functionName,args,blockNumber:block.number});
const equalAddress=(a,b)=>a.toLowerCase()===b.toLowerCase();
for(const entry of plan.deployments){
 const code=await client.getCode({address:entry.address,blockNumber:block.number});
 if(!code||keccak256(code)!==simulation.runtimeHashes[entry.address.toLowerCase()])throw Error(`${entry.label}: deployed bytecode does not match the tested fork`);
 if(!equalAddress(await read(entry.contract,entry.address,'owner'),plan.owner))throw Error('Owner mismatch');
 if(entry.contract==='DnSeaDropEdition'){
  const config=plan.collections.find(c=>equalAddress(c.address,entry.address));
  if(!await read(entry.contract,entry.address,'configured')||!equalAddress(await read(entry.contract,entry.address,'adapter'),plan.adapter)
      ||!equalAddress(await read(entry.contract,entry.address,'receipt'),plan.dependencies.receipt.address)
      ||!equalAddress(await read(entry.contract,entry.address,'houseFees'),plan.dependencies.houseFees.address)
      ||await read(entry.contract,entry.address,'baseURI')!==config.baseURI||await read(entry.contract,entry.address,'contractURI')!==config.contractURI
      ||await read(entry.contract,entry.address,'provenanceHash')!==config.provenanceHash)throw Error('Collection binding mismatch');
 }
 record[entry.label]={...record[entry.label],address:entry.address,runtimeCodeHash:keccak256(code),checkedBlock:String(block.number)};
 const endpoint=`https://sourcify.dev/server/v2/contract/4663/${entry.address}`;
 const lookup=await fetch(endpoint,{signal:AbortSignal.timeout(30000)});
 if(lookup.ok){
  const match=await lookup.json();
  if(match.creationMatch==='match'&&match.runtimeMatch==='match'){
   Object.assign(record[entry.label],{source:'verified',creationMatch:match.creationMatch,runtimeMatch:match.runtimeMatch});
   writeFileSync(recordPath,JSON.stringify(record,null,2));console.log(`${entry.label}: bytecode, configuration and source matched`);continue;
  }
 }else if(lookup.status!==404)throw Error(`Sourcify lookup HTTP ${lookup.status}`);
 if(!record[entry.label].verificationId){
  // Use actual broadcast receipts; the explorer API may be challenge-blocked.
  const tx=transactions[entry.address.toLowerCase()]||transactions[entry.address];
  if(!/^0x[0-9a-fA-F]{64}$/.test(tx||''))throw Error('Provide the actual creation transaction hash keyed by contract address through --transactions=path');
  const creation=await client.getTransactionReceipt({hash:tx});
  if(creation.status!=='success')throw Error('Creation transaction did not succeed');
  const identifier=`src/nft/${entry.contract}.sol:${entry.contract}`;
  const standard=execFileSync(`${homedir()}/.foundry/bin/forge`,['verify-contract',entry.address,identifier,'--chain','4663','--show-standard-json-input'],{cwd:'evm',encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:8*1024*1024});
  const response=await fetch(`https://sourcify.dev/server/v2/verify/4663/${entry.address}`,{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(30000),body:JSON.stringify({stdJsonInput:JSON.parse(standard),compilerVersion:artifact(entry.contract).metadata.compiler.version,contractIdentifier:identifier,creationTransactionHash:tx})});
  if(!response.ok)throw Error(`Source submission HTTP ${response.status}`);
  const result=await response.json();if(typeof result.verificationId!=='string')throw Error('Missing source verification job ID');
  record[entry.label].verificationId=result.verificationId;
 }
 record[entry.label].source='pending';writeFileSync(recordPath,JSON.stringify(record,null,2));
 console.log(`${entry.label}: bytecode/configuration matched; source verification pending`);
}
