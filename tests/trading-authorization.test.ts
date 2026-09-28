import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import type {EIP1193Provider} from 'viem';
import {TradingClient,venueGet} from '../web/trading/client.js';
import type {wasm} from '../web/trading/wasm.js';

const address='0x1111111111111111111111111111111111111111';
const index=100000,publicKey='ab'.repeat(40),journal=`dlp.execution.v1.${address}`;
const memory=new Map<string,string>(),originalFetch=globalThis.fetch;
type Key={account_index:number;api_key_index:number;public_key:string};
let keys:Key[],walletSigns:number,sends:number,keyStatus:number,keyCode:number,accountMissing:boolean,registerVisible:boolean;
const registered=(api_key_index=42,public_key=publicKey,account_index=index):Key=>({account_index,api_key_index,public_key});
const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const provider={request:async({method}:{method:string})=>{
  if(method==='eth_accounts')return [address];if(method==='eth_chainId')return '0x1237';
  if(method==='personal_sign'){walletSigns++;return `0x${'11'.repeat(65)}`;}
  throw new Error(`Unexpected wallet call: ${method}`);
}} as unknown as EIP1193Provider;
const signer:typeof wasm=async<T>(name:`_${string}`,...args:unknown[])=>{
  if(name==='_createClient'){assert.equal(args[1],466324);assert.equal(args[2],index);assert.equal(args[4],42);return {pk:publicKey,body:'test only'} as T;}
  if(name==='_getChangePubKeyTransaction')return {body:'test registration only'} as T;
  if(name==='_signChangePubKey')return {txHash:'test-key-hash',txInfo:'{"test":true}'} as T;
  throw new Error(`Unexpected signer call: ${name}`);
};
beforeEach(()=>{
  keys=[];walletSigns=0;sends=0;keyStatus=200;keyCode=200;accountMissing=false;registerVisible=true;memory.clear();
  Object.defineProperty(globalThis,'location',{configurable:true,value:{origin:'https://test.invalid'}});
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(key:string)=>memory.get(key)??null,setItem:(key:string,value:string)=>memory.set(key,value),removeItem:(key:string)=>memory.delete(key)}});
  Object.defineProperty(globalThis.navigator,'locks',{configurable:true,value:{request:async(_name:string,_opts:unknown,fn:(lock:object)=>Promise<unknown>)=>fn({})}});
  globalThis.fetch=async(input,options)=>{
    const url=new URL(String(input));
    if(url.pathname.endsWith('/accountsByL1Address'))return accountMissing?response({code:21100,message:'account not found'},400):response({code:200,sub_accounts:[{index,account_type:0}]});
    if(url.pathname.endsWith('/account'))return response({code:200,accounts:[{index,l1_address:address,account_type:0,account_trading_mode:1,available_balance:'5.000000',collateral:'5.000000',pending_order_count:0,total_order_count:0,positions:[],assets:[{asset_id:3,symbol:'USDG',margin_mode:'enabled',margin_balance:'5.000000',multiplier:'1'}]}]});
    if(url.pathname.endsWith('/apikeys')){
      assert.equal(url.searchParams.get('account_index'),String(index));
      // Reproduce the venue: the old single-slot request would fail on first setup.
      if(url.searchParams.get('api_key_index')==='42')return response({code:21109,message:'api key not found'},400);
      assert.equal(url.searchParams.get('api_key_index'),'255');return response({code:keyCode,api_keys:keys},keyStatus);
    }
    if(url.pathname.endsWith('/nextNonce'))return response({code:200,nonce:0});
    if(url.pathname.endsWith('/sendTx')){
      assert.ok(memory.has(journal));assert.equal((options?.body as FormData).get('tx_type'),'8');sends++;
      if(registerVisible)keys.push(registered());return response({code:200,tx_hash:'test-key-hash'});
    }
    if(url.pathname.endsWith('/tx'))return response({code:200,hash:'test-key-hash',account_index:index,status:2,event_info:'{}'});
    throw new Error(`Unexpected URL: ${url.pathname}`);
  };
});
afterEach(()=>{globalThis.fetch=originalFetch;});
const client=()=>new TradingClient(provider,address,signer,async()=>{});
test('first funded account registers an empty key slot and confirms the resulting public key',async()=>{
  const c=client();const result=await c.authorize();assert.equal(result.state,'executed');assert.equal(c.authorized,true);assert.equal(walletSigns,2);assert.equal(sends,1);assert.equal(memory.has(journal),false);
});
test('reconnecting selects slot 42 by identity even when another key is listed first',async()=>{
  keys=[registered(7,'cd'.repeat(40)),registered(42,`0x${publicKey.toUpperCase()}`)];
  const c=client();assert.equal((await c.authorize()).state,'ready');assert.equal(c.authorized,true);assert.equal(walletSigns,1);assert.equal(sends,0);
});
test('occupied slot is never overwritten',async()=>{
  keys=[registered(42,'cd'.repeat(40))];const c=client();await assert.rejects(()=>c.authorize(),/already in use/);assert.equal(c.authorized,false);assert.equal(sends,0);
});
test('key lookup failures do not become empty slots or trigger a wallet prompt',async()=>{
  for(const [status,code] of [[500,500],[400,21109],[400,21100]]){keyStatus=status;keyCode=code;await assert.rejects(()=>client().authorize(),/apikeys failed/);}
  assert.equal(walletSigns,0);assert.equal(sends,0);
});
test('foreign account and duplicate key records fail before signing',async()=>{
  keys=[registered(42,publicKey,index+1)];await assert.rejects(()=>client().authorize(),/account mismatch/);
  keys=[registered(),registered()];await assert.rejects(()=>client().authorize(),/Duplicate/);assert.equal(walletSigns,0);assert.equal(sends,0);
});
test('key transaction execution alone does not mark an unobserved registration authorized',async()=>{
  registerVisible=false;const c=client();assert.equal((await c.authorize()).state,'pending');assert.equal(c.authorized,false);assert.equal(sends,1);
  keys=[registered()];assert.equal((await c.authorize()).state,'ready');assert.equal(c.authorized,true);assert.equal(sends,1);
});
test('account not found before first deposit is an expected state',async()=>{
  accountMissing=true;const c=client();assert.equal(await c.refresh(),null);await assert.rejects(()=>c.authorize(),/Deposit/);assert.equal(walletSigns,0);assert.equal(sends,0);
});
test('malformed and transport failures report useful diagnostics without server payloads',async()=>{
  globalThis.fetch=async()=>new Response('private server details',{status:503});await assert.rejects(()=>venueGet('apikeys?account_index=100000&api_key_index=255'),/unreadable response \(HTTP 503\)/);
  globalThis.fetch=async()=>{throw new TypeError('private transport details');};await assert.rejects(()=>venueGet('account'),/Could not reach Lighter/);
});
