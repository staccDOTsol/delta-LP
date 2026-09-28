import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../platform/store.ts';

function setup(t: TestContext, capital = 0, service = 24000) {
  const s = new Store(); t.after(() => s.close());
  const run = <T>(fn: () => T) => s.mutate('test', randomUUID(), {}, fn);
  const sub = run(() => {
    const h = s.createHousehold({ name: 'Test Household', email: 'test@example.test', postalCode: 'B3H 1A1', annualLitres: 2000, tankLitres: 900 });
    const q = s.createQuote({ householdId: h.id, unitPriceCents: 150, annualServiceCents: service });
    if (capital) s.addCapital(capital);
    return s.acceptQuote(q.id);
  });
  return { s, run, sub };
}
test('whole household lifecycle: payment, reserve, partial delivery, repayment, cancellation', t => {
  const { s, run, sub } = setup(t, 100000);
  run(() => s.recordPayment(sub.id, { period: 1 }));
  assert.equal(s.balance('cash'), 127000); assert.equal(s.balance('customer_credit', sub.id), -25000);
  const o = run(() => s.createOrder({ subscriptionId: sub.id, litres: 600 }));
  run(() => s.releaseOrder(o.id)); assert.equal(s.reservedCash(), 90000);
  run(() => s.completeOrder(o.id, 500));
  assert.equal(s.reservedCash(), 0); assert.equal(s.balance('cash'), 52000); assert.equal(s.balance('receivable', sub.id), 50000);
  run(() => s.recordPayment(sub.id, { period: 2 })); assert.equal(s.balance('receivable', sub.id), 25000);
  const cancelled = run(() => s.cancelSubscription(sub.id)); assert.equal(cancelled.outstandingCents, 25000);
  run(() => s.settleReceivable(sub.id, 25000)); assert.equal(s.balance('receivable', sub.id), 0);
  assert.equal(s.snapshot().ledger.balanced, true);
});
test('unfunded release is rejected without changing delivery state', t => {
  const { s, run, sub } = setup(t); const o = run(() => s.createOrder({ subscriptionId: sub.id, litres: 600 }));
  assert.throws(() => run(() => s.releaseOrder(o.id)), /capital/); assert.equal(s.getOrder(o.id).status, 'queued');
});
test('reserved cash cannot fund a second delivery', t => {
  const { s, run, sub } = setup(t, 100000);
  const one = run(() => s.createOrder({ subscriptionId: sub.id, litres: 600 }));
  const two = run(() => s.createOrder({ subscriptionId: sub.id, litres: 600 }));
  run(() => s.releaseOrder(one.id)); assert.throws(() => run(() => s.releaseOrder(two.id)), /capital/);
});
test('idempotent replay performs exactly one operation and rejects changed payload or scope', t => {
  const { s } = setup(t); const key = randomUUID();
  const a = s.mutate('capital', key, { cents: 100 }, () => s.addCapital(100));
  const b = s.mutate('capital', key, { cents: 100 }, () => s.addCapital(100));
  assert.deepEqual(a, b); assert.equal(s.balance('cash'), 100);
  assert.throws(() => s.mutate('capital', key, { cents: 200 }, () => s.addCapital(200)), /different input/);
  assert.throws(() => s.mutate('payment', key, { cents: 100 }, () => s.addCapital(100)), /different input/);
});
test('same installment cannot be charged twice with different keys', t => {
  const { s, run, sub } = setup(t); run(() => s.recordPayment(sub.id, { period: 1 }));
  assert.throws(() => run(() => s.recordPayment(sub.id, { period: 1 })), /already/);
  assert.equal(s.balance('cash'), 27000);
});
test('failed operations roll back journal, household, and idempotency record together', t => {
  const { s } = setup(t); const before = s.snapshot(); const key = randomUUID();
  assert.throws(() => s.mutate('test', key, {}, () => { s.addCapital(123); throw new Error('fail'); }));
  assert.deepEqual(s.snapshot(), before); assert.equal(s.one('SELECT * FROM requests WHERE key=?', key), undefined);
});
test('unbalanced and fractional journals are rejected and entries are immutable', t => {
  const { s, run } = setup(t, 100);
  assert.throws(() => run(() => s.post('bad', 'bad', [{ account: 'cash', debit: 10, credit: 0 }, { account: 'capital', debit: 0, credit: 9 }])), /balance/);
  assert.throws(() => run(() => s.post('bad2', 'bad', [{ account: 'cash', debit: 1.5, credit: 0 }, { account: 'capital', debit: 0, credit: 1.5 }])), /whole cents/);
  assert.throws(() => s.db.exec('UPDATE entries SET debit=2 WHERE debit>0'), /immutable/);
  assert.throws(() => s.db.exec('DELETE FROM journals'), /immutable/);
});
test('expired quote cannot activate and multiple active subscriptions are rejected', t => {
  const { s, run, sub } = setup(t);
  const q = run(() => s.createQuote({ householdId: sub.household_id, unitPriceCents: 150, annualServiceCents: 0 }));
  assert.throws(() => run(() => s.acceptQuote(q.id)), /active subscription/);
  s.now = () => new Date(Date.now() + 2 * 86400000);
  assert.throws(() => run(() => s.acceptQuote(q.id)), /expired/);
});
test('tank and annual allocation are enforced across pending orders', t => {
  const { s, run, sub } = setup(t);
  assert.throws(() => run(() => s.createOrder({ subscriptionId: sub.id, litres: 850 })), /capacity/);
  for (let i = 0; i < 3; i++) run(() => s.createOrder({ subscriptionId: sub.id, litres: 600 }));
  assert.throws(() => run(() => s.createOrder({ subscriptionId: sub.id, litres: 300 })), /remaining/);
});
test('partial fill releases unused annual allocation', t => {
  const { s, run, sub } = setup(t, 500000);
  const o = run(() => s.createOrder({ subscriptionId: sub.id, litres: 600 }));
  run(() => s.releaseOrder(o.id)); run(() => s.completeOrder(o.id, 100));
  for (let i = 0; i < 3; i++) run(() => s.createOrder({ subscriptionId: sub.id, litres: 600 }));
  run(() => s.createOrder({ subscriptionId: sub.id, litres: 100 }));
  assert.throws(() => run(() => s.createOrder({ subscriptionId: sub.id, litres: 50 })), /remaining/);
});
test('delivery transitions reject duplicate completion and overfill', t => {
  const { s, run, sub } = setup(t, 100000);
  const o = run(() => s.createOrder({ subscriptionId: sub.id, litres: 600 }));
  assert.throws(() => run(() => s.completeOrder(o.id, 600)), /released/);
  run(() => s.releaseOrder(o.id)); assert.throws(() => run(() => s.completeOrder(o.id, 601)), /cannot exceed/);
  run(() => s.completeOrder(o.id, 600)); assert.throws(() => run(() => s.completeOrder(o.id, 600)), /released/);
});
test('cancellation refunds only unused credit and blocks open supplier commitments', t => {
  const { s, run, sub } = setup(t, 100000);
  run(() => s.recordPayment(sub.id, { period: 1 }));
  const o = run(() => s.createOrder({ subscriptionId: sub.id, litres: 600 })); run(() => s.releaseOrder(o.id));
  assert.throws(() => run(() => s.cancelSubscription(sub.id)), /released deliveries/);
  run(() => s.cancelOrder(o.id)); const r = run(() => s.cancelSubscription(sub.id));
  assert.equal(r.refundCents, 25000); assert.equal(s.balance('cash'), 102000);
  assert.throws(() => run(() => s.recordPayment(sub.id, { period: 2 })), /Cancelled/);
});
test('full twelve-month billing conserves service revenue and refundable fuel credit', t => {
  const { s, run, sub } = setup(t, 0, 23999);
  for (let period = 1; period <= 12; period++) run(() => s.recordPayment(sub.id, { period }));
  assert.equal(s.balance('cash'), 323999); assert.equal(s.balance('service_revenue'), -23999); assert.equal(s.balance('customer_credit'), -300000);
  run(() => s.cancelSubscription(sub.id)); assert.equal(s.balance('cash'), 23999);
});
test('data and idempotency survive closing and reopening database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'delta-lp-')); const path = join(dir, 'db.sqlite'); const key = randomUUID();
  let s = new Store(path);
  try { s.mutate('capital', key, {}, () => s.addCapital(12500)); s.close(); s = new Store(path);
    s.mutate('capital', key, {}, () => s.addCapital(12500)); assert.equal(s.balance('cash'), 12500);
  } finally { s.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('seed is repeatable and all records are synthetic', t => { const s = new Store(); t.after(() => s.close()); s.seed(); s.seed(); assert.equal(s.snapshot().households.length, 3); assert.ok(s.snapshot().households.every(h => h.email.endsWith('.test'))); assert.ok(s.snapshot().ledger.balanced); });
