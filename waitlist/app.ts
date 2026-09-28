import express, { type Request, type Response, type NextFunction } from 'express';
import { z, ZodError } from 'zod';
import { Resend } from 'resend';
import { WaitlistStore, canonicalEmail, hash, signupSchema } from './store.js';
import { preferenceSchema } from './preferences.js';
import { markets, sizeOrder } from '../strategy/lighter.js';
import { vaultState } from '../strategy/vault.js';
import { tokenizedState } from '../strategy/tokenized.js';

export type Mailer = (email: string, token: string) => Promise<void>;
export function resendMailer(origin: string): Mailer {
  return async (email, token) => {
    if (!process.env.RESEND_API_KEY || !process.env.WAITLIST_FROM) throw new Error('Email delivery is not configured.');
    const url = `${origin}/oil#verify=${token}`;
    const { error } = await new Resend(process.env.RESEND_API_KEY).emails.send({
      from: process.env.WAITLIST_FROM, to: email, subject: 'Confirm your place on the deltaLP waitlist',
      text: `Confirm your email to join the deltaLP waitlist or sign back in:\n\n${url}\n\nThis link expires in 20 minutes and can be used once. Verifying a new signup earns 100 points. If you did not request this email, ignore it.`,
      html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:40px auto;color:#183d36"><h1>You're early.</h1><p>Confirm your email to join the deltaLP waitlist, or sign back in to your existing place.</p><p style="margin:32px 0"><a href="${url}" style="padding:16px 24px;background:#183d36;color:white;border-radius:8px;text-decoration:none">Confirm my email</a></p><p>This link expires in 20 minutes and works once. No wallet or deposit is required.</p><p style="color:#667369;font-size:12px">If you didn't request this email, you can ignore it.</p></div>`,
    }, { idempotencyKey: `waitlist-${hash(token)}` });
    if (error) throw new Error('Email provider did not accept the verification email.');
  };
}

export function createWaitlistApp(store: WaitlistStore, options: { origin: string; secret: string; mailer: Mailer; secure: boolean; alternateOrigins?: string[] }) {
  const app = express(); app.disable('x-powered-by');
  if (options.secret.length < 32) throw new Error('WAITLIST_SECRET must contain at least 32 characters.');
  const session = (req: Request) => req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('dlp_session='))?.slice(12) ?? '';
  const cookie = (res: Response, value: string) => res.cookie('dlp_session', value, { httpOnly: true, secure: options.secure, sameSite: 'lax', path: '/', maxAge: value ? 30*24*60*60*1000 : 0 });
  app.use('/api', (req, res, next) => {
    res.set({ 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer', 'X-Frame-Options':'DENY' });
    if (!['GET','HEAD'].includes(req.method)) {
      const origin = req.get('origin');
      const accepted = [options.origin, ...(options.alternateOrigins ?? []), ...(!options.secure ? ['http://127.0.0.1:4317','http://localhost:4317'] : [])];
      if (!origin || !accepted.includes(origin) || req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'Please submit this form from the deltaLP website.' });
    }
    next();
  });
  app.use(express.json({ limit:'4kb' }));
  app.get('/api/health', async (_req,res) => { await store.stats(); res.json({ ok:true, mode:'waitlist' }); });
  app.get('/api/strategies/markets', async (_req,res) => {
    try { res.json({chainId:4663,venue:'Lighter Robinhood',markets:await markets(),executionEnabled:true,executionMode:'user-wallet',fundedExecutionVerified:false}); }
    catch {res.status(503).json({error:'Live market data is temporarily unavailable.'});}
  });
  app.get('/api/strategies/vault',async(_req,res)=>{
    try {res.json(await vaultState());}catch {res.status(503).json({error:'Mainnet vault data is temporarily unavailable.'});}
  });
  app.get('/api/strategies/tokenized',async(_req,res)=>{
    try {res.json(await tokenizedState());}catch {res.status(503).json({error:'Tokenized contract status is temporarily unavailable.'});}
  });
  app.post('/api/strategies/estimate', async (req,res) => {
    try {
      const values=await markets();const market=values.find(value=>value.symbol===req.body?.symbol);
      if(!market)return res.status(400).json({error:'Choose a supported market.'});
      res.json(sizeOrder(req.body,market));
    } catch(error) {res.status(400).json({error:error instanceof Error && !(error instanceof ZodError) ? error.message : 'Check the sizing inputs.'});}
  });
  app.get('/api/waitlist/maintenance', async (req,res) => {
    if (!process.env.CRON_SECRET || req.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({error:'Unauthorized.'});
    await store.cleanup(); res.json({ok:true});
  });
  app.get('/api/waitlist/stats', async (_req,res) => res.json(await store.stats()));
  app.get('/api/waitlist/me', async (req,res) => res.json({ member: session(req) ? await store.status(session(req)) : null }));
  app.post('/api/waitlist/join', async (req,res) => {
    const input = signupSchema.parse(req.body);
    if (input.website) return res.json({ ok:true, message:'Check your inbox for a confirmation link.' });
    const email = canonicalEmail(input.email);
    // Only Vercel's platform-set client IP header is trusted in production; local development uses the socket.
    const ip = options.secure ? req.get('x-vercel-forwarded-for')?.split(',')[0]?.trim() ?? req.socket.remoteAddress ?? 'unknown' : req.socket.remoteAddress ?? 'local';
    const allowed = await Promise.all([store.allow(hash(`${options.secret}:ip:${ip}`), 10), store.allow(hash(`${options.secret}:email:${email}`),3)]);
    if (allowed.some(v => !v)) return res.status(429).set('Retry-After','900').json({ error:'Too many attempts. Please wait 15 minutes before requesting another email.' });
    const { token } = await store.register(email, input.referral, input.preference);
    try { await options.mailer(email,token); }
    catch { await store.discardToken(token); return res.status(503).json({ error:'We could not send your confirmation email. Please try again shortly. Your position is only activated after verification.' }); }
    res.json({ ok:true, message:'Check your inbox for a confirmation link.' });
  });
  app.post('/api/waitlist/verify', async (req,res) => {
    const { token } = z.object({ token:z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict().parse(req.body);
    const value = await store.verify(token);
    if (!value) return res.status(400).json({ error:'This link has expired or already been used. Request a fresh link with the same email.' });
    cookie(res,value); res.json({ member:await store.status(value) });
  });
  app.post('/api/waitlist/logout', async (req,res) => { await store.logout(session(req)); cookie(res,''); res.json({ok:true}); });
  app.post('/api/waitlist/preference', async (req,res) => {
    const preference = preferenceSchema.parse(req.body);
    if (!await store.setPreference(session(req),preference)) return res.status(401).json({error:'Sign in before updating your preferences.'});
    res.json({member:await store.status(session(req))});
  });
  app.post('/api/waitlist/delete', async (req,res) => {
    if (!await store.status(session(req))) return res.status(401).json({ error:'Sign in before deleting your waitlist entry.' });
    await store.remove(session(req)); cookie(res,''); res.json({ok:true});
  });
  app.use('/api', (_req,res) => res.status(404).json({error:'Not found.'}));
  app.use((error: unknown,_req: Request,res: Response,_next: NextFunction) => {
    if (error instanceof ZodError || error instanceof SyntaxError) return res.status(400).json({error:'Please check the form and enter a valid email address.'});
    if (typeof error === 'object' && error && 'status' in error && error.status === 413) return res.status(413).json({error:'Request is too large.'});
    console.error('Waitlist request failed:', error instanceof Error ? error.name : 'Unknown error');
    res.status(503).json({error:'The waitlist is temporarily unavailable. Please try again.'});
  });
  return app;
}

let productionApp: ReturnType<typeof createWaitlistApp> | undefined;
export function configuredApp() {
  if (!productionApp) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is required.');
    const origin = process.env.WAITLIST_ORIGIN ?? 'http://127.0.0.1:4317';
    productionApp = createWaitlistApp(new WaitlistStore(url), { origin, alternateOrigins:(process.env.WAITLIST_ALTERNATE_ORIGINS ?? '').split(',').map(value=>value.trim()).filter(Boolean), secret:process.env.WAITLIST_SECRET ?? '', mailer:resendMailer(origin), secure:process.env.VERCEL === '1' });
  }
  return productionApp;
}
