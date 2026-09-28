import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';

const version=process.argv.find(arg=>arg.startsWith('--version='))?.slice(10)??'v1';
if(!/^v[1-9][0-9]*$/.test(version))throw new Error('Invalid deployment version.');
const manifest=JSON.parse(readFileSync(new URL(`../deployments/4663-tokenized-${version}.json`,import.meta.url),'utf8'));
const path=new URL(`../deployments/4663-tokenized-${version}-sourcify.json`,import.meta.url);
const record=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{};
const entries={...manifest.steps,MemberFactory:{...manifest.factory,transactionHash:manifest.steps.MemberController.transactionHash}};
const endpoint='https://sourcify.dev/server/v2';
for(const [name,entry] of Object.entries(entries)){
  const lookup=await fetch(`${endpoint}/contract/4663/${entry.address}`,{signal:AbortSignal.timeout(20000)});
  if(lookup.ok){
    const verified=await lookup.json();
    if(verified.creationMatch==='match'&&verified.runtimeMatch==='match'){
      record[name]={address:entry.address,match:verified.match,creationMatch:verified.creationMatch,runtimeMatch:verified.runtimeMatch,verifiedAt:new Date().toISOString()};
      writeFileSync(path,JSON.stringify(record,null,2)+'\n');console.log(`${name}: creation and runtime match`);continue;
    }
  }else if(lookup.status!==404)throw new Error(`${name}: Sourcify lookup HTTP ${lookup.status}`);
  if(record[name]?.verificationId){
    const response=await fetch(`${endpoint}/verify/${record[name].verificationId}`,{signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new Error(`${name}: verification lookup HTTP ${response.status}`);
    const job=await response.json();
    console.log(`${name}: ${job.isJobCompleted?'job completed; recheck contract match':'verification pending'}`);
    // Full upstream diagnostics can contain large unrelated explorer HTML. Keep
    // the public record limited to identity, job ID, and independently checked matches.
    continue;
  }
  const artifact=JSON.parse(readFileSync(new URL(`../out/${name}.sol/${name}.json`,import.meta.url),'utf8'));
  const source=execFileSync(`${homedir()}/.foundry/bin/forge`,['verify-contract',entry.address,`src/tokenized/${name}.sol:${name}`,'--chain','4663','--show-standard-json-input'],{cwd:new URL('../',import.meta.url),encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:8*1024*1024});
  const response=await fetch(`${endpoint}/verify/4663/${entry.address}`,{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(30000),body:JSON.stringify({
    stdJsonInput:JSON.parse(source),compilerVersion:artifact.metadata.compiler.version,contractIdentifier:`src/tokenized/${name}.sol:${name}`,creationTransactionHash:entry.transactionHash,
  })});
  if(!response.ok)throw new Error(`${name}: Sourcify submission HTTP ${response.status}`);
  const result=await response.json();
  if(typeof result.verificationId!=='string')throw new Error(`${name}: missing verification ID`);
  record[name]={address:entry.address,verificationId:result.verificationId,submittedAt:new Date().toISOString()};
  writeFileSync(path,JSON.stringify(record,null,2)+'\n');console.log(`${name}: submitted`);
}
