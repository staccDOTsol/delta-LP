import test from 'node:test';
import assert from 'node:assert/strict';
import {formatUnits} from 'viem';
import {parseOperatorAmount,UNLIMITED_MEMBER_ASSETS} from '../keeper/launch-input.js';

test('operator amounts support large exact values, grouped commas and scientific notation',()=>{
  for(const value of ['1000000','1,000,000','1e6','10E+5','1,000e3','  +1000000.0000000  '])assert.equal(parseOperatorAmount(value,6),1_000_000_000_000n,value);
  assert.equal(parseOperatorAmount('9999999999999999999.999999',6),9_999_999_999_999_999_999_999_999n);
  assert.equal(parseOperatorAmount('1e30',6),10n**36n);
  for(const value of ['0.000001','1e-6','.1e-5'])assert.equal(parseOperatorAmount(value,6),1n,value);
  assert.equal(parseOperatorAmount('.000000000000000001',18),1n);
  assert.equal(parseOperatorAmount(formatUnits(UNLIMITED_MEMBER_ASSETS,6),6),UNLIMITED_MEMBER_ASSETS);
});
test('operator input never rounds, silently accepts malformed grouping or overflows',()=>{
  for(const value of ['','0','0e9999','-1','NaN','1,00','12,34,567','1.2,3','1_000','1e','1e1.5','0x123','1e9999','1e-9999','1.0000001','0.0000009',formatUnits(UNLIMITED_MEMBER_ASSETS+1n,6)]){
    assert.throws(()=>parseOperatorAmount(value,6),Error,value);
  }
  assert.throws(()=>parseOperatorAmount('1e-19',18),/exact/);
  assert.throws(()=>parseOperatorAmount('1',-1),/precision/);
});
test('unlimited is explicit and applies only to the capital cap',()=>{
  for(const value of ['unlimited','INF','Infinity','∞']){
    assert.equal(parseOperatorAmount(value,6,true),UNLIMITED_MEMBER_ASSETS);
    assert.throws(()=>parseOperatorAmount(value,6),/finite/);
    assert.throws(()=>parseOperatorAmount(value,18),/finite/);
  }
});
