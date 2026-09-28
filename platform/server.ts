import express from 'express';
import { resolve } from 'node:path';
import { Store } from './store.ts';
import { createApp } from './api.ts';

if (process.env.DELTA_MODE && process.env.DELTA_MODE !== 'sandbox') throw new Error('Live mode is not implemented. DELTA_MODE must be sandbox.');
const port = Number(process.env.PORT ?? 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
const store = new Store(process.env.DELTA_DB ?? 'data/delta.sqlite');
if (process.env.DELTA_SEED !== '0') store.seed();
const app = createApp(store);
const production = process.argv.includes('--production');
const vite = production ? null : await (await import('vite')).createServer({ server: { middlewareMode: true, hmr: false }, appType: 'spa' });
if (vite) app.use(vite.middlewares);
else { app.use(express.static(resolve('dist'))); app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html'))); }
const server = app.listen(port, '127.0.0.1', () => console.log(`Delta LP sandbox → http://127.0.0.1:${port}\nPersistent ledger: ${process.env.DELTA_DB ?? 'data/delta.sqlite'}\nPayments, supplier orders and risk scenarios are simulated.`));
let closing = false;
async function stop() { if (closing) return; closing = true; server.close(async () => { await vite?.close(); store.close(); process.exit(0); }); }
process.once('SIGINT', stop); process.once('SIGTERM', stop);
