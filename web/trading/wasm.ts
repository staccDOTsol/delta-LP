type GoRuntime={importObject:WebAssembly.Imports;run:(instance:WebAssembly.Instance)=>Promise<void>};
declare global {interface Window {Go:new()=>GoRuntime;[key:`_${string}`]:((...args:unknown[])=>Promise<()=>Promise<Record<string,unknown>>>)|undefined}}
let ready:Promise<void>|undefined;
export function loadSigner(){
  return ready??=(async()=>{
    if(!window.Go)await new Promise<void>((resolve,reject)=>{const script=document.createElement('script');script.src='/vendor/lighter/wasm_exec.js';script.onload=()=>resolve();script.onerror=()=>reject(new Error('Trading signer could not load.'));document.head.append(script);});
    const go=new window.Go();
    const response=await fetch('/vendor/lighter/main.wasm');if(!response.ok)throw new Error('Trading signer unavailable.');
    const bytes=await response.arrayBuffer();
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(v=>v.toString(16).padStart(2,'0')).join('');
    if(digest!=='072594dfb8bfdf59e583c0f1c3e63aa12dce4599ebda4f0828b7836c9f3a5b4b')throw new Error('Signer integrity check failed.');
    const {instance}=await WebAssembly.instantiate(bytes,go.importObject);void go.run(instance);
    for(let n=0;n<100;n++){if(window._createClient)return;await new Promise(resolve=>setTimeout(resolve,20));}
    throw new Error('Trading signer did not initialize.');
  })();
}
export async function wasm<T>(name:`_${string}`,...args:unknown[]):Promise<T>{
  await loadSigner();const fn=window[name];if(!fn)throw new Error('Unsupported signer operation.');
  const result=await(await fn(...args))();
  // Native errors may contain input material. Keep errors out of logs and telemetry.
  if('error' in result)throw new Error('Lighter could not sign this request.');
  return result as T;
}
