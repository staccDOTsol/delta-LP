import test,{beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {keccak256,type EIP1193Provider} from 'viem';
import {memberMarginPlan,memberSetupReport,registeredMemberKey,setupKeyMessage,venuePublicKey} from '../strategy/member-setup.js';
import {MemberSetupClient} from '../web/trading/member-setup.js';
import type {wasm} from '../web/trading/wasm.js';

const owner='0x0000000000000000000000000000000000000020',custody='0x0000000000000000000000000000000000000010';
const key=venuePublicKey('01'+'00'.repeat(39));
const setup={publicKeyHash:keccak256(key),initialMarginBps:200,generation:1n,pending:true};
const member={custody,accountIndex:10,market:0,sizeDecimals:4,priceDecimals:2,short:false,leverage:3,
  cash:0n,supply:100n*10n**18n,redeemShares:0n,reportSequence:1n,requestedAction:1n,lastActionAt:1000n,priorityEnd:20n,executedPriorityCount:20n};
const keys={code:200,api_keys:[{account_index:10,api_key_index:42,public_key:key}]};
const position={market_id:0,symbol:'ETH',sign:0,position:'0.0000',initial_margin_fraction:'2.00',margin_mode:0,
  open_order_count:0,pending_order_count:0,position_tied_order_count:0,unrealized_pnl:'0',liquidation_price:'0'};
const account={index:10,l1_address:custody,account_type:0,account_trading_mode:0,available_balance:'100',collateral:'100',
  total_asset_value:'100',transaction_time:1_000_000_000,total_order_count:0,pending_order_count:0,positions:[position],
  assets:[{asset_id:3,symbol:'USDG',balance:'100',locked_balance:'0',margin_mode:'disabled',margin_balance:'0',multiplier:'1'}]};
const market={market_id:0,symbol:'ETH',status:'active',mark_price:'2500',min_base_amount:'0.005',min_quote_amount:'10',
  supported_size_decimals:4,supported_price_decimals:2,min_initial_margin_fraction:200,default_initial_margin_fraction:5000,multiplier:'1',market_config:{force_reduce_only:false}};
const observation={fetchedAt:1_010_000,now:1_011_000,blockTimestamp:1010n,minimumTransactionTime:1_000_000_000,actionEvidenceVerified:true};

test('public key normalization validates canonical little-endian field elements',()=>{
  assert.equal(venuePublicKey(key.toUpperCase()),key);
  for(const input of ['00'.repeat(40),'ff'.repeat(8)+'00'.repeat(32),'01','xyz'])assert.throws(()=>venuePublicKey(input));
});
test('key registry rejects foreign accounts, duplicate slots and other privileged keys',()=>{
  assert.equal(registeredMemberKey(keys,10),key);
  assert.equal(registeredMemberKey({code:200,api_keys:[]},10),null);
  assert.throws(()=>registeredMemberKey(keys,11),/mismatch/);
  assert.throws(()=>registeredMemberKey({...keys,api_keys:[...keys.api_keys,...keys.api_keys]},10),/Duplicate/);
  assert.throws(()=>registeredMemberKey({...keys,api_keys:[...keys.api_keys,{account_index:10,api_key_index:3,public_key:key}]},10),/Unexpected/);
});
test('key derivation is scoped to controller, custody, owner, member, account and generation',()=>{
  const identity={controller:owner,custody,owner,member:1n,accountIndex:10,generation:1n};
  const message=setupKeyMessage(identity,'https://deltalp.fun');
  for(const [field,value] of Object.entries({controller:custody,custody:owner,owner:custody,member:2n,accountIndex:11,generation:2n}))assert.notEqual(setupKeyMessage({...identity,[field]:value},'https://deltalp.fun'),message);
  assert.notEqual(setupKeyMessage(identity,'https://example.com'),message);
  assert.match(message,/not a trade-only key/);
});
test('margin plan is bound to the registered key, empty position and supported market',()=>{
  assert.equal(memberMarginPlan(member,setup,account,market,keys).marginMode,0);
  assert.throws(()=>memberMarginPlan(member,setup,{...account,l1_address:owner},market,keys),/identity/);
  assert.throws(()=>memberMarginPlan(member,setup,{...account,positions:[{...position,sign:1,position:'0.1'}]},market,keys),/Close existing/);
  assert.throws(()=>memberMarginPlan(member,{...setup,initialMarginBps:100},account,market,keys),/Unsupported/);
  assert.throws(()=>memberMarginPlan(member,setup,account,market,{...keys,api_keys:[]}),/not registered/);
});
test('setup reports require actual margin row and correct mode, with queue and account evidence',()=>{
  const candidate=memberSetupReport(member,setup,account,market,keys,observation);
  assert.equal(candidate.observedKeyHash,setup.publicKeyHash);
  assert.equal(candidate.report.initialMarginBps,200);
  assert.throws(()=>memberSetupReport(member,{...setup,initialMarginBps:5000},{...account,positions:[]},market,keys,observation),/not confirmed/);
  assert.throws(()=>memberSetupReport(member,setup,{...account,positions:[{...position,margin_mode:1}]},market,keys,observation),/not confirmed/);
  assert.throws(()=>memberSetupReport({...member,executedPriorityCount:19n},setup,account,market,keys,observation),/pending/);
  assert.throws(()=>memberSetupReport(member,setup,account,market,keys,{...observation,actionEvidenceVerified:false}),/evidence/);
});
test('abandoned margin can reconcile the actual setting while still requiring the rotated key',()=>{
  assert.equal(memberSetupReport(member,{...setup,initialMarginBps:0},{...account,positions:[]},market,keys,observation).report.initialMarginBps,5000);
  assert.throws(()=>memberSetupReport(member,{...setup,initialMarginBps:0},account,market,{...keys,api_keys:[]},observation),/not registered/);
});

const originalFetch=globalThis.fetch;
const originalGlobals=new Map(['localStorage','navigator','location'].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
let memory:Map<string,string>,sends:number,txStatus:number,visibleMargin:string,wrongKey:boolean;
beforeEach(()=>{
  memory=new Map();sends=0;txStatus=2;visibleMargin='2.00';wrongKey=false;
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(k:string)=>memory.get(k)??null,setItem:(k:string,v:string)=>memory.set(k,v),removeItem:(k:string)=>memory.delete(k)}});
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(_key:unknown,_options:unknown,fn:()=>Promise<unknown>)=>fn()}}});
  Object.defineProperty(globalThis,'location',{configurable:true,value:{origin:'https://deltalp.fun'}});
  const response=(data:unknown)=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
  globalThis.fetch=async(input,options)=>{
    const url=new URL(String(input));
    if(url.pathname.endsWith('/apikeys')){assert.equal(url.searchParams.get('api_key_index'),'255');return response(wrongKey?{...keys,api_keys:[]}:keys);}
    if(url.pathname.endsWith('/account'))return response({code:200,accounts:[{...account,positions:[{...position,initial_margin_fraction:visibleMargin}]}]});
    if(url.pathname.endsWith('/orderBookDetails'))return response({code:200,order_book_details:[market]});
    if(url.pathname.endsWith('/nextNonce'))return response({code:200,nonce:7});
    if(url.pathname.endsWith('/sendTx')){
      assert.equal(memory.size,1);assert.equal((options?.body as FormData).get('tx_type'),'20');sends++;
      throw new TypeError('ambiguous transport failure after acceptance');
    }
    if(url.pathname.endsWith('/tx'))return response({code:200,hash:'test-margin',account_index:10,status:txStatus,event_info:'{}'});
    throw new Error(`Unexpected endpoint ${url.pathname}`);
  };
});
afterEach(()=>{globalThis.fetch=originalFetch;for(const [name,descriptor] of originalGlobals){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else Reflect.deleteProperty(globalThis,name);}});
const provider={request:async({method}:{method:string})=>{if(method==='eth_accounts')return [owner];if(method==='eth_chainId')return '0x1237';if(method==='personal_sign')return `0x${'11'.repeat(65)}`;throw new Error(`Unexpected wallet ${method}`);}} as EIP1193Provider;
const signer:typeof wasm=async<T>(name:`_${string}`,...args:unknown[])=>{
  if(name==='_createClient'){assert.equal(args[1],466324);assert.equal(args[2],10);assert.equal(args[4],42);return {pk:key} as T;}
  assert.equal(name,'_signUpdateLeverage');assert.deepEqual(args,[10,0,200,0,7]);return {txHash:'test-margin',txInfo:'test-signed-margin'} as T;
};
function browserClient(){const c=new MemberSetupClient(provider,owner,1n,signer);c.snapshot=async()=>({custody,accountIndex:10,market:0,leverage:3,setup,priorityProcessed:true});return c;}
test('ambiguous margin submission is journaled before send and a refresh reconciles without resending',async()=>{
  const c=browserClient();await c.configureMargin();assert.equal(sends,1);assert.ok(c.pending());
  await assert.rejects(()=>c.configureMargin(),/Reconcile/);
  assert.match(await browserClient().reconcile(),/Margin confirmed/);assert.equal(sends,1);assert.equal(memory.size,0);
});
test('executed transaction with unchanged margin remains pending across page reload',async()=>{
  await browserClient().configureMargin();visibleMargin='50.00';
  assert.match(await browserClient().reconcile(),/not yet confirmed/);assert.equal(memory.size,1);
  await assert.rejects(()=>browserClient().configureMargin(),/Reconcile/);assert.equal(sends,1);
});
test('rejected margin transaction clears only after a terminal venue failure is observed',async()=>{
  await browserClient().configureMargin();txStatus=1;
  assert.match(await browserClient().reconcile(),/pending/);assert.equal(memory.size,1);
  txStatus=0;assert.match(await browserClient().reconcile(),/failed/);assert.equal(memory.size,0);assert.equal(sends,1);
});
test('missing registered key stops margin configuration before any submission',async()=>{
  wrongKey=true;await assert.rejects(()=>browserClient().configureMargin(),/not registered/);assert.equal(sends,0);assert.equal(memory.size,0);
});
test('a superseded journal clears only after the replacement key has executed and is observed',async()=>{
  await browserClient().configureMargin();
  const c=browserClient();
  c.snapshot=async()=>({custody,accountIndex:10,market:0,leverage:3,setup:{...setup,generation:2n},priorityProcessed:false});
  assert.match(await c.reconcile(),/superseded/);assert.equal(memory.size,1);
  c.snapshot=async()=>({custody,accountIndex:10,market:0,leverage:3,setup:{...setup,generation:2n},priorityProcessed:true});
  assert.match(await c.reconcile(),/newer registered key/);assert.equal(memory.size,0);assert.equal(sends,1);
});
