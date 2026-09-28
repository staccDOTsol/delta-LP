import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Store } from '../platform/store.ts';
import { createApp } from '../platform/api.ts';
const setup = async (t: TestContext) => { const store = new Store(); const server = createServer(createApp(store)); server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); store.close(); }); return { store, api: request(server) }; };
test('HTTP lifecycle persists payment, partial delivery, statement and CSV', async t => {
  const { api } = await setup(t); const post = (url: string, body = {}) => api.post(url).set('Idempotency-Key', randomUUID()).send(body).expect(200);
  const h = await post('/api/households', { name: 'HTTP Tester', email: 'http@example.test', postalCode: 'B3H 1A1', annualLitres: 2000, tankLitres: 900 });
  const q = await post('/api/quotes', { householdId: h.body.id, unitPriceCents: 150, annualServiceCents: 24000 });
  const s = await post(`/api/quotes/${q.body.id}/accept`);
  await post('/api/capital', { cents: 100000 }); await post(`/api/subscriptions/${s.body.id}/payments`, { period: 1 });
  const o = await post('/api/orders', { subscriptionId: s.body.id, litres: 600 });
  await post(`/api/orders/${o.body.id}/release`); await post(`/api/orders/${o.body.id}/complete`, { litres: 550 });
  const statement = await api.get(`/api/subscriptions/${s.body.id}/statement`).expect(200);
  assert.equal(statement.body.outstandingCents, 57500);
  const csv = await api.get('/api/export/ledger.csv').expect(200); assert.match(csv.text, /fuel_revenue/);
  const state = await api.get('/api/state').expect(200); assert.equal(state.body.ledger.balanced, true); assert.equal(state.body.orders[0].delivered_litres, 550);
});
test('parallel duplicate HTTP requests yield a single committed mutation', async t => {
  const { api, store } = await setup(t); const key = randomUUID();
  const results = await Promise.all(Array.from({ length: 10 }, () => api.post('/api/capital').set('Idempotency-Key', key).send({ cents: 12345 }).expect(200)));
  assert.ok(results.every(r => r.body.id === results[0].body.id)); assert.equal(store.balance('cash'), 12345);
});
test('missing keys, malformed payloads, and unknown routes fail explicitly', async t => {
  const { api } = await setup(t);
  await api.post('/api/capital').send({ cents: 100 }).expect(400);
  await api.post('/api/capital').set('Idempotency-Key', randomUUID()).send({ cents: -1 }).expect(400);
  await api.post('/api/simulate').send({ households: '25' }).expect(400);
  await api.post('/api/simulate').set('Content-Type', 'application/json').send('{').expect(400);
  await api.get('/api/missing').expect(404);
});
test('sandbox declines foreign hosts, cross-site requests and mismatched origins', async t => {
  const { api, store } = await setup(t);
  await api.get('/api/state').set('Host', 'external.example').expect(403);
  await api.post('/api/capital').set('Idempotency-Key', randomUUID()).set('Origin', 'https://external.example').send({ cents: 123 }).expect(403);
  await api.get('/api/state').set('Sec-Fetch-Site', 'cross-site').expect(403);
  assert.equal(store.balance('cash'), 0);
});
test('simulation endpoints stay read-only and report sandbox status', async t => {
  const { api, store } = await setup(t);
  const r = await api.post('/api/simulate').send({ households: 25 }).expect(200); assert.equal(r.body.rows.length, 12);
  const health = await api.get('/api/health').expect(200); assert.equal(health.body.livePayments, false); assert.equal(health.body.liveTrading, false);
  assert.equal(store.snapshot().ledger.journals.length, 0);
});
