import {test} from 'node:test';
import assert from 'node:assert/strict';
import {formatUnits} from 'viem';
import {accountSchema,availableUSDG,exactUnits,makePlan,marginBps,reconcileOrder,transactionState,type TradingAccount} from '../strategy/execution.js';
import type {Market} from '../strategy/lighter.js';

export const testAccount:TradingAccount={index:100000,l1_address:'0x1111111111111111111111111111111111111111',account_type:0,account_trading_mode:0,
  available_balance:'28.934330',collateral:'28.934330',total_order_count:0,pending_order_count:0,
  positions:[{market_id:0,symbol:'ETH',sign:0,position:'0.0000',initial_margin_fraction:'33.34',margin_mode:1,open_order_count:0,pending_order_count:0,position_tied_order_count:0,unrealized_pnl:'0',liquidation_price:'0'}]};
export const testMarket:Market={symbol:'ETH',id:0,active:true,mark:'2650.00',bid:'2649.99',ask:'2650.01',maxLeverage:50,minBase:'0.0050',minNotional:'10.000000',sizeDecimals:4,priceDecimals:2,maintenanceMarginBps:120,bidDepth10bps:1_000_000,askDepth10bps:1_000_000,observedAt:new Date().toISOString()};
export const request={symbol:'ETH',side:'long',leverage:3,collateral:'5',slippageBps:10} as const;
const fixture=()=>({account:structuredClone(testAccount),market:{...testMarket,observedAt:new Date().toISOString()}});

test('integer amount parser rejects rounding, scientific notation and non-finite inputs',()=>{
  assert.equal(exactUnits('0001.230000',6),1230000n);
  for(const value of ['NaN','Infinity','1e3','-1','0.0000001','1.2345678'])assert.throws(()=>exactUnits(value,6));
});
test('3x isolated margin rounds conservatively',()=>{assert.equal(marginBps(3),3334);assert.equal(marginBps(5),2000);assert.equal(marginBps(10),1000);});
test('all long/short leverage plans fit collateral after fee reserve',()=>{
  const {account,market}=fixture();
  for(const side of ['long','short'] as const)for(const leverage of [3,5,10] as const){
    const plan=makePlan({...request,side,leverage},market,account);
    assert.ok(Number(plan.notional)<5*leverage);
    assert.ok(BigInt(plan.baseTicks)>=50n);
    assert.equal(plan.reduceOnly,false);
    assert.ok(Number(plan.price)<=2650.01*1.001&&Number(plan.price)>=2649.99*.999);
  }
});
test('stale/future data, wrong market, closed market and excess leverage fail before signing',()=>{
  const {account,market}=fixture();
  for(const bad of [{...market,observedAt:new Date(Date.now()-11000).toISOString()},{...market,observedAt:new Date(Date.now()+1000).toISOString()},{...market,id:15},{...market,active:false},{...market,maxLeverage:2},{...market,bid:market.ask}])assert.throws(()=>makePlan(request,bad,account));
});
test('too little collateral, excess balance and outstanding orders fail before signing',()=>{
  const {account,market}=fixture();
  for(const collateral of ['0','1','29','0.0000001'])assert.throws(()=>makePlan({...request,collateral},market,account));
  assert.throws(()=>makePlan(request,market,{...account,total_order_count:1}));
  assert.throws(()=>makePlan(request,market,{...account,pending_order_count:1}));
  account.positions[0].position_tied_order_count=1;assert.throws(()=>makePlan(request,market,account));
});
test('new opens require a flat master account and verified collateral mode',()=>{
  const {account,market}=fixture();
  assert.throws(()=>makePlan(request,market,{...account,account_type:2}));
  assert.throws(()=>makePlan(request,market,{...account,account_trading_mode:1}));
  account.positions[0].position='0.0010';account.positions[0].sign=1;
  assert.throws(()=>makePlan(request,market,account));
});
test('newly funded Unified account plans isolated orders from confirmed USDG margin',()=>{
  const {account,market}=fixture();
  // Shape of the first-deposit account response, with no positions yet.
  const unified=accountSchema.parse({...account,account_trading_mode:1,positions:[],available_balance:'5.000000',collateral:'5.000000',assets:[
    {asset_id:3,symbol:'USDG',balance:'0.000000',locked_balance:'0.000000',margin_mode:'enabled',margin_balance:'5.000000',multiplier:'1.000000000000000000'},
  ]});
  for(const side of ['long','short'] as const)for(const leverage of [3,5,10] as const){
    const plan=makePlan({...request,side,leverage},market,unified);assert.ok(Number(plan.notional)<5*leverage);assert.equal(plan.reduceOnly,false);
  }
  assert.equal(availableUSDG(unified),5_000_000n);
  assert.equal(availableUSDG({...unified,available_balance:'10'}),5_000_000n);
  assert.equal(availableUSDG({...unified,available_balance:'4'}),4_000_000n);
});
test('Unified openings reject unknown, mixed, disabled or mismatched collateral',()=>{
  const {account,market}=fixture();
  const asset={asset_id:3,symbol:'USDG',margin_mode:'enabled',margin_balance:'5',multiplier:'1'};
  const unified={...account,account_trading_mode:1,assets:[asset]};
  for(const assets of [undefined,[],[asset,asset],[{...asset,symbol:'USDC'}],[{...asset,margin_mode:'disabled'}],[{...asset,multiplier:'1.01'}],[{...asset,margin_balance:'4'}],[asset,{...asset,asset_id:20,symbol:'SPY',margin_balance:'1'}],[asset,{...asset,asset_id:20,symbol:'SPY',margin_balance:'-1'}]]){
    assert.throws(()=>makePlan(request,market,{...unified,assets}));
  }
  assert.throws(()=>makePlan(request,market,{...unified,account_trading_mode:2}));
});
test('Unified reduce-only exits remain available with mixed collateral or negative equity',()=>{
  const {account,market}=fixture();account.account_trading_mode=1;account.available_balance='-1';account.collateral='-1';
  account.positions[0].position='0.0001';account.positions[0].sign=1;
  const plan=makePlan({...request,collateral:'0'},market,account,true);assert.equal(plan.reduceOnly,true);assert.equal(plan.side,'short');
});
test('close uses exact current size and reduce-only, including below opening minimum',()=>{
  for(const sign of [-1,1]){
    const {account,market}=fixture();account.positions[0].position='0.0001';account.positions[0].sign=sign;
    const plan=makePlan({...request,collateral:'0'},market,account,true);
    assert.equal(plan.baseTicks,'1');assert.equal(plan.reduceOnly,true);assert.equal(plan.side,sign===1?'short':'long');
  }
});
test('negative available equity blocks opening but does not block reducing risk',()=>{
  const {account,market}=fixture();account.available_balance='-0.50';account.collateral='-0.50';
  assert.throws(()=>makePlan(request,market,account),/Not enough/);
  account.positions[0].position='0.0050';account.positions[0].sign=-1;
  const plan=makePlan({...request,collateral:'0'},market,account,true);
  assert.equal(plan.reduceOnly,true);assert.equal(plan.side,'long');assert.equal(plan.baseTicks,'50');
});
function orderFixture(){
  const {account,market}=fixture(),plan=makePlan(request,market,account),clientOrderIndex=123;
  const order={owner_account_index:account.index,market_index:0,client_order_index:clientOrderIndex,order_index:456,initial_base_amount:plan.size,price:plan.price,is_ask:false,reduce_only:false,time_in_force:'immediate-or-cancel',status:'filled',filled_base_amount:plan.size,filled_quote_amount:formatUnits(BigInt(plan.baseTicks)*BigInt(plan.priceTicks),6)};
  return {account,plan,order,identity:{accountIndex:account.index,clientOrderIndex,plan}};
}
test('order acknowledgement or a fill with stale position is not success',()=>{
  const {identity,order,account}=orderFixture();
  assert.equal(reconcileOrder(identity,order,account).terminal,false);
  assert.throws(()=>reconcileOrder(identity,{tx_hash:'ack'},account));
});
test('complete fill requires matching position',()=>{
  const {identity,order,account}=orderFixture();account.positions[0].position=order.filled_base_amount;account.positions[0].sign=1;
  assert.equal(reconcileOrder(identity,order,account).state,'filled');
});
test('canceled remainder preserves a partial fill and reports residual exposure',()=>{
  const {identity,order,account}=orderFixture();order.status='canceled-not-enough-liquidity';order.filled_base_amount='0.0020';order.filled_quote_amount='5.3';account.positions[0].position='0.0020';account.positions[0].sign=1;
  const result=reconcileOrder(identity,order,account);assert.equal(result.state,'partial');assert.equal(result.position,'0.002');
});
test('zero-fill cancel is terminal only when account position still matches',()=>{
  const {identity,order,account}=orderFixture();order.status='canceled';order.filled_base_amount='0';order.filled_quote_amount='0';
  assert.equal(reconcileOrder(identity,order,account).state,'canceled');account.positions[0].position='0.001';account.positions[0].sign=1;
  assert.equal(reconcileOrder(identity,order,account).terminal,false);
});
test('mismatched account, market, direction, IDs and quantities cannot confirm execution',()=>{
  const {identity,order,account}=orderFixture();
  for(const patch of [{owner_account_index:99},{market_index:15},{client_order_index:124},{is_ask:true},{reduce_only:true},{initial_base_amount:'0.1'},{price:'1'},{filled_base_amount:'1'},{time_in_force:'good-till-time'},{filled_quote_amount:'100'}])assert.throws(()=>reconcileOrder(identity,{...order,...patch},account));
});
test('transaction status requires exact identity and recognizes execution errors',()=>{
  const tx={hash:'hash',account_index:100000,status:1,event_info:'{}'};
  assert.equal(transactionState(tx,'hash',100000),'pending');assert.equal(transactionState({...tx,status:2},'hash',100000),'executed');
  assert.equal(transactionState({...tx,status:0},'hash',100000),'failed');assert.equal(transactionState({...tx,status:2,event_info:'{"ae":"rejected"}'},'hash',100000),'failed');
  assert.throws(()=>transactionState(tx,'other',100000));assert.throws(()=>transactionState(tx,'hash',999));
});
