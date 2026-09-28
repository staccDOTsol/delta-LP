import express, { type Request, type Response, type NextFunction } from 'express';
import { z, ZodError } from 'zod';
import { DomainError, simulate, valueVault } from './domain.ts';
import { Store } from './store.ts';

export function createApp(store: Store) {
  const app = express(); app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store' });
    // This build is an operator sandbox, bound to loopback by server.ts.
    // Reject foreign hosts and browser origins rather than exposing local financial records.
    const host = req.hostname;
    if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) return res.status(403).json({ code: 'LOCAL_ONLY', error: 'This sandbox accepts local requests only.' });
    const origin = req.get('origin');
    if (origin) {
      try { if (new URL(origin).host !== req.get('host')) return res.status(403).json({ code: 'ORIGIN_DENIED', error: 'Request origin does not match this application.' }); }
      catch { return res.status(403).json({ code: 'ORIGIN_DENIED', error: 'Invalid request origin.' }); }
    }
    if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ code: 'ORIGIN_DENIED', error: 'Cross-site requests are disabled.' });
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  app.get('/api/health', (_req, res) => res.json({ ok: true, mode: 'sandbox', livePayments: false, liveTrading: false }));
  app.get('/api/state', (_req, res) => res.json(store.snapshot()));
  app.get('/api/subscriptions/:id/statement', (req, res) => res.json(store.statement(req.params.id)));
  const action = (scope: string, handler: (req: Request) => unknown) => (req: Request, res: Response) => {
    const result = store.mutate(`${scope}:${req.path}`, req.get('Idempotency-Key') ?? '', req.body ?? {}, () => handler(req));
    res.json(result);
  };
  const id = (req: Request) => z.string().uuid().parse(req.params.id);
  app.post('/api/households', action('household', req => store.createHousehold(req.body)));
  app.post('/api/enrollments', action('enrollment', req => {
    const value = z.object({ household: z.unknown(), unitPriceCents: z.number().int(), annualServiceCents: z.number().int() }).strict().parse(req.body);
    const household = store.createHousehold(value.household);
    const quote = store.createQuote({ householdId: household.id, unitPriceCents: value.unitPriceCents, annualServiceCents: value.annualServiceCents });
    return { household, quote, subscription: store.acceptQuote(quote.id) };
  }));
  app.post('/api/quotes', action('quote', req => store.createQuote(req.body)));
  app.post('/api/quotes/:id/accept', action('accept', req => store.acceptQuote(id(req))));
  app.post('/api/subscriptions/:id/payments', action('payment', req => store.recordPayment(id(req), req.body)));
  app.post('/api/subscriptions/:id/cancel', action('cancel', req => store.cancelSubscription(id(req))));
  app.post('/api/subscriptions/:id/settle', action('settle', req => store.settleReceivable(id(req), z.object({ cents: z.number().int().positive().max(100000000) }).strict().parse(req.body).cents)));
  app.post('/api/capital', action('capital', req => store.addCapital(z.object({ cents: z.number().int().positive().max(100000000) }).strict().parse(req.body).cents)));
  app.post('/api/orders', action('order', req => store.createOrder(req.body)));
  app.post('/api/orders/:id/release', action('release', req => store.releaseOrder(id(req))));
  app.post('/api/orders/:id/complete', action('complete', req => store.completeOrder(id(req), z.object({ litres: z.number().int().positive().max(2500) }).strict().parse(req.body).litres)));
  app.post('/api/orders/:id/cancel', action('cancel-order', req => store.cancelOrder(id(req))));
  app.post('/api/simulate', (req, res) => res.json(simulate(req.body)));
  app.post('/api/vault/value', (req, res) => res.json(valueVault(req.body)));
  app.get('/api/export/ledger.csv', (_req, res) => {
    const rows = store.all<Record<string, string | number>>('SELECT j.created_at,j.reference,j.description,e.account,e.subscription_id,e.debit,e.credit FROM entries e JOIN journals j ON j.id=e.journal_id ORDER BY e.id');
    const escape = (v: unknown) => `"${String(v ?? '').replace(/^[=+@-]/, "'$&").replaceAll('"', '""')}"`;
    res.type('text/csv').attachment('delta-lp-ledger.csv').send(['date,reference,description,account,subscription,debit_cad_cents,credit_cad_cents', ...rows.map(r => Object.values(r).map(escape).join(','))].join('\r\n'));
  });
  app.use('/api', (_req, res) => res.status(404).json({ code: 'NOT_FOUND', error: 'API route not found.' }));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ZodError) return res.status(400).json({ code: 'VALIDATION', error: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') });
    if (error instanceof DomainError) return res.status(error.status).json({ code: error.code, error: error.message });
    if (error instanceof SyntaxError) return res.status(400).json({ code: 'INVALID_JSON', error: 'Request body must be valid JSON.' });
    console.error('API failure:', error instanceof Error ? error.message : 'Unknown failure');
    return res.status(500).json({ code: 'INTERNAL', error: 'The operation failed. No transaction was committed.' });
  });
  return app;
}
