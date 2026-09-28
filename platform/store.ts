import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildQuote, DomainError, householdInput, multiply, orderInput, paymentInput, quoteInput, requireThat, type QuoteTerms } from './domain.ts';

export type Household = { id: string; name: string; email: string; postal_code: string; annual_litres: number; tank_litres: number; created_at: string };
export type Subscription = { id: string; household_id: string; quote_id: string; status: 'active' | 'cancelled'; created_at: string; terms: QuoteTerms };
export type Order = { id: string; subscription_id: string; litres: number; delivered_litres: number; status: 'queued' | 'released' | 'delivered' | 'cancelled'; unit_price_cents: number; cost_cents: number; created_at: string; updated_at: string };
type Line = { account: string; debit: number; credit: number; subscriptionId?: string };
const canonical = (value: unknown): string => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);

export class Store {
  db: DatabaseSync;
  now: () => Date;
  constructor(path = ':memory:', now = () => new Date()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path); this.now = now;
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS households(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL,postal_code TEXT NOT NULL,annual_litres INTEGER NOT NULL,tank_litres INTEGER NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS quotes(id TEXT PRIMARY KEY,household_id TEXT NOT NULL REFERENCES households(id),terms TEXT NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS subscriptions(id TEXT PRIMARY KEY,household_id TEXT NOT NULL REFERENCES households(id),quote_id TEXT NOT NULL UNIQUE REFERENCES quotes(id),status TEXT NOT NULL CHECK(status IN ('active','cancelled')),created_at TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_subscription ON subscriptions(household_id) WHERE status='active';
      CREATE TABLE IF NOT EXISTS payments(id TEXT PRIMARY KEY,subscription_id TEXT NOT NULL REFERENCES subscriptions(id),period INTEGER NOT NULL CHECK(period BETWEEN 1 AND 12),amount_cents INTEGER NOT NULL CHECK(amount_cents>0),created_at TEXT NOT NULL,UNIQUE(subscription_id,period));
      CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,subscription_id TEXT NOT NULL REFERENCES subscriptions(id),litres INTEGER NOT NULL CHECK(litres>0),delivered_litres INTEGER NOT NULL DEFAULT 0 CHECK(delivered_litres>=0 AND delivered_litres<=litres),status TEXT NOT NULL CHECK(status IN ('queued','released','delivered','cancelled')),unit_price_cents INTEGER NOT NULL CHECK(unit_price_cents>0),cost_cents INTEGER NOT NULL CHECK(cost_cents>0),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS journals(id TEXT PRIMARY KEY,reference TEXT NOT NULL UNIQUE,description TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS entries(id INTEGER PRIMARY KEY,journal_id TEXT NOT NULL REFERENCES journals(id),account TEXT NOT NULL,subscription_id TEXT REFERENCES subscriptions(id),debit INTEGER NOT NULL CHECK(debit>=0),credit INTEGER NOT NULL CHECK(credit>=0),CHECK((debit>0 AND credit=0) OR (credit>0 AND debit=0)));
      CREATE TABLE IF NOT EXISTS requests(key TEXT PRIMARY KEY,scope TEXT NOT NULL,hash TEXT NOT NULL,response TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,action TEXT NOT NULL,entity_id TEXT NOT NULL,detail TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS entries_no_update BEFORE UPDATE ON entries BEGIN SELECT RAISE(ABORT,'Journal entries are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS entries_no_delete BEFORE DELETE ON entries BEGIN SELECT RAISE(ABORT,'Journal entries are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS journals_no_update BEFORE UPDATE ON journals BEGIN SELECT RAISE(ABORT,'Journals are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS journals_no_delete BEFORE DELETE ON journals BEGIN SELECT RAISE(ABORT,'Journals are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS quotes_no_update BEFORE UPDATE ON quotes BEGIN SELECT RAISE(ABORT,'Quote versions are immutable'); END;
    `);
  }
  close() { this.db.close(); }
  time() { return this.now().toISOString(); }
  one<T>(sql: string, ...args: (string | number)[]): T | undefined { return this.db.prepare(sql).get(...args) as T | undefined; }
  all<T>(sql: string, ...args: (string | number)[]): T[] { return this.db.prepare(sql).all(...args) as T[]; }
  exec(sql: string, ...args: (string | number | null)[]) { return this.db.prepare(sql).run(...args); }
  audit(action: string, id: string, detail: unknown = {}) { this.exec('INSERT INTO audit(action,entity_id,detail,created_at) VALUES(?,?,?,?)', action, id, JSON.stringify(detail), this.time()); }
  mutate<T>(scope: string, key: string, payload: unknown, run: () => T): T {
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(key)) throw new DomainError('IDEMPOTENCY_REQUIRED', 'Supply an 8–128 character Idempotency-Key.', 400);
    const hash = createHash('sha256').update(canonical(payload)).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.one<{ scope: string; hash: string; response: string }>('SELECT * FROM requests WHERE key=?', key);
      if (prior) {
        requireThat(prior.scope === scope && prior.hash === hash, 'IDEMPOTENCY_CONFLICT', 'That request key was already used with different input.');
        this.db.exec('COMMIT'); return JSON.parse(prior.response) as T;
      }
      const result = run();
      this.exec('INSERT INTO requests VALUES(?,?,?,?,?)', key, scope, hash, JSON.stringify(result), this.time());
      this.db.exec('COMMIT'); return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  post(reference: string, description: string, lines: Line[]) {
    const nonzero = lines.filter(l => l.debit !== 0 || l.credit !== 0);
    requireThat(nonzero.length >= 2 && nonzero.every(l => Number.isSafeInteger(l.debit) && Number.isSafeInteger(l.credit) && l.debit >= 0 && l.credit >= 0 && ((l.debit > 0) !== (l.credit > 0))), 'INVALID_JOURNAL', 'Journal amounts must be positive whole cents on exactly one side.');
    const debits = nonzero.reduce((s, l) => s + l.debit, 0), credits = nonzero.reduce((s, l) => s + l.credit, 0);
    requireThat(Number.isSafeInteger(debits) && Number.isSafeInteger(credits) && debits === credits, 'UNBALANCED_JOURNAL', 'Every journal must balance in CAD cents.');
    const id = randomUUID();
    this.exec('INSERT INTO journals VALUES(?,?,?,?)', id, reference, description, this.time());
    for (const l of nonzero) this.exec('INSERT INTO entries(journal_id,account,subscription_id,debit,credit) VALUES(?,?,?,?,?)', id, l.account, l.subscriptionId ?? null, l.debit, l.credit);
    return id;
  }
  balance(account: string, subId?: string) {
    return this.one<{ amount: number }>(`SELECT COALESCE(SUM(debit-credit),0) amount FROM entries WHERE account=?${subId ? ' AND subscription_id=?' : ''}`, ...[account, ...(subId ? [subId] : [])])!.amount;
  }
  reservedCash() { return this.one<{ amount: number }>("SELECT COALESCE(SUM(cost_cents),0) amount FROM orders WHERE status='released'")!.amount; }
  availableCash() { return this.balance('cash') - this.reservedCash(); }
  getHousehold(id: string) { const h = this.one<Household>('SELECT * FROM households WHERE id=?', id); if (!h) throw new DomainError('NOT_FOUND', 'Household not found.', 404); return h; }
  getSubscription(id: string): Subscription {
    const row = this.one<Omit<Subscription, 'terms'> & { terms: string }>('SELECT s.*,q.terms FROM subscriptions s JOIN quotes q ON q.id=s.quote_id WHERE s.id=?', id);
    if (!row) throw new DomainError('NOT_FOUND', 'Subscription not found.', 404);
    return { ...row, terms: JSON.parse(row.terms) };
  }
  getOrder(id: string) { const row = this.one<Order>('SELECT * FROM orders WHERE id=?', id); if (!row) throw new DomainError('NOT_FOUND', 'Delivery not found.', 404); return row; }
  createHousehold(raw: unknown) {
    const h = householdInput.parse(raw), id = randomUUID();
    this.exec('INSERT INTO households VALUES(?,?,?,?,?,?,?)', id, h.name, h.email.toLowerCase(), h.postalCode, h.annualLitres, h.tankLitres, this.time());
    this.audit('household.created', id); return this.getHousehold(id);
  }
  createQuote(raw: unknown) {
    const q = quoteInput.parse(raw), h = this.getHousehold(q.householdId), id = randomUUID();
    const terms = buildQuote(h.annual_litres, q.unitPriceCents, q.annualServiceCents);
    const expiresAt = new Date(this.now().getTime() + 86400000).toISOString();
    this.exec('INSERT INTO quotes VALUES(?,?,?,?,?)', id, h.id, JSON.stringify(terms), expiresAt, this.time());
    this.audit('quote.created', id); return { id, householdId: h.id, terms, expiresAt };
  }
  acceptQuote(id: string) {
    const q = this.one<{ household_id: string; expires_at: string }>('SELECT * FROM quotes WHERE id=?', id);
    if (!q) throw new DomainError('NOT_FOUND', 'Quote not found.', 404);
    requireThat(q.expires_at > this.time(), 'QUOTE_EXPIRED', 'This quote expired. Create a new quote.');
    requireThat(!this.one('SELECT id FROM subscriptions WHERE quote_id=?', id), 'QUOTE_USED', 'This quote has already been accepted.');
    requireThat(!this.one("SELECT id FROM subscriptions WHERE household_id=? AND status='active'", q.household_id), 'ACTIVE_SUBSCRIPTION', 'This household already has an active subscription.');
    const subId = randomUUID(); this.exec('INSERT INTO subscriptions VALUES(?,?,?,?,?)', subId, q.household_id, id, 'active', this.time());
    this.audit('subscription.activated', subId); return this.getSubscription(subId);
  }
  recordPayment(id: string, raw: unknown) {
    const { period } = paymentInput.parse(raw), s = this.getSubscription(id);
    requireThat(s.status === 'active', 'INACTIVE_SUBSCRIPTION', 'Cancelled subscriptions cannot receive scheduled payments.');
    requireThat(!this.one('SELECT id FROM payments WHERE subscription_id=? AND period=?', id, period), 'PAYMENT_EXISTS', 'This installment has already been settled.');
    const amount = period === 12 ? s.terms.finalPaymentCents : s.terms.monthlyCents;
    const paymentId = randomUUID();
    const receivable = Math.min(amount, Math.max(0, this.balance('receivable', id)));
    this.post(`payment:${paymentId}`, `Installment ${period} · sandbox settlement`, [
      { account: 'cash', debit: amount, credit: 0 },
      { account: 'receivable', subscriptionId: id, debit: 0, credit: receivable },
      { account: 'customer_credit', subscriptionId: id, debit: 0, credit: amount - receivable },
    ]);
    this.exec('INSERT INTO payments VALUES(?,?,?,?,?)', paymentId, id, period, amount, this.time());
    const service = period === 12 ? s.terms.annualServiceCents - Math.floor(s.terms.annualServiceCents / 12) * 11 : Math.floor(s.terms.annualServiceCents / 12);
    if (service > 0) {
      const credit = Math.min(service, Math.max(0, -this.balance('customer_credit', id)));
      this.post(`service:${paymentId}`, `Service for installment ${period}`, [
        { account: 'customer_credit', subscriptionId: id, debit: credit, credit: 0 },
        { account: 'receivable', subscriptionId: id, debit: service - credit, credit: 0 },
        { account: 'service_revenue', subscriptionId: id, debit: 0, credit: service },
      ]);
    }
    this.audit('payment.settled', paymentId, { mode: 'sandbox' }); return { id: paymentId, amountCents: amount, period };
  }
  addCapital(cents: number) {
    requireThat(Number.isSafeInteger(cents) && cents > 0 && cents <= 100000000, 'INVALID_AMOUNT', 'Capital must be between 1 and 100,000,000 cents.');
    const id = randomUUID(); this.post(`capital:${id}`, 'Sandbox capital contribution', [{ account: 'cash', debit: cents, credit: 0 }, { account: 'capital', debit: 0, credit: cents }]);
    this.audit('capital.added', id, { cents }); return { id, amountCents: cents };
  }
  createOrder(raw: unknown) {
    const v = orderInput.parse(raw), s = this.getSubscription(v.subscriptionId), h = this.getHousehold(s.household_id);
    requireThat(s.status === 'active', 'INACTIVE_SUBSCRIPTION', 'Subscription is not active.');
    requireThat(v.litres <= Math.floor(h.tank_litres * 0.9), 'TANK_CAPACITY', 'Order exceeds 90% of tank capacity. Supplier must confirm available space.');
    const committed = this.one<{ n: number }>("SELECT COALESCE(SUM(CASE WHEN status='delivered' THEN delivered_litres ELSE litres END),0) n FROM orders WHERE subscription_id=? AND status!='cancelled'", s.id)!.n;
    requireThat(committed + v.litres <= s.terms.annualLitres, 'VOLUME_LIMIT', 'Order exceeds remaining covered litres.');
    const id = randomUUID(), cost = multiply(v.litres, s.terms.unitPriceCents);
    this.exec('INSERT INTO orders VALUES(?,?,?,?,?,?,?,?,?)', id, s.id, v.litres, 0, 'queued', s.terms.unitPriceCents, cost, this.time(), this.time());
    this.audit('delivery.queued', id); return this.getOrder(id);
  }
  releaseOrder(id: string) {
    const o = this.getOrder(id); requireThat(o.status === 'queued', 'ORDER_STATE', 'Only queued deliveries can be released.');
    requireThat(this.getSubscription(o.subscription_id).status === 'active', 'INACTIVE_SUBSCRIPTION', 'Subscription is not active.');
    requireThat(this.availableCash() >= o.cost_cents, 'INSUFFICIENT_CAPITAL', 'Add committed sandbox capital before releasing this delivery.');
    this.exec("UPDATE orders SET status='released',updated_at=? WHERE id=?", this.time(), id);
    this.audit('delivery.released', id, { reservedCents: o.cost_cents, adapter: 'sandbox' }); return this.getOrder(id);
  }
  completeOrder(id: string, deliveredLitres: number) {
    const o = this.getOrder(id); requireThat(o.status === 'released', 'ORDER_STATE', 'Only released deliveries can be completed.');
    requireThat(Number.isSafeInteger(deliveredLitres) && deliveredLitres > 0 && deliveredLitres <= o.litres, 'DELIVERY_QUANTITY', 'Delivered quantity must be positive and cannot exceed the order.');
    const cost = multiply(deliveredLitres, o.unit_price_cents);
    requireThat(this.balance('cash') >= cost, 'INSUFFICIENT_CAPITAL', 'Insufficient settled cash for this invoice.');
    const creditUsed = Math.min(cost, Math.max(0, -this.balance('customer_credit', o.subscription_id)));
    this.post(`invoice:${id}`, `Fuel invoice · ${deliveredLitres} L`, [
      { account: 'fuel_cost', debit: cost, credit: 0 }, { account: 'cash', debit: 0, credit: cost },
      { account: 'customer_credit', subscriptionId: o.subscription_id, debit: creditUsed, credit: 0 },
      { account: 'receivable', subscriptionId: o.subscription_id, debit: cost - creditUsed, credit: 0 },
      { account: 'fuel_revenue', subscriptionId: o.subscription_id, debit: 0, credit: cost },
    ]);
    this.exec("UPDATE orders SET status='delivered',delivered_litres=?,cost_cents=?,updated_at=? WHERE id=?", deliveredLitres, cost, this.time(), id);
    this.audit('delivery.completed', id, { deliveredLitres, cost }); return this.getOrder(id);
  }
  cancelOrder(id: string) {
    const o = this.getOrder(id); requireThat(o.status === 'queued' || o.status === 'released', 'ORDER_STATE', 'This delivery is already final.');
    this.exec("UPDATE orders SET status='cancelled',updated_at=? WHERE id=?", this.time(), id);
    this.audit('delivery.cancelled', id, { supplierCancellation: 'sandbox' }); return this.getOrder(id);
  }
  cancelSubscription(id: string) {
    const s = this.getSubscription(id); requireThat(s.status === 'active', 'INACTIVE_SUBSCRIPTION', 'Subscription is already cancelled.');
    requireThat(!this.one("SELECT id FROM orders WHERE subscription_id=? AND status='released'", id), 'OPEN_DELIVERY', 'Resolve released deliveries before cancelling the subscription.');
    const refund = Math.max(0, -this.balance('customer_credit', id));
    requireThat(this.availableCash() >= refund, 'INSUFFICIENT_CAPITAL', 'Fund the refund before cancelling.');
    if (refund > 0) this.post(`refund:${id}`, 'Cancellation · refund unused balance', [{ account: 'customer_credit', subscriptionId: id, debit: refund, credit: 0 }, { account: 'cash', debit: 0, credit: refund }]);
    this.exec("UPDATE orders SET status='cancelled',updated_at=? WHERE subscription_id=? AND status='queued'", this.time(), id);
    this.exec("UPDATE subscriptions SET status='cancelled' WHERE id=?", id);
    this.audit('subscription.cancelled', id, { refundCents: refund, outstandingCents: this.balance('receivable', id) });
    return { id, refundCents: refund, outstandingCents: this.balance('receivable', id) };
  }
  settleReceivable(id: string, cents: number) {
    this.getSubscription(id);
    requireThat(Number.isSafeInteger(cents) && cents > 0 && cents <= this.balance('receivable', id), 'INVALID_AMOUNT', 'Payment must be positive and cannot exceed the outstanding balance.');
    const paymentId = randomUUID();
    this.post(`receivable:${paymentId}`, 'Outstanding balance · sandbox settlement', [{ account: 'cash', debit: cents, credit: 0 }, { account: 'receivable', subscriptionId: id, debit: 0, credit: cents }]);
    this.audit('receivable.settled', id, { cents }); return { id: paymentId, amountCents: cents };
  }
  statement(id: string) {
    const subscription = this.getSubscription(id);
    const entries = this.all<{ journal_id: string; description: string; created_at: string; account: string; debit: number; credit: number }>('SELECT e.journal_id,j.description,j.created_at,e.account,e.debit,e.credit FROM entries e JOIN journals j ON j.id=e.journal_id WHERE e.subscription_id=? ORDER BY e.id', id);
    return { subscription, household: this.getHousehold(subscription.household_id), creditCents: Math.max(0, -this.balance('customer_credit', id)), outstandingCents: this.balance('receivable', id), entries };
  }
  snapshot() {
    const subscriptions = this.all<{ id: string }>('SELECT id FROM subscriptions ORDER BY created_at').map(({ id }) => {
      const s = this.getSubscription(id);
      const periods = this.all<{ period: number }>('SELECT period FROM payments WHERE subscription_id=? ORDER BY period', id).map(p => p.period);
      return { ...s, periods, creditCents: Math.max(0, -this.balance('customer_credit', id)), outstandingCents: this.balance('receivable', id) };
    });
    const entries = this.all<{ account: string; debit: number; credit: number }>('SELECT account,SUM(debit) debit,SUM(credit) credit FROM entries GROUP BY account');
    const journals = this.all<{ id: string; reference: string; description: string; created_at: string; cents: number }>('SELECT j.*,SUM(e.debit) cents FROM journals j JOIN entries e ON e.journal_id=j.id GROUP BY j.id ORDER BY j.rowid DESC LIMIT 100');
    return { mode: 'sandbox' as const, households: this.all<Household>('SELECT * FROM households ORDER BY created_at'), subscriptions, orders: this.all<Order>('SELECT * FROM orders ORDER BY created_at DESC'),
      ledger: { entries, journals, balanced: entries.reduce((n, e) => n + e.debit - e.credit, 0) === 0 },
      metrics: { cashCents: this.balance('cash'), reservedCents: this.reservedCash(), availableCents: this.availableCash(), creditCents: -this.balance('customer_credit'), receivableCents: this.balance('receivable'), capitalCents: -this.balance('capital') },
      audit: this.all<{ id: number; action: string; entity_id: string; detail: string; created_at: string }>('SELECT * FROM audit ORDER BY id DESC LIMIT 30'),
      integrations: [{ name: 'Payments', mode: 'Sandbox ledger' }, { name: 'Supplier', mode: 'Simulated fulfillment' }, { name: 'EVM / Solana', mode: 'Source code; not connected' }],
    };
  }
  seed() {
    if (this.one('SELECT id FROM households LIMIT 1')) return;
    this.mutate('seed', 'seed-version-1', {}, () => {
      this.addCapital(2500000);
      for (const [name, email, postalCode, annualLitres, tankLitres] of [
        ['Nora Campbell', 'nora@example.test', 'B3H 1A1', 2000, 900],
        ['Elias Martin', 'elias@example.test', 'B3J 2K9', 2400, 1100],
        ['Maya Chen', 'maya@example.test', 'B3K 4X7', 1800, 900],
      ] as const) {
        const h = this.createHousehold({ name, email, postalCode, annualLitres, tankLitres });
        const q = this.createQuote({ householdId: h.id, unitPriceCents: 150, annualServiceCents: 24000 });
        const s = this.acceptQuote(q.id); this.recordPayment(s.id, { period: 1 });
        const o = this.createOrder({ subscriptionId: s.id, litres: 600 });
        if (name === 'Nora Campbell') { this.releaseOrder(o.id); this.completeOrder(o.id, 580); }
        if (name === 'Elias Martin') this.releaseOrder(o.id);
      }
      return { seeded: true };
    });
  }
}
export type Snapshot = ReturnType<Store['snapshot']>;
