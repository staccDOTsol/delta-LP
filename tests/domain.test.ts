import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocate, buildQuote, multiply, simulate, valueVault, scenarioInput } from '../platform/domain.ts';

test('annual installments conserve every cent, including final rounding', () => {
  for (let litres = 300; litres < 15000; litres += 137) {
    const q = buildQuote(litres, 167, 23999);
    assert.equal(q.monthlyCents * 11 + q.finalPaymentCents, q.totalCents);
    assert.equal(q.totalCents, litres * 167 + 23999);
  }
});
test('integer allocation conserves total across many totals and unequal weights', () => {
  for (let n = 0; n < 20000; n += 17) {
    const a = allocate(n, [1000, 1300, 1600, 1600, 1400, 1000, 600, 300, 200, 200, 300, 500]);
    assert.equal(a.reduce((x, y) => x + y, 0), n);
    assert.ok(a.every(x => Number.isInteger(x) && x >= 0));
  }
});
test('unsafe monetary products are rejected', () => assert.throws(() => multiply(Number.MAX_SAFE_INTEGER, 2), /safe accounting/));
test('first-fill financing example is CAD 65,000 for 100 households', () => {
  const r = simulate({ households: 100, annualLitres: 2000, initialFillLitres: 600, unitPriceCents: 150, annualServiceCents: 0, capitalCents: 0, paymentFeeBps: 0, fundingAprBps: 0, monthlyOperatingCents: 0 });
  assert.equal(r.rows[0].fuelCents, 9000000); assert.equal(r.rows[0].receiptsCents, 2500000); assert.equal(r.rows[0].cashCents, -6500000);
  assert.equal(r.funded, false); assert.ok(r.additionalCapitalCents >= 6500000);
});
test('cash model conserves cash, inventory, and annual consumption', () => {
  for (let h = 1; h <= 100; h += 7) for (const shock of [-5000, 0, 3000, 10000]) {
    const r = simulate({ households: h, usageShockBps: shock });
    let cash = r.input.capitalCents, stock = 0;
    for (const row of r.rows) {
      cash += row.receiptsCents - row.fuelCents - row.expensesCents;
      stock += row.purchaseLitres - row.demandLitres;
      assert.equal(row.cashCents, cash); assert.equal(row.inventoryLitres, stock); assert.ok(stock >= 0);
      assert.ok(Number.isSafeInteger(cash));
    }
    assert.equal(r.rows.reduce((n, m) => n + m.demandLitres, 0), Math.round(2000 * (10000 + shock) / 10000) * h);
    assert.equal(r.endingCashCents, r.input.capitalCents + r.cashSurplusCents);
  }
});
test('zero collections never create income', () => assert.equal(simulate({ missedPaymentsBps: 10000 }).receiptsCents, 0));
test('price lock covers only its contracted volume', () => {
  const base = simulate({ supplierLockBps: 10000, usageShockBps: 0 });
  const locked = simulate({ supplierLockBps: 10000, priceShockBps: 10000 });
  const cold = simulate({ supplierLockBps: 10000, priceShockBps: 10000, usageShockBps: 3000 });
  assert.equal(base.procurementCents, locked.procurementCents);
  assert.equal(cold.procurementCents - locked.procurementCents, 600 * 300 * 25);
});
test('higher price and missed payments worsen unfunded cash needs', () => {
  const base = simulate({ capitalCents: 0 });
  assert.ok(simulate({ capitalCents: 0, priceShockBps: 10000 }).additionalCapitalCents > base.additionalCapitalCents);
  assert.ok(simulate({ capitalCents: 0, missedPaymentsBps: 5000 }).additionalCapitalCents > base.additionalCapitalCents);
});
test('more capital cannot increase additional required capital', () => {
  let previous = Infinity;
  for (let capitalCents = 0; capitalCents <= 5000000; capitalCents += 250000) {
    const r = simulate({ capitalCents }); assert.ok(r.additionalCapitalCents <= previous); previous = r.additionalCapitalCents;
  }
});
for (const invalid of [{ households: 0 }, { households: 1.1 }, { capitalCents: -1 }, { missedPaymentsBps: 10001 }, { priceShockBps: NaN }, { supplierLockBps: Infinity }, { inventedReturn: 10 }]) {
  test(`scenario rejects invalid input ${JSON.stringify(invalid)}`, () => assert.throws(() => scenarioInput.parse(invalid)));
}
const vault = { price: 200, referencePrice: 200, lower: 190, upper: 210, lpQuoteValue: 4000, collateral: 6000, debtBase: 10, idleQuote: 2000 };
test('CLMM inventory valued at reference price equals deposited LP value', () => {
  const r = valueVault(vault); assert.ok(Math.abs(r.base * 200 + r.quote - 4000) < 1e-8);
  assert.ok(Math.abs(r.nav - 10000) < 1e-8);
});
test('finite difference of NAV equals residual base delta', () => {
  for (const price of [180, 195, 200, 205, 220]) {
    const r = valueVault({ ...vault, price });
    const eps = 0.0001;
    const slope = (valueVault({ ...vault, price: price + eps }).nav - valueVault({ ...vault, price: price - eps }).nav) / (2 * eps);
    assert.ok(Math.abs(slope - r.deltaBase) < 1e-6);
  }
});
test('out-of-range inventory is entirely one asset', () => {
  const low = valueVault({ ...vault, price: 180 }), high = valueVault({ ...vault, price: 220 });
  assert.equal(low.quote, 0); assert.equal(high.base, 0); assert.equal(low.inRange, false); assert.equal(high.inRange, false);
});
test('matching borrow to base inventory removes first-order delta', () => {
  const r = valueVault(vault), hedged = valueVault({ ...vault, debtBase: r.base });
  assert.equal(hedged.deltaBase, 0); assert.equal(hedged.depositAllowed, true);
});
test('no debt has nullable health, and undercollateralization blocks deposits', () => {
  assert.equal(valueVault({ ...vault, debtBase: 0 }).health, null);
  assert.equal(valueVault({ ...vault, collateral: 100 }).depositAllowed, false);
});
test('inverted range and nonfinite prices are rejected', () => {
  assert.throws(() => valueVault({ ...vault, lower: 210, upper: 190 }));
  assert.throws(() => valueVault({ ...vault, price: Infinity }));
});
