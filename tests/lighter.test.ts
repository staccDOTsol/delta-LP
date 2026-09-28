import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sizeOrder,type Market} from '../strategy/lighter.ts';
const now=Date.parse('2026-09-28T04:00:00Z');
const market:Market={symbol:'ETH',id:0,active:true,mark:'2652.00',bid:'2651.94',ask:'2652.06',maxLeverage:50,minBase:'0.0050',minNotional:'10.000000',sizeDecimals:4,priceDecimals:2,maintenanceMarginBps:120,bidDepth10bps:10000,askDepth10bps:10000,observedAt:new Date(now).toISOString()};
const input={symbol:'ETH',side:'long',leverage:3,collateral:'25.00'};
test('order sizing rounds down and remains an explicitly non-executable estimate',()=>{
  const quote=sizeOrder(input,market,now);
  assert.equal(quote.baseAmount,'0.0282');assert.equal(quote.limitPrice,'2654.72');
  assert.ok(Number(quote.estimatedNotional)<=75);assert.equal(quote.executable,false);
});
test('short and long estimates apply opposite price bounds',()=>{
  const long=sizeOrder(input,market,now),short=sizeOrder({...input,side:'short'},market,now);
  assert.ok(Number(long.limitPrice)>Number(market.ask));assert.ok(Number(short.limitPrice)<Number(market.bid));
  assert.equal(short.baseAmount,long.baseAmount);
});
test('venue minimum and unsupported leverage are enforced',()=>{
  assert.throws(()=>sizeOrder({...input,collateral:'0.034775'},market,now),/minimum/);
  assert.throws(()=>sizeOrder({...input,leverage:100},market,now));
  assert.throws(()=>sizeOrder({...input,leverage:10},{...market,maxLeverage:5},now),/unavailable/);
});
test('invalid or stale data cannot produce an estimate',()=>{
  for(const update of [{active:false},{id:15},{observedAt:'invalid'},{observedAt:new Date(now-21000).toISOString()},{bid:'2653.00'},{askDepth10bps:1}])assert.throws(()=>sizeOrder(input,{...market,...update},now));
});
test('nonfinite, negative, excessive precision, and oversize collateral are rejected',()=>{
  for(const collateral of ['NaN','Infinity','-1','0','0.1234567','100000000000000000000'])assert.throws(()=>sizeOrder({...input,collateral},market,now));
});
