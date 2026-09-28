import {test} from 'node:test';
import assert from 'node:assert/strict';
import {allocateNeutral,pairedExposure,pairedLeverageIllustration,redemption,type MemberSnapshot} from '../strategy/member-pairs.js';
const now=1_000_000,mark=2500_000000n;
const long:MemberSnapshot={group:'ETH',marketId:0,leverage:3,short:false,nav:100_000000n,supply:100n*10n**18n,positionTicks:1200n,sizeDecimals:4,observedAt:now,settled:true};
const short={...long,short:true,positionTicks:-1200n};
test('matched current exposures cancel for equally backed long/short pool reserves',()=>{
  const p=pairedExposure(long,short,10n**18n,10n**18n,mark,now);
  assert.equal(p.delta,0n);assert.equal(p.residualBps,0n);assert.equal(p.longLeverageBps,30_000n);assert.equal(p.value,2_000000n);
});
test('same leverage labels do not hide unfilled or drifted actual positions',()=>{
  const p=pairedExposure(long,{...short,positionTicks:-600n},10n**18n,10n**18n,mark,now);
  assert.equal(p.delta,1_500000n);assert.equal(p.shortLeverageBps,15_000n);assert.ok(p.residualBps!>0n);
  assert.throws(()=>pairedExposure(long,{...short,settled:false},1n,1n,mark,now),/pending/);
});
test('AMM inventory after a swap changes measured exposure and requires a new check',()=>{
  const p=pairedExposure(long,short,2n*10n**18n,10n**18n,mark,now);
  assert.equal(p.delta,3_000000n);assert.equal(p.residualBps,3333n);
});
test('proportional supply-and-balance adjustment alone leaves redemption and exposure unchanged',()=>{
  const before=pairedExposure(long,short,10n**18n,10n**18n,mark,now);
  const rebased=pairedExposure({...long,supply:long.supply*2n},short,2n*10n**18n,10n**18n,mark,now);
  assert.deepEqual(rebased,before);
  assert.deepEqual(redemption(10n,100n,100_000000n),redemption(20n,200n,100_000000n));
});
test('all configured tiers receive equal USDG on both legs with exact fee conservation',()=>{
  const p=allocateNeutral(60_000005n,[3,5,10]);assert.equal(p.remainder,5n);assert.equal(p.legs.length,6);
  for(const leg of p.legs){assert.equal(leg.gross,10_000000n);assert.equal(leg.fee,300000n);assert.equal(leg.backing,9_700000n);}
  assert.equal(p.legs.reduce((sum,l)=>sum+l.fee+l.backing,0n)+p.remainder,60_000005n);
  const all=allocateNeutral(100_000000n,Array.from({length:50},(_,i)=>i+1));assert.equal(all.legs.length,100);
});
test('insufficient funding cannot silently omit leverage tiers',()=>{
  assert.throws(()=>allocateNeutral(5_000000n,[3,5,10]),/every tier/);
  assert.throws(()=>allocateNeutral(10_000000n,[3,3]));
});
test('entry and exit costs leave 91.18 from a 100 deposit with no market PnL',()=>{
  const {legs}=allocateNeutral(100_000000n,[3]);
  const backing=legs.reduce((n,l)=>n+l.backing,0n);assert.equal(backing,97_000000n);
  assert.deepEqual(redemption(97n,97n,backing),{gross:97_000000n,fee:5_820000n,proceeds:91_180000n});
});
test('different underlying, leverage, directions, stale snapshots and overclaimed reserves fail',()=>{
  for(const patch of [{group:'BTC'},{marketId:1},{leverage:5},{short:false},{observedAt:now-60_001},{observedAt:now+1}])assert.throws(()=>pairedExposure(long,{...short,...patch},1n,1n,mark,now));
  assert.throws(()=>pairedExposure(long,short,long.supply+1n,1n,mark,now));
});
test('opposite leveraged NAVs amplify the relative price while fee-free AMM value falls',()=>{
  const p=pairedLeverageIllustration(10,1);
  assert.ok(Math.abs(p.relativePriceChangePct-22.2222222222)<1e-8);
  assert.equal(p.localRelativeVarianceMultiplier,400);
  assert.ok(Math.abs(p.feeFreePoolLossPct-0.5012562893)<1e-8);
  const flat=pairedLeverageIllustration(10,0);
  assert.equal(flat.relativePriceChangePct,0);assert.equal(flat.feeFreePoolLossPct,0);
});
test('opposite underlying moves give reciprocal ratios and the same pool-value loss',()=>{
  for(const leverage of [1,3,5,10,50]){
    const up=pairedLeverageIllustration(leverage,0.1),down=pairedLeverageIllustration(leverage,-0.1);
    assert.ok(Math.abs((1+up.relativePriceChangePct/100)*(1+down.relativePriceChangePct/100)-1)<1e-12);
    assert.equal(up.feeFreePoolLossPct,down.feeFreePoolLossPct);
  }
});
test('the amplification illustration rejects bankrupt legs and invalid inputs',()=>{
  for(const move of [10,-10,Infinity,NaN])assert.throws(()=>pairedLeverageIllustration(10,move));
  assert.throws(()=>pairedLeverageIllustration(0,1));
  assert.throws(()=>pairedLeverageIllustration(3.5,1));
});
