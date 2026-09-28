// Explorer source verification fallback when Sourcify is unavailable. Never signs chain transactions.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {setTimeout as wait} from 'node:timers/promises';
import {encodeAbiParameters,encodeFunctionData,keccak256,toHex} from 'viem';
import {client} from './preflight.mjs';

const version=process.argv.find(x=>x.startsWith('--version='))?.slice(10);
if(!version||!/^v[1-9][0-9]*$/.test(version))throw Error('Explicit deployment version required.');
const key=process.env.ETHERSCAN_API_KEY;
const submitOnly=process.argv.includes('--submit-only');
if(!key)throw Error('ETHERSCAN_API_KEY is required.');
const registry=JSON.parse(readFileSync(`evm/deployments/4663-neutral-${version}-registry.json`));
const stack=JSON.parse(readFileSync(`evm/deployments/4663-tokenized-${version}.json`));
if(await client.getChainId()!==4663||registry.chainId!==4663||registry.members.length!==100||registry.controller!==stack.steps[stack.controllerName].address)throw Error('Deployment identity mismatch.');
const path=`evm/deployments/4663-neutral-${version}-etherscan.json`;
const record=existsSync(path)?JSON.parse(readFileSync(path)):{};
const art=name=>JSON.parse(readFileSync(`evm/out/${name}.sol/${name}.json`));
const controllerAbi=art(stack.controllerName).abi;
const sources=new Map();
for(const name of ['MemberToken','LighterSeriesAccount']){
 const identifier=`src/tokenized/${name}.sol:${name}`;
 const source=execFileSync(`${homedir()}/.foundry/bin/forge`,['verify-contract',registry.members[0][name==='MemberToken'?'token':'custody'],identifier,'--chain','4663','--show-standard-json-input'],{cwd:'evm',encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:8*1024*1024});
 JSON.parse(source);sources.set(name,{identifier,source,artifact:art(name)});
}
let processed=0;
for(const member of registry.members){
 const label=`ETH-${member.tier}-${member.short?'S':'L'}`;
 const name=`deltaLP ETH ${member.tier}x ${member.short?'Short':'Long'}`,symbol=`dlpETH${member.tier}${member.short?'S':'L'}`;
 const call=registry.calls[label];
 const data=encodeFunctionData({abi:controllerAbi,functionName:'createMember',args:[keccak256(toHex('ETH')),0,member.tier,member.short,4,2,name,symbol]});
 if(call?.status!=='success'||call.dataHash!==keccak256(data))throw Error('Recorded member creation arguments do not match.');
 for(const contract of ['MemberToken','LighterSeriesAccount']){
  const token=contract==='MemberToken',address=token?member.token:member.custody,id=`${member.id}-${contract}`;
  const old=record[id];
  if(old&&old.address!==address)throw Error('Verification identity changed.');
  if(old?.status==='verified'||submitOnly&&old?.status==='pending'&&old.guid){processed++;continue;}
  const code=await client.getCode({address});
  if(!code||keccak256(code)!==(token?member.tokenCodeHash:member.custodyCodeHash))throw Error('Child runtime mismatch.');
  const args=token?[name,symbol,BigInt(member.id),registry.controller]:[stack.dependencies.usdg,stack.dependencies.lighter,0,registry.controller];
  const {identifier,source,artifact}=sources.get(contract);
  await wait(1100); // Leave capacity for other projects sharing this API key.
  const endpoint=new URL('https://api.etherscan.io/v2/api');
  endpoint.search=new URLSearchParams({chainid:'4663',apikey:key,module:'contract',action:old?.guid?'checkverifystatus':'verifysourcecode'});
  let response;
  if(old?.guid){endpoint.searchParams.set('guid',old.guid);response=await fetch(endpoint,{signal:AbortSignal.timeout(20000)});}
  else response=await fetch(endpoint,{method:'POST',signal:AbortSignal.timeout(30000),body:new URLSearchParams({contractaddress:address,sourceCode:source,codeformat:'solidity-standard-json-input',contractname:identifier,compilerversion:`v${artifact.metadata.compiler.version}`,optimizationUsed:'1',runs:'200',constructorArguements:encodeAbiParameters(artifact.abi.find(x=>x.type==='constructor').inputs,args).slice(2),licenseType:'3'})});
  if(!response.ok)throw Error(`Explorer HTTP ${response.status}; confirmed progress saved.`);
  const result=await response.json(),note=String(result.result).replaceAll(key,'[redacted]');
  record[id]=old?.guid?{...old,status:result.status==='1'?'verified':/pending|rate limit/i.test(note)?'pending':'failed',result:note,checkedAt:new Date().toISOString()}:
    {address,status:result.status==='1'?'pending':/already verified/i.test(note)?'verified':'failed',...(result.status==='1'?{guid:note}:{result:note}),submittedAt:new Date().toISOString()};
  writeFileSync(path,JSON.stringify(record,null,2)+'\n');
  if(++processed%20===0)console.log(`Explorer checked ${processed}/200 children.`);
 }
}
console.log(JSON.stringify({recorded:Object.keys(record).length,verified:Object.values(record).filter(r=>r.status==='verified').length,pending:Object.values(record).filter(r=>r.status==='pending').length,failed:Object.values(record).filter(r=>r.status==='failed').length}));
