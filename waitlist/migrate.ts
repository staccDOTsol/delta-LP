import { WaitlistStore } from './store.ts';
if (!process.env.DATABASE_URL) throw new Error('Load DATABASE_URL before running migrations.');
const store = new WaitlistStore(process.env.DATABASE_URL);
await store.migrate();
await store.cleanup();
console.log('Waitlist database schema ready.');
