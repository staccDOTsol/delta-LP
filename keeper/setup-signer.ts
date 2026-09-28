import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {setupKeyMessage,venuePublicKey} from '../strategy/member-setup.js';
import type {PrivateKeyAccount} from 'viem/accounts';
import {controller} from './rpc.js';
import type {Snapshot} from './model.js';

type Go={importObject:WebAssembly.Imports;run:(instance:WebAssembly.Instance)=>Promise<void>};
type Runtime={Go:new()=>Go;[key:`_${string}`]:((...args:unknown[])=>Promise<()=>Promise<Record<string,unknown>>>)|undefined};
let initialized:Promise<void>|undefined;
async function load(){
  return initialized??=(async()=>{
    const root=new URL('../public/vendor/lighter/',import.meta.url);
    const manifest=JSON.parse(readFileSync(new URL('manifest.json',root),'utf8')) as {files:Record<string,{sha256:string}>};
    for(const name of ['wasm_exec.js','main.wasm'])if(createHash('sha256').update(readFileSync(new URL(name,root))).digest('hex')!==manifest.files[name].sha256)throw new Error('Venue signer integrity mismatch.');
    const runtime=globalThis as unknown as Runtime;(globalThis as unknown as {window:unknown}).window=globalThis;
    vm.runInThisContext(readFileSync(new URL('wasm_exec.js',root),'utf8'));
    const go=new runtime.Go();const {instance}=await WebAssembly.instantiate(readFileSync(new URL('main.wasm',root)),go.importObject);void go.run(instance);
    for(let i=0;i<100;i++){if(runtime._createClient)return;await new Promise(r=>setTimeout(r,10));}
    throw new Error('Venue signer startup failed.');
  })();
}
async function invoke(name:'_createClient'|'_signUpdateLeverage',...args:unknown[]){
  await load();const fn=(globalThis as unknown as Runtime)[name];if(!fn)throw new Error('Venue signer operation unavailable.');
  const value=await(await fn(...args))();if('error' in value)throw new Error('Venue setup signing failed.');return value;
}
/** Same derivation and origin as the wallet setup screen. Key material is kept
 * in memory and never written to status, transaction journals or logs. Calls must
 * be serialized because the vendored Go signer holds the selected account. */
export async function setupSigner(account:PrivateKeyAccount,m:Snapshot,generation:bigint){
  const message=setupKeyMessage({controller,custody:m.custody,owner:account.address,member:m.id,accountIndex:m.accountIndex,generation},'https://deltalp.fun');
  const signature=await account.signMessage({message});
  const seed=createHash('sha256').update(signature).digest('hex');
  const value=await invoke('_createClient',seed,466324,m.accountIndex,0,42,false);
  const publicKey=venuePublicKey(String(value.pk));
  return {publicKey,async margin(marginBps:number,nonce:number){
    const signed=await invoke('_signUpdateLeverage',m.accountIndex,m.market,marginBps,0,nonce);
    if(typeof signed.txHash!=='string'||typeof signed.txInfo!=='string')throw new Error('Venue signer returned an invalid setup transaction.');
    return {hash:signed.txHash,info:signed.txInfo};
  }};
}
