// Submit/check public source verification for the actually deployed NFT bundle.
// No transaction signer. Explorer credentials are read only from the environment.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {setTimeout as wait} from 'node:timers/promises';
import {encodeAbiParameters,keccak256,toHex} from 'viem';
const key=process.env.ETHERSCAN_API_KEY;
if(!key)throw Error('ETHERSCAN_API_KEY must be provided in the environment');
const version=process.argv.find(x=>x.startsWith('--version='))?.slice(10)||'v5';
if(!/^v[1-9][0-9]*$/.test(version))throw Error('Invalid deployment version');
const manifest=JSON.parse(readFileSync(`evm/deployments/4663-nft-${version}.json`));
const planDir=process.argv.find(x=>x.startsWith('--plan-dir='))?.slice(11)||'artifacts/nft-deployment';
const planText=readFileSync(`${planDir}/unsigned.json`,'utf8');
if(manifest.chainId!==4663||manifest.status!=='deployed-paused'||manifest.planHash!==keccak256(toHex(planText))||manifest.calls.length!==30||manifest.calls.some(c=>c.status!=='success'))throw Error('Expected confirmed NFT software deployment');
const path=`evm/deployments/4663-nft-${version}-etherscan.json`;
const record=existsSync(path)?JSON.parse(readFileSync(path)):{};
for(const entry of manifest.deployments){
 if(!entry.transactionHash||!entry.runtimeCodeHash||!['DnPendingAdapter','DnPendingSeaDropEdition','DnPendingSeaDropEditionV2'].includes(entry.contract))throw Error('Incomplete deployment proof');
 const old=record[entry.label];
 if(old&&old.address.toLowerCase()!==entry.address.toLowerCase())throw Error('Verification address changed');
 if(old?.status==='verified'){console.log(`${entry.label}: explorer verified`);continue;}
 await wait(1200); // Leave headroom for the core task sharing the explorer key.
 const endpoint=new URL('https://api.etherscan.io/v2/api');
 endpoint.search=new URLSearchParams({chainid:'4663',apikey:key,module:'contract',action:old?.guid?'checkverifystatus':'verifysourcecode'});
 let response;
 if(old?.guid){
  endpoint.searchParams.set('guid',old.guid);
  response=await fetch(endpoint,{signal:AbortSignal.timeout(25000)});
 }else{
  const artifact=JSON.parse(readFileSync(`evm/out/${entry.contract}.sol/${entry.contract}.json`));
  const identifier=`src/nft/${entry.contract}.sol:${entry.contract}`;
  const source=execFileSync(`${homedir()}/.foundry/bin/forge`,['verify-contract',entry.address,identifier,'--chain','4663','--show-standard-json-input'],{cwd:'evm',encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:8*1024*1024});
  JSON.parse(source);
  const constructor=artifact.abi.find(x=>x.type==='constructor');
  const args=constructor?.inputs.length?encodeAbiParameters(constructor.inputs,entry.constructorArgs).slice(2):'';
  response=await fetch(endpoint,{method:'POST',signal:AbortSignal.timeout(30000),body:new URLSearchParams({contractaddress:entry.address,sourceCode:source,codeformat:'solidity-standard-json-input',contractname:identifier,compilerversion:`v${artifact.metadata.compiler.version}`,optimizationUsed:'1',runs:'200',constructorArguements:args,licenseType:'3'})});
 }
 if(!response.ok)throw Error(`Explorer HTTP ${response.status}`);
 const result=await response.json();
 const note=String(result.result).replaceAll(key,'[redacted]');
 if(old?.guid){
  record[entry.label]={...old,status:result.status==='1'?'verified':/pending|rate limit/i.test(note)?'pending':'failed',result:note,checkedAt:new Date().toISOString()};
 }else{
  record[entry.label]={address:entry.address,status:result.status==='1'?'pending':/already verified/i.test(note)?'verified':'failed',...(result.status==='1'?{guid:note}:{result:note}),submittedAt:new Date().toISOString()};
 }
 writeFileSync(path,JSON.stringify(record,null,2)+'\n');
 console.log(`${entry.label}: explorer ${record[entry.label].status}`);
}
