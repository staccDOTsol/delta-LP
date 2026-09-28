import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {encodeAbiParameters} from 'viem';
import {homedir} from 'node:os';
import {setTimeout as wait} from 'node:timers/promises';

const key=process.env.ETHERSCAN_API_KEY;
if(!key)throw new Error('Set ETHERSCAN_API_KEY in the process environment.');
const manifest=JSON.parse(readFileSync(new URL('../deployments/4663-tokenized-v1.json',import.meta.url),'utf8'));
const path=new URL('../deployments/4663-tokenized-v1-verification.json',import.meta.url);
const record=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{};
const entries={...manifest.steps,MemberFactory:{...manifest.factory,constructorArgs:[manifest.dependencies.usdg,manifest.dependencies.lighter]}};
for(const [name,entry] of Object.entries(entries)){
  await wait(500); // This account's explorer API permits three requests per second.
  const endpoint=new URL('https://api.etherscan.io/v2/api');
  endpoint.search=new URLSearchParams({chainid:'4663',apikey:key,module:'contract',action:record[name]?.guid?'checkverifystatus':'verifysourcecode'});
  let response;
  if(record[name]?.status==='verified'){console.log(`${name}: verified`);continue;}
  if(record[name]?.guid){
    endpoint.searchParams.set('guid',record[name].guid);
    response=await fetch(endpoint,{signal:AbortSignal.timeout(20_000)});
  }else{
    const artifact=JSON.parse(readFileSync(new URL(`../out/${name}.sol/${name}.json`,import.meta.url),'utf8'));
    const source=execFileSync(`${homedir()}/.foundry/bin/forge`,['verify-contract',entry.address,`src/tokenized/${name}.sol:${name}`,'--chain','4663','--show-standard-json-input'],{cwd:new URL('../',import.meta.url),encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:8*1024*1024});
    JSON.parse(source); // Never send compiler logs or malformed source.
    const constructor=artifact.abi.find(item=>item.type==='constructor');
    const args=constructor?.inputs.length?encodeAbiParameters(constructor.inputs,entry.constructorArgs).slice(2):'';
    response=await fetch(endpoint,{method:'POST',signal:AbortSignal.timeout(30_000),body:new URLSearchParams({
      contractaddress:entry.address,sourceCode:source,codeformat:'solidity-standard-json-input',
      contractname:`src/tokenized/${name}.sol:${name}`,compilerversion:`v${artifact.metadata.compiler.version}`,
      optimizationUsed:'1',runs:'200',constructorArguements:args,licenseType:'3',
    })});
  }
  if(!response.ok)throw new Error(`Explorer request failed for ${name}: HTTP ${response.status}`);
  const result=await response.json();
  if(record[name]?.guid){
    record[name]={...record[name],status:result.status==='1'?'verified':/Pending|rate limit/i.test(String(result.result))?'pending':'failed',result:result.result,checkedAt:new Date().toISOString()};
  }else{
    record[name]={address:entry.address,status:result.status==='1'?'pending':String(result.result).includes('Already Verified')?'verified':'failed',
      ...(result.status==='1'?{guid:result.result}:{result:result.result}),submittedAt:new Date().toISOString()};
  }
  writeFileSync(path,JSON.stringify(record,null,2)+'\n');
  console.log(`${name}: ${record[name].status}`);
}
