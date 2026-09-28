import test from 'node:test';
import assert from 'node:assert/strict';
import {memberReport,memberPlan,type MemberSnapshot} from '../strategy/member-reconciliation.js';

const member:MemberSnapshot={custody:'0x0000000000000000000000000000000000000010',accountIndex:10,market:0,
  sizeDecimals:4,priceDecimals:2,short:false,leverage:3,cash:0n,supply:100n*10n**18n,redeemShares:0n,
  reportSequence:1n,requestedAction:1n,lastActionAt:1000n,priorityEnd:20n,executedPriorityCount:20n};
const account={index:10,l1_address:member.custody,account_type:0,account_trading_mode:0,available_balance:'100.000000',
  collateral:'100.000000',total_asset_value:'100.000000',transaction_time:1_000_000_000,total_order_count:0,pending_order_count:0,positions:[],
  assets:[{asset_id:3,symbol:'USDG',balance:'100',locked_balance:'0',margin_mode:'disabled',margin_balance:'0',multiplier:'1'}]};
const market={market_id:0,symbol:'ETH',status:'active',mark_price:'2500.00',min_base_amount:'0.0050',min_quote_amount:'10',
  supported_size_decimals:4,supported_price_decimals:2,min_initial_margin_fraction:200,default_initial_margin_fraction:5000,
  multiplier:'1',market_config:{force_reduce_only:false}};
const observation={fetchedAt:1_010_000,now:1_011_000,blockTimestamp:1010n,minimumTransactionTime:1_000_000_000,actionEvidenceVerified:true};
const position={market_id:0,symbol:'ETH',sign:1,position:'0.1200',initial_margin_fraction:'2.00',margin_mode:0,
  open_order_count:0,pending_order_count:0,position_tied_order_count:0,unrealized_pnl:'0',liquidation_price:'0'};

test('reports exact owned-account equity and rejects default 2x for a 3x target',()=>{
  const report=memberReport(member,account,market,observation);
  assert.equal(report.venueEquity,100_000_000n);
  assert.equal(report.initialMarginBps,5000);
  assert.equal(memberPlan(member,report,market).state,'blocked');
  const configured=memberReport(member,{...account,positions:[{...position,position:'0.0000',sign:0}]},market,observation);
  assert.equal(configured.initialMarginBps,200);
  const plan=memberPlan(member,configured,market);
  assert.equal(plan.state,'requires-order-review');
  assert.equal(plan.delta,1200n);
});
test('rejects wrong identity, unprocessed queue, missing action evidence and lagging account',()=>{
  assert.throws(()=>memberReport(member,{...account,index:11},market,observation),/identity/);
  assert.throws(()=>memberReport({...member,executedPriorityCount:19n},account,market,observation),/pending/);
  assert.throws(()=>memberReport(member,account,market,{...observation,actionEvidenceVerified:false}),/evidence/);
  assert.throws(()=>memberReport(member,account,market,{...observation,minimumTransactionTime:1_000_000_001}),/predates/);
});
test('refuses active or hidden foreign orders and foreign positions',()=>{
  assert.throws(()=>memberReport(member,{...account,total_order_count:1},market,observation),/Cancel/);
  assert.throws(()=>memberReport(member,{...account,positions:[{...position,pending_order_count:1}]},market,observation),/Cancel/);
  assert.throws(()=>memberReport(member,{...account,positions:[{...position,market_id:15}]},market,observation),/Foreign/);
});
test('foreign collateral cannot be counted as redeemable USDG backing',()=>{
  const foreign={asset_id:4,symbol:'WETH',balance:'1',locked_balance:'0',margin_mode:'disabled',margin_balance:'0',multiplier:'1'};
  assert.throws(()=>memberReport(member,{...account,assets:[...account.assets,foreign]},market,observation),/Foreign collateral/);
  assert.throws(()=>memberReport(member,{...account,assets:[]},market,observation),/identity/);
});
test('rejects stale observations, wrong market precision, direction and imprecise equity',()=>{
  assert.throws(()=>memberReport(member,account,market,{...observation,now:1_030_000}),/expired/);
  assert.throws(()=>memberReport(member,account,{...market,supported_size_decimals:3},observation),/configuration/);
  assert.throws(()=>memberReport(member,{...account,positions:[{...position,sign:-1}]},market,observation),/direction/);
  assert.throws(()=>memberReport(member,{...account,total_asset_value:'100.0000001'},market,observation),/precision/);
});
test('queued exits target an actual reduction and full exit targets zero',()=>{
  const held={...account,positions:[position]};
  const report=memberReport(member,held,market,observation);
  assert.equal(memberPlan(member,report,market).state,'balanced');
  const partial=memberPlan({...member,redeemShares:25n*10n**18n},report,market);
  assert.equal(partial.delta,-300n);
  const full=memberPlan({...member,redeemShares:member.supply},report,market);
  assert.equal(full.delta,-1200n);
  assert.equal(full.state,'requires-order-review');
});
test('reduction remains possible with a bad opening margin setting; dust is explicit',()=>{
  const report=memberReport(member,{...account,positions:[{...position,initial_margin_fraction:'50.00'}]},market,observation);
  assert.equal(memberPlan({...member,redeemShares:member.supply},report,market).state,'requires-order-review');
  const dust=memberPlan({...member,redeemShares:2n*10n**18n},report,market);
  assert.equal(dust.state,'blocked');
  assert.match('reason' in dust?dust.reason:'',/minimum/);
});
