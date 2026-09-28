import test from 'node:test';
import assert from 'node:assert/strict';
import {usdgAmount,receiptMinimum,exitMinimum} from '../strategy/neutral-quotes.js';

test('receipt floor includes entry fee and one percent execution movement',()=>{
  assert.equal(receiptMinimum(100_000_000n,0n,0n),97n*10n**18n);
  assert.equal(receiptMinimum(100_000_000n,98n*10n**18n,196_000_000n),485n*10n**17n);
  assert.throws(()=>receiptMinimum(100_000_000n,1n,null),/valuation/);
  assert.throws(()=>receiptMinimum(100_000_000n,1n,0n),/valuation/);
});
test('exit floor uses receipt ownership and does not double-charge entry',()=>{
  assert.equal(exitMinimum(49n*10n**18n,98n*10n**18n,98_000_000n),46_550_000n);
  assert.throws(()=>exitMinimum(1n,0n,1n),/valuation/);
  assert.throws(()=>exitMinimum(1n,1n,null),/valuation/);
});
test('cash amount parsing never rounds user precision or accepts scientific notation',()=>{
  assert.equal(usdgAmount('0.01'),10000n);
  assert.equal(usdgAmount('28.9'),28_900_000n);
  for(const invalid of ['1e6','1.0000001','-1','0.001','NaN',''])assert.throws(()=>usdgAmount(invalid));
});
