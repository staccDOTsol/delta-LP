import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';

const version=process.argv.find(arg=>arg.startsWith('--version='))?.slice(10);
if(!version||!/^v[1-9][0-9]*$/.test(version))throw new Error('An explicit --version=vN is required.');
const registry=JSON.parse(readFileSync(new URL(`../deployments/4663-neutral-${version}-registry.json`,import.meta.url),'utf8'));
const path=new URL(`../deployments/4663-neutral-${version}-sourcify.json`,import.meta.url);
const record=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{};
const endpoint='https://sourcify.dev/server/v2',sources=new Map();
const entries=registry.members.flatMap(m=>['MemberToken','LighterSeriesAccount'].map(name=>({
  key:`${m.id}-${name}`,name,address:name==='MemberToken'?m.token:m.custody,
  transactionHash:registry.calls[`ETH-${m.tier}-${m.short?'S':'L'}`]?.hash,
})));
function save(){writeFileSync(path,JSON.stringify(record,null,2)+'\n');}
for(const name of ['MemberToken','LighterSeriesAccount']){
  const first=entries.find(e=>e.name===name);if(!first)continue;
  const artifact=JSON.parse(readFileSync(new URL(`../out/${name}.sol/${name}.json`,import.meta.url),'utf8'));
  const source=execFileSync(`${homedir()}/.foundry/bin/forge`,['verify-contract',first.address,`src/tokenized/${name}.sol:${name}`,'--chain','4663','--show-standard-json-input'],{cwd:new URL('../',import.meta.url),encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:8*1024*1024});
  sources.set(name,{stdJsonInput:JSON.parse(source),compilerVersion:artifact.metadata.compiler.version,contractIdentifier:`src/tokenized/${name}.sol:${name}`});
}
async function verify(e){
  if(record[e.key]?.creationMatch==='match'&&record[e.key]?.runtimeMatch==='match')return;
  const response=await fetch(`${endpoint}/contract/4663/${e.address}`,{signal:AbortSignal.timeout(20000)});
  if(response.ok){
    const result=await response.json();
    if(result.creationMatch==='match'&&result.runtimeMatch==='match'){
      record[e.key]={address:e.address,creationMatch:'match',runtimeMatch:'match',verifiedAt:new Date().toISOString()};save();return;
    }
  }else if(response.status!==404)throw new Error(`${e.key}: lookup HTTP ${response.status}`);
  if(record[e.key]?.verificationId)return;
  if(!e.transactionHash)throw new Error(`${e.key}: no recorded creation transaction.`);
  const submitted=await fetch(`${endpoint}/verify/4663/${e.address}`,{method:'POST',headers:{'content-type':'application/json'},
    signal:AbortSignal.timeout(30000),body:JSON.stringify({...sources.get(e.name),creationTransactionHash:e.transactionHash})});
  if(!submitted.ok)throw new Error(`${e.key}: submission HTTP ${submitted.status}`);
  const result=await submitted.json();if(typeof result.verificationId!=='string')throw new Error(`${e.key}: missing verification ID.`);
  record[e.key]={address:e.address,verificationId:result.verificationId,submittedAt:new Date().toISOString()};save();
}
const failures=[];
let failedBatches=0;
for(let start=0;start<entries.length;start+=4){
  const results=await Promise.allSettled(entries.slice(start,start+4).map(verify));
  results.forEach((result,index)=>{if(result.status==='rejected')failures.push({key:entries[start+index].key,error:String(result.reason?.message??'Source verification failed')});});
  failedBatches=results.every(result=>result.status==='rejected')?failedBatches+1:0;
  if(failedBatches===3){console.error('Source service unavailable for three complete batches; preserving progress for a later retry.');break;}
  if(start%40===0)console.log(`Checked ${Math.min(start+4,entries.length)}/${entries.length} child contracts.`);
}
const matched=Object.values(record).filter(r=>r.creationMatch==='match'&&r.runtimeMatch==='match').length;
console.log(JSON.stringify({recorded:Object.keys(record).length,matched,pending:Object.keys(record).length-matched,failures}));
if(failures.length)process.exitCode=1; // Confirmed records survive; reruns retry only unresolved work.
