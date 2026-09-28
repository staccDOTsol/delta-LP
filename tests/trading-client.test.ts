import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {formatUnits,type EIP1193Provider} from 'viem';
import {TradingClient} from '../web/trading/client.js';
import {makePlan,type TradingAccount} from '../strategy/execution.js';
import type {Market} from '../strategy/lighter.js';
import type {wasm} from '../web/trading/wasm.js';

const address='0x1111111111111111111111111111111111111111';
const key=`dlp.execution.v1.${address}`;
const originalFetch=globalThis.fetch;
const memory=new Map<string,string>();
let sends=0,signs=0,failSend=false,pendingTx=false,apiOffline=false;
let account:TradingAccount;
let providerAccount=address,providerChain='0x1237';
let signedArgs:unknown[]=[];
let lastPlan:ReturnType<typeof makePlan>;
const provider={request:async({method}:{method:string})=>method==='eth_accounts'?[providerAccount]:providerChain} as unknown as EIP1193Provider;
const signer:typeof wasm=async<T>(name:`_${string}`,...args:unknown[])=>{
  if(name==='_createAuthToken')return {token:'fake-test-auth'} as T;
  signs++;signedArgs=args;return {txInfo:'{"test":true}',txHash:'test-hash'} as T;
};
const response=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
beforeEach(()=>{
  memory.clear();sends=0;signs=0;failSend=false;pendingTx=false;apiOffline=false;providerAccount=address;providerChain='0x1237';
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(k:string)=>memory.get(k)??null,setItem:(k:string,v:string)=>memory.set(k,v),removeItem:(k:string)=>memory.delete(k)}});
  Object.defineProperty(globalThis.navigator,'locks',{configurable:true,value:{request:async(_name:string,_opts:unknown,fn:(lock:object)=>Promise<unknown>)=>fn({})}});
  account={index:100000,l1_address:address,account_type:0,account_trading_mode:0,available_balance:'28.934330',collateral:'28.934330',pending_order_count:0,total_order_count:0,
    positions:[{market_id:0,symbol:'ETH',position:'0',sign:0,initial_margin_fraction:'33.34',margin_mode:1,open_order_count:0,pending_order_count:0,position_tied_order_count:0,unrealized_pnl:'0',liquidation_price:'0'}]};
  const market:Market={symbol:'ETH',id:0,active:true,mark:'2650.00',bid:'2649.99',ask:'2650.01',maxLeverage:50,minBase:'0.0050',minNotional:'10.000000',sizeDecimals:4,priceDecimals:2,maintenanceMarginBps:120,bidDepth10bps:1_000_000,askDepth10bps:1_000_000,observedAt:new Date().toISOString()};
  lastPlan=makePlan({symbol:'ETH',side:'long',leverage:3,collateral:'5'},market,account);
  globalThis.fetch=async(url,options)=>{
    const path=String(url);
    if(path.endsWith('/sendTx')){
      sends++;assert.ok(memory.has(key),'Intent persisted before send');
      if(!pendingTx){account.positions[0].position=lastPlan.size;account.positions[0].sign=1;}
      if(failSend)throw new TypeError('Connection lost after accepting transaction');
      assert.equal((options?.body as FormData).get('tx_type'),'14');
      return response({code:200,tx_hash:'test-hash'});
    }
    if(apiOffline)throw new TypeError('Venue offline');
    if(path.includes('accountsByL1Address'))return response({code:200,sub_accounts:[{index:100000,account_type:0}]});
    if(path.includes('/account?'))return response({code:200,accounts:[account]});
    if(path.includes('/nextNonce'))return response({code:200,nonce:1});
    if(path.includes('/tx?'))return response({code:200,hash:'test-hash',account_index:100000,status:pendingTx?1:2,event_info:'{}'});
    if(path.includes('accountActiveOrders'))return response({code:200,orders:[]});
    if(path.includes('accountInactiveOrders'))return response({code:200,next_cursor:null,orders:[{
      owner_account_index:100000,market_index:0,client_order_index:signedArgs[2],order_index:55,initial_base_amount:lastPlan.size,price:lastPlan.price,
      is_ask:false,reduce_only:false,time_in_force:'immediate-or-cancel',status:'filled',filled_base_amount:lastPlan.size,
      filled_quote_amount:formatUnits(BigInt(lastPlan.baseTicks)*BigInt(lastPlan.priceTicks),6),
    }]});
    throw new Error(`Unexpected test URL: ${path}`);
  };
});
afterEach(()=>{globalThis.fetch=originalFetch;});
function client(){const c=new TradingClient(provider,address,signer,async()=>{});c.authorized=true;return c;}
test('signed IOC executes once and clears journal only after fill and position match',async()=>{
  const result=await client().trade(lastPlan);assert.equal(result.state,'filled');assert.equal(sends,1);assert.equal(signs,1);assert.equal(memory.has(key),false);
  assert.equal(signedArgs[7],0);assert.equal(signedArgs[8],0); // IOC, not reduce-only opening
});
test('response lost after acceptance reconciles without resending',async()=>{
  failSend=true;const result=await client().trade(lastPlan);assert.equal(result.state,'filled');assert.equal(sends,1);
});
test('unknown transaction survives restart and blocks a second order',async()=>{
  pendingTx=true;failSend=true;
  assert.equal((await client().trade(lastPlan)).state,'pending');assert.ok(memory.has(key));
  const restarted=client();await assert.rejects(()=>restarted.trade(lastPlan),/pending/);assert.equal(sends,1);
  pendingTx=false;account.positions[0].position=lastPlan.size;account.positions[0].sign=1;
  assert.equal((await restarted.reconcile()).state,'filled');assert.equal(sends,1);assert.equal(memory.has(key),false);
});
test('unavailable venue does not erase an unresolved journal record',async()=>{
  memory.set(key,JSON.stringify({hash:'test-hash',kind:'margin',accountIndex:100000,createdAt:Date.now()}));apiOffline=true;
  assert.equal((await client().reconcile()).state,'pending');assert.ok(memory.has(key));assert.equal(sends,0);
});
test('wallet, chain, quote and changed margin are checked before signing',async()=>{
  providerAccount='0x2222222222222222222222222222222222222222';await assert.rejects(()=>client().trade(lastPlan),/changed/);providerAccount=address;
  providerChain='0x1';await assert.rejects(()=>client().trade(lastPlan),/changed/);providerChain='0x1237';
  await assert.rejects(()=>client().trade({...lastPlan,expiresAt:Date.now()-1}),/expired/);
  account.positions[0].margin_mode=0;await assert.rejects(()=>client().trade(lastPlan),/Isolated/);assert.equal(signs,0);assert.equal(sends,0);
});
test('existing exposure and depleted collateral cannot reuse a reviewed open',async()=>{
  account.available_balance='1';await assert.rejects(()=>client().trade(lastPlan),/balance/);account.available_balance='28';
  account.positions[0].position='0.001';account.positions[0].sign=1;await assert.rejects(()=>client().trade(lastPlan),/Position changed/);assert.equal(signs,0);
});
test('storage failure stops before the network write',async()=>{
  (globalThis.localStorage as unknown as {setItem:()=>void}).setItem=()=>{throw new Error('Storage unavailable');};
  await assert.rejects(()=>client().trade(lastPlan),/Storage unavailable/);assert.equal(sends,0);
});
