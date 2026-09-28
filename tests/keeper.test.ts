import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {keccak256,type Hex} from 'viem';
import {actionEvidence,emptyAccountReport,executableLimit,nextMemberAction,observedReport,type Snapshot,type Policy} from '../keeper/model.js';
import {Journal,recover,type JournalItem,type RecoveryPort} from '../keeper/journal.js';
import {observeMember} from '../keeper/observe.js';

const hash=`0x${'aa'.repeat(32)}` as Hex;
const m:Snapshot={id:1n,custody:'0x0000000000000000000000000000000000000010',accountIndex:10,mappedIndex:10,bound:true,
  market:0,sizeDecimals:4,priceDecimals:2,short:false,leverage:3,cash:0n,supply:100n*10n**18n,redeemShares:0n,
  reportSequence:1n,requestedAction:1n,confirmedAction:0n,lastActionAt:1000n,observedAt:1010n,priorityEnd:20n,executedPriorityCount:20n,
  enabled:true,nav:100_000_000n,position:0n,mark:2_500_000_000n,venueAvailable:100_000_000n,initialMarginBps:200,
  setup:{pending:false,publicKeyHash:hash,initialMarginBps:200,generation:1n},pendingWithdrawal:0n,custodyCash:0n,
  actions:[{nonce:1n,kind:0,amount:100_000_000n,hash,block:100n}],requests:[]};
const market={market_id:0,symbol:'ETH',status:'active',mark_price:'2500.00',min_base_amount:'0.0050',min_quote_amount:'10',
  supported_size_decimals:4,supported_price_decimals:2,min_initial_margin_fraction:200,default_initial_margin_fraction:5000,
  multiplier:'1',market_config:{force_reduce_only:false}};
const position={market_id:0,symbol:'ETH',sign:0,position:'0',initial_margin_fraction:'2.00',margin_mode:0,
  open_order_count:0,pending_order_count:0,position_tied_order_count:0,unrealized_pnl:'0',liquidation_price:'0'};
const account={index:10,l1_address:m.custody,account_type:0,account_trading_mode:0,available_balance:'100',collateral:'100',
  total_asset_value:'100',transaction_time:1_000_000_000,total_order_count:0,pending_order_count:0,positions:[position],
  assets:[{asset_id:3,symbol:'USDG',balance:'100',locked_balance:'0',margin_mode:'disabled',margin_balance:'0',multiplier:'1'}]};
const tx={code:200,hash:'venue-hash',account_index:10,l1_address:m.custody,status:2,transaction_time:1_000_000_000,event_info:'{}'};
const book={code:200,bids:[{price:'2499.99',remaining_base_amount:'1'}],asks:[{price:'2500.01',remaining_base_amount:'1'}]};
const proof=()=>new Map<string,unknown>([[hash,tx]]);
const report=()=>observedReport(m,account,market,undefined,proof(),1_010_000,1_011_000,1010n).report;
const policy:Policy={maxMemberAssets:200_000_000n,maxOrderNotional:10_000_000_000n,refreshSeconds:15,cancelAfterSeconds:5};

test('keeper bootstraps zero equity only for a provably unused L1 custody',()=>{
  const empty={...m,bound:false,mappedIndex:0,accountIndex:0,requestedAction:0n,confirmedAction:0n,priorityEnd:0n,position:0n};
  const r=emptyAccountReport(empty,market,1010n);assert.equal(r.venueEquity,0n);assert.equal(r.position,0n);
  for(const patch of [{mappedIndex:10},{requestedAction:1n},{priorityEnd:1n},{bound:true},{position:1n},{setup:{...m.setup,pending:true}}])assert.throws(()=>emptyAccountReport({...empty,...patch},market,1010n),/unused/);
});
test('keeper requires continuous action history, queue completion and exact venue identity',()=>{
  assert.equal(actionEvidence(m,proof()).minimumTransactionTime,1_000_000_000);
  assert.throws(()=>actionEvidence({...m,requestedAction:2n},proof()),/incomplete/);
  assert.throws(()=>actionEvidence({...m,executedPriorityCount:19n},proof()),/pending/);
  assert.throws(()=>actionEvidence(m,new Map([[hash,{...tx,account_index:11}]])),/identity/);
  assert.throws(()=>actionEvidence(m,new Map([[hash,{...tx,l1_address:'0x0000000000000000000000000000000000000011'}]])),/identity/);
  assert.throws(()=>actionEvidence(m,new Map([[hash,{...tx,status:1}]])),/executed/);
  assert.throws(()=>actionEvidence(m,new Map([[hash,{...tx,event_info:'{"ae":"rejected"}'}]])),/failed/);
});
test('collection never erases the preceding withdrawal execution watermark',()=>{
  const collected={...m,confirmedAction:2n,requestedAction:2n,actions:[{...m.actions[0],kind:1},{nonce:2n,kind:2,amount:100_000_000n,hash:`0x${'bb'.repeat(32)}` as Hex,block:101n}]};
  assert.equal(actionEvidence(collected,proof()).minimumTransactionTime,1_000_000_000);
  assert.throws(()=>actionEvidence({...collected,actions:[]},proof()),/anchor/);
});
test('order execution ACK cannot hide remaining orders or a lagging account snapshot',()=>{
  assert.throws(()=>observedReport(m,{...account,total_order_count:1},market,undefined,proof(),1_010_000,1_011_000,1010n),/Cancel/);
  assert.throws(()=>observedReport(m,{...account,transaction_time:999},market,undefined,proof(),1_010_000,1_011_000,1010n),/predates/);
  assert.throws(()=>observedReport(m,account,market,undefined,proof(),1_010_000,1_040_000,1010n),/expired/);
});
test('partial fill after cancellation reports its actual exposure, never requested size',()=>{
  const r=observedReport(m,{...account,positions:[{...position,position:'0.0600',sign:1}]},market,undefined,proof(),1_010_000,1_011_000,1010n).report;
  assert.equal(r.position,600n);
  const d=nextMemberAction(m,r,market,book,policy,1_011_000);
  assert.equal(d.state,'ready');if(d.state==='ready')assert.equal(d.call.name,'rebalance');
});
test('keeper requires depth, correct sorting and a bounded order notional',()=>{
  assert.equal(executableLimit(m,report(),market,book,1_000_000_000n),250250);
  assert.throws(()=>executableLimit(m,report(),market,{...book,asks:[{price:'2503',remaining_base_amount:'1'}]},1_000_000_000n),/depth/);
  assert.throws(()=>executableLimit(m,report(),market,{...book,asks:[{price:'2500.02',remaining_base_amount:'1'},{price:'2500.01',remaining_base_amount:'1'}]},1_000_000_000n),/Unsorted/);
  assert.throws(()=>executableLimit(m,report(),market,book,10_000_000n),/notional/);
});
test('cash funding uses only accounted member cash and respects configured capital',()=>{
  const funded={...m,cash:10_000_000n};
  const d=nextMemberAction(funded,report(),market,book,policy,1_011_000);
  assert.equal(d.state,'ready');if(d.state==='ready'){assert.equal(d.call.name,'fundVenue');assert.equal(d.call.args[1],10_000_000n);}
  assert.equal(nextMemberAction({...funded,nav:300_000_000n},report(),market,book,policy,1_011_000).state,'blocked');
});
test('capital breaches and pending deposits cannot starve long or short exposure reductions',()=>{
  const deposit={id:9n,member:1n,amount:250_000_000n,minimum:1n,createdAt:1000n,deadline:2000n,redeem:false,completed:false,batch:0n};
  for(const short of [false,true])for(const cap of [200_000_000n,400_000_000n]){
    const member={...m,short,nav:300_000_000n,cash:10_000_000n,requests:[deposit]};
    const r={...report(),venueEquity:290_000_000n,position:short?-4000n:4000n};
    const d=nextMemberAction(member,r,market,book,{...policy,maxMemberAssets:cap},1_011_000);
    assert.equal(d.state,'ready');
    if(d.state==='ready'){assert.equal(d.call.name,'rebalance');assert.equal(d.call.args[1],short?250250:249750);}
    const bounded=nextMemberAction(member,r,market,book,{...policy,maxMemberAssets:cap,maxOrderNotional:1n},1_011_000);
    assert.equal(bounded.state,'blocked');if(bounded.state==='blocked')assert.match(bounded.reason,/notional/);
    const shallow={...book,bids:[{price:'2499.99',remaining_base_amount:'0.001'}],asks:[{price:'2500.01',remaining_base_amount:'0.001'}]};
    const noDepth=nextMemberAction(member,r,market,shallow,{...policy,maxMemberAssets:cap},1_011_000);
    assert.equal(noDepth.state,'blocked');if(noDepth.state==='blocked')assert.match(noDepth.reason,/depth/);
  }
});
test('capital breaches still block exposure increases, including underweight partial exits',()=>{
  for(const short of [false,true]){
    const member={...m,short,nav:300_000_000n};
    const r={...report(),venueEquity:300_000_000n,position:short?-3400n:3400n};
    assert.equal(nextMemberAction(member,r,market,book,policy,1_011_000).state,'blocked');
    const shares=m.supply/2n;
    const exit={...member,redeemShares:shares,requests:[{id:10n,member:1n,amount:shares,minimum:1n,createdAt:1000n,deadline:2000n,redeem:true,completed:false,batch:0n}]};
    const d=nextMemberAction(exit,{...r,position:short?-1000n:1000n},market,book,policy,1_011_000);
    assert.equal(d.state,'blocked');if(d.state==='blocked')assert.match(d.reason,/increasing exposure/);
  }
});
test('queued full exit reduces first, withdraws second, then settles; over-budget exits remain possible',()=>{
  const exiting={...m,redeemShares:m.supply,requests:[{id:1n,member:1n,amount:m.supply,minimum:90_000_000n,createdAt:1000n,deadline:2000n,redeem:true,completed:false,batch:0n}]};
  const smallPolicy={...policy,maxMemberAssets:1n};
  const reduce=nextMemberAction(exiting,{...report(),position:1200n},market,book,smallPolicy,1_011_000);
  assert.equal(reduce.state,'ready');if(reduce.state==='ready')assert.equal(reduce.call.name,'rebalance');
  const withdraw=nextMemberAction(exiting,report(),market,book,smallPolicy,1_011_000);
  assert.equal(withdraw.state,'ready');if(withdraw.state==='ready')assert.equal(withdraw.call.name,'requestVenueWithdrawal');
  const settle=nextMemberAction({...exiting,cash:100_000_000n},report(),market,book,smallPolicy,1_011_000);
  assert.equal(settle.state,'ready');if(settle.state==='ready')assert.equal(settle.call.name,'settleRequest');
});
test('expired exits block new funding until the owner recovers them',()=>{
  const d=nextMemberAction({...m,cash:1_000_000n,redeemShares:1n},report(),market,book,policy,1_011_000);
  assert.equal(d.state,'blocked');if(d.state==='blocked')assert.match(d.reason,/expired/);
});

const item=():JournalItem=>({hash:keccak256('0x1234'),raw:'0x1234',nonce:4,expiresAt:2000,maxCost:'100',callId:hash,status:'prepared'});
const recovery=(changes:Partial<RecoveryPort>={}):RecoveryPort=>({receipt:async()=>null,transactionKnown:async()=>false,nonce:async()=>4,broadcast:async raw=>keccak256(raw),...changes});
test('journal persists reservations before send and counts uncertain transactions against budget',()=>{
  const dir=mkdtempSync(join(tmpdir(),'delta-keeper-'));
  try{const j=new Journal(dir,hash,hash);j.reserve(item(),100n);assert.equal(new Journal(dir,hash,hash).spent(),100n);
    assert.throws(()=>j.reserve({...item(),nonce:5,callId:`0x${'bb'.repeat(32)}`},100n),/budget/);
    assert.throws(()=>j.reserve(item(),1000n),/already/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('ambiguous send recovery only repeats identical signed bytes, never a new order',async()=>{
  const sent:Hex[]=[],i=item();
  await assert.rejects(recover(i,recovery({broadcast:async raw=>{sent.push(raw);throw new Error('timeout');}}),1000),/timeout/);
  assert.equal(await recover(i,recovery({broadcast:async raw=>{sent.push(raw);return keccak256(raw);}}),1000),'pending');
  assert.deepEqual(sent,['0x1234','0x1234']);
});
test('known pending hashes do not resend; nonce conflict and expired unknown hashes stop',async()=>{
  let sent=0;const port=recovery({broadcast:async raw=>{sent++;return keccak256(raw);}});
  assert.equal(await recover(item(),{...port,transactionKnown:async()=>true},1000),'pending');assert.equal(sent,0);
  await assert.rejects(recover(item(),{...port,nonce:async()=>5},1000),/nonce/);
  await assert.rejects(recover(item(),port,2001),/expired/);assert.equal(sent,0);
});
test('mined receipts determine success or revert and a disappeared receipt halts recovery',async()=>{
  const i=item();assert.equal(await recover(i,recovery({receipt:async()=>({success:false,block:10n,blockHash:hash,cost:75n})}),3000),'reverted');
  assert.equal(i.cost,'75');await assert.rejects(recover(i,recovery(),3000),/disappeared/);
});

test('keeper member lifecycle: report, fund, bind, trade, cancel remainder, reconcile, exit and pay',async()=>{
  const originalFetch=globalThis.fetch,originalNow=Date.now;
  const now=1_011_000;Date.now=()=>now;
  let apiAccount={...account},apiTx={...tx};
  globalThis.fetch=(async(input:RequestInfo|URL)=>{
    const url=String(input);
    if(url.includes('/account?'))return new Response(JSON.stringify({code:200,accounts:[apiAccount]}));
    if(url.includes('/txFromL1TxHash?'))return new Response(JSON.stringify(apiTx));
    throw new Error('Unexpected network call in keeper lifecycle test.');
  }) as typeof fetch;
  const data={market,book,fetchedAt:now};
  const decide=async(s:Snapshot)=>{
    const r=await observeMember(s,data,policy,1010n);
    return r.decision.state==='ready'?r.decision.call.name:r.decision.state;
  };
  try{
    const unused={...m,accountIndex:0,mappedIndex:0,bound:false,reportSequence:0n,requestedAction:0n,confirmedAction:0n,priorityEnd:0n,cash:100_000_000n,venueAvailable:0n,initialMarginBps:5000};
    assert.equal(await decide(unused),'reconcile');
    assert.equal(await decide({...unused,reportSequence:1n}),'fundVenue');
    assert.equal(await decide({...m,bound:false}),'bindAccount');
    assert.equal(await decide(m),'reconcile');
    const reconciled={...m,confirmedAction:1n};
    assert.equal(await decide(reconciled),'rebalance');
    const order={...m.actions[0],nonce:2n,kind:3,amount:1200n};
    apiAccount={...account,total_order_count:1};
    assert.equal(await decide({...m,requestedAction:2n,confirmedAction:1n,actions:[...m.actions,order]}),'cancelVenueOrders');
    apiAccount={...account,positions:[{...position,position:'0.0600',sign:1}]};
    assert.equal(await decide({...m,requestedAction:2n,confirmedAction:1n,actions:[...m.actions,order]}),'reconcile');
    apiAccount={...account,positions:[{...position,position:'0.1200',sign:1}]};
    const held={...m,confirmedAction:2n,requestedAction:2n,position:1200n,actions:[...m.actions,order]};
    assert.equal(await decide(held),'idle');
    const exit={...held,redeemShares:m.supply,requests:[{id:1n,member:1n,amount:m.supply,minimum:1n,createdAt:1000n,deadline:2000n,redeem:true,completed:false,batch:0n}]};
    assert.equal(await decide(exit),'rebalance');
    apiAccount={...account};
    assert.equal(await decide({...exit,position:0n}),'requestVenueWithdrawal');
    assert.equal(await decide({...exit,position:0n,pendingWithdrawal:100_000_000n}),'collectVenueWithdrawal');
    apiAccount={...account,total_asset_value:'0',available_balance:'0',collateral:'0',assets:[{...account.assets[0],balance:'0'}]};
    assert.equal(await decide({...exit,position:0n,cash:100_000_000n,venueAvailable:0n}),'settleRequest');
  }finally{globalThis.fetch=originalFetch;Date.now=originalNow;}
});
