import {createServer} from 'node:http';
import {mkdirSync,readFileSync,writeFileSync,chmodSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {cloudHealth} from './cloud-health.js';

// Fly starts the same worker as the local CLI. Default observation mode has no
// signing key, no transaction broadcast, and no public HTTP service.
const mode=process.env.DELTA_KEEPER_MODE??'observe';
if(!['observe','execute'].includes(mode))throw new Error('Unknown keeper cloud mode.');
const port=Number(process.env.DELTA_KEEPER_HEALTH_PORT??8080);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid keeper health port.');
const directory=resolve(process.env.DELTA_KEEPER_STATE??'/data/keeper-v3');
mkdirSync(directory,{recursive:true,mode:0o700});chmodSync(directory,0o700);
process.env.DELTA_KEEPER_STATE=directory;
const runtime=process.env.DELTA_KEEPER_RUNTIME??'/run/delta-keeper';
mkdirSync(runtime,{recursive:true,mode:0o700});chmodSync(runtime,0o700);

if(mode==='execute'){
  const key=process.env.DELTA_KEEPER_PRIVATE_KEY;
  const config=process.env.DELTA_KEEPER_CONFIG_JSON;
  delete process.env.DELTA_KEEPER_PRIVATE_KEY;delete process.env.DELTA_KEEPER_CONFIG_JSON;
  if(!key||!config||!/^(0x)?[a-fA-F0-9]{64}$/.test(key.trim()))throw new Error('Execution requires explicitly supplied keeper key and configuration secrets.');
  const settings=JSON.parse(config); // The worker validates its strict schema before signing.
  writeFileSync(join(runtime,'key'),key.trim(),{mode:0o600});chmodSync(join(runtime,'key'),0o600);
  writeFileSync(join(runtime,'config.json'),JSON.stringify(settings),{mode:0o600});chmodSync(join(runtime,'config.json'),0o600);
  process.env.DELTA_KEEPER_KEY_FILE=join(runtime,'key');process.env.DELTA_KEEPER_CONFIG=join(runtime,'config.json');
  process.argv.push('--execute');
}else{
  // Staging secrets must never turn an observer into a signer implicitly.
  delete process.env.DELTA_KEEPER_PRIVATE_KEY;delete process.env.DELTA_KEEPER_CONFIG_JSON;
  delete process.env.DELTA_KEEPER_KEY_FILE;delete process.env.DELTA_KEEPER_CONFIG;
  if(process.argv.includes('--execute'))throw new Error('Observation mode cannot execute.');
}

const startedAt=Date.now();
const server=createServer((req,res)=>{
  if(req.method!=='GET'||req.url!=='/healthz'){res.writeHead(404).end();return;}
  let raw:unknown;try{raw=JSON.parse(readFileSync(join(directory,'status.json'),'utf8'));}catch{/* No completed observation yet. */}
  const status=cloudHealth(raw,mode==='execute'?'execution':'observation',startedAt);
  res.writeHead(status.ok?200:503,{'content-type':'application/json','cache-control':'no-store'}).end(JSON.stringify(status));
});
await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'0.0.0.0',resolve);});
try{await import('./run.js');}finally{server.close();}
