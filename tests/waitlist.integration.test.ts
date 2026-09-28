import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import request from 'supertest';
import { WaitlistStore, canonicalEmail, hash } from '../waitlist/store.ts';
import { createWaitlistApp } from '../waitlist/app.ts';

// Explicitly opt in to a real database. All records live in a unique, disposable schema.
const enabled = !!process.env.WAITLIST_TEST_DATABASE_URL;
const schema = `wl_test_${randomBytes(8).toString('hex')}`;
let store: WaitlistStore;
let server: Server;
let api: ReturnType<typeof request>;
const messages: {email:string;token:string}[]=[];
let failMail=false;
const origin='https://delta-lp.example';
const post=(route:string,body:object={})=>api.post(`/api/waitlist/${route}`).set('Origin',origin).send(body);
const register=async(email:string,referral?:string)=>{await post('join',{email,consent:true,...(referral?{referral}:{})}).expect(200);return messages.at(-1)!;};
const confirm=async(token:string)=>{const r=await post('verify',{token}).expect(200);return {member:r.body.member,cookie:r.headers['set-cookie'][0].split(';')[0] as string};};

before(async()=>{if(!enabled)return;store=new WaitlistStore(process.env.WAITLIST_TEST_DATABASE_URL!,schema);await store.migrate();server=createServer(createWaitlistApp(store,{origin,secret:'integration-test-secret-not-for-production',secure:true,mailer:async(email,token)=>{if(failMail)throw new Error('Test delivery failure');messages.push({email,token});}}));server.listen(0,'127.0.0.1');await once(server,'listening');api=request(server);});
beforeEach(async()=>{if(!enabled)return;messages.length=0;failMail=false;await store.query('TRUNCATE wl.members,wl.rate_limits RESTART IDENTITY CASCADE');});
after(async()=>{if(!enabled)return;await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));await store.query(`DROP SCHEMA "${schema}" CASCADE`);});
const integration=(name:string,fn:()=>Promise<void>)=>test(name,{skip:!enabled},fn);

test('email identity normalizes case and Gmail aliases',()=>{assert.equal(canonicalEmail('First.Last+tag@GoogleMail.com'),'firstlast@gmail.com');assert.equal(canonicalEmail('Person+tag@example.com'),'person+tag@example.com');});
integration('signup earns no points until email verification; session recovers real rank',async()=>{
  const email=await register('first@example.test');
  assert.equal((await store.stats()).verified,0);
  const joined=await confirm(email.token);
  assert.equal(joined.member.points,100);assert.equal(joined.member.position,1);assert.equal(joined.member.total,1);
  const session=await api.get('/api/waitlist/me').set('Cookie',joined.cookie).expect(200);assert.equal(session.body.member.code,joined.member.code);
  const rows=await store.query('SELECT token_hash FROM wl.sessions');assert.ok(!rows[0].token_hash.includes(joined.cookie.split('=')[1]));
});
integration('referrals credit once after confirmation and improve the actual queue',async()=>{
  const a=await confirm((await register('a@example.test')).token);
  const b=await confirm((await register('b@example.test')).token);
  const c=await register('c@example.test',b.member.code);
  let current=await api.get('/api/waitlist/me').set('Cookie',b.cookie);assert.equal(current.body.member.points,100);assert.equal(current.body.member.position,2);
  await confirm(c.token);
  current=await api.get('/api/waitlist/me').set('Cookie',b.cookie);assert.equal(current.body.member.points,150);assert.equal(current.body.member.referrals,1);assert.equal(current.body.member.position,1);
  const first=await api.get('/api/waitlist/me').set('Cookie',a.cookie);assert.equal(first.body.member.position,2);
  await confirm((await register('c@example.test',a.member.code)).token);
  current=await api.get('/api/waitlist/me').set('Cookie',b.cookie);assert.equal(current.body.member.points,150);
});
integration('one-time confirmation remains atomic under simultaneous requests',async()=>{
  const {token}=await register('parallel@example.test');
  const replies=await Promise.all(Array.from({length:6},()=>post('verify',{token})));
  assert.equal(replies.filter(r=>r.status===200).length,1);assert.equal((await store.stats()).verified,1);
  const rows=await store.query('SELECT SUM(points)::integer AS total,COUNT(*)::integer AS count FROM wl.points');assert.deepEqual(rows[0],{total:100,count:1});
});
integration('different confirmation links cannot duplicate awards or deadlock',async()=>{
  const one=await register('twolinks@example.test');const two=await register('twolinks@example.test');
  const replies=await Promise.all([post('verify',{token:one.token}),post('verify',{token:two.token})]);
  assert.equal(replies.filter(r=>r.status===200).length,1);
  assert.equal((await store.query('SELECT COUNT(*)::integer AS count FROM wl.points'))[0].count,1);
});
integration('expired links never activate a position',async()=>{
  const {token}=await register('expired@example.test');await store.query("UPDATE wl.tokens SET expires_at=now()-interval '1 minute'");
  await post('verify',{token}).expect(400);assert.equal((await store.stats()).verified,0);
});
integration('duplicate email and Gmail aliases keep the same member and referral attribution',async()=>{
  const a=await confirm((await register('first.last@gmail.com')).token);
  const b=await confirm((await register('First.Last+test@googlemail.com')).token);
  assert.equal(a.member.code,b.member.code);assert.equal(b.member.points,100);assert.equal((await store.stats()).verified,1);
});
integration('self-referral and unverified invitations earn no referral points',async()=>{
  const pending=await register('pending@example.test');const [row]=await store.query('SELECT code FROM wl.members WHERE email=$1',['pending@example.test']);
  await confirm((await register('new@example.test',row.code)).token);await confirm(pending.token);
  const a=await confirm((await register('self@example.test')).token);await confirm((await register('self@example.test',a.member.code)).token);
  assert.equal((await store.query("SELECT COUNT(*)::integer AS count FROM wl.points WHERE kind='referral_verified'"))[0].count,0);
});
integration('deleting a member removes their session and reverses associated referral credit',async()=>{
  const a=await confirm((await register('inviter@example.test')).token);const b=await confirm((await register('friend@example.test',a.member.code)).token);
  await post('delete').set('Cookie',b.cookie).expect(200);
  const gone=await api.get('/api/waitlist/me').set('Cookie',b.cookie);assert.equal(gone.body.member,null);
  const inviter=await api.get('/api/waitlist/me').set('Cookie',a.cookie);assert.equal(inviter.body.member.points,100);assert.equal(inviter.body.member.referrals,0);assert.equal(inviter.body.member.total,1);
});
integration('logout revokes its session but preserves the member and points',async()=>{
  const a=await confirm((await register('logout@example.test')).token);await post('logout').set('Cookie',a.cookie).expect(200);
  const response=await api.get('/api/waitlist/me').set('Cookie',a.cookie);assert.equal(response.body.member,null);assert.equal((await store.stats()).verified,1);
});
integration('milestone tiers reflect real confirmed referrals',async()=>{
  const inviter=await confirm((await register('milestone@example.test')).token);
  for(let i=0;i<10;i++){
    // Exercise storage directly so per-IP email throttles remain independent of tier scoring.
    const entry=await store.register(`tier-${i}@example.test`,inviter.member.code);await store.verify(entry.token);
    if(i===2){const status=await api.get('/api/waitlist/me').set('Cookie',inviter.cookie);assert.equal(status.body.member.points,250);assert.equal(status.body.member.tier,'Priority');}
  }
  const status=await api.get('/api/waitlist/me').set('Cookie',inviter.cookie);assert.equal(status.body.member.points,600);assert.equal(status.body.member.tier,'Early circle');assert.equal(status.body.member.referrals,10);
});
integration('delivery failures are visible and unusable tokens are discarded',async()=>{
  failMail=true;await post('join',{email:'failed@example.test',consent:true}).expect(503);
  assert.equal((await store.query('SELECT COUNT(*)::integer AS count FROM wl.tokens'))[0].count,0);assert.equal((await store.stats()).verified,0);
});
integration('email rate limits and consent are enforced before messages are sent',async()=>{
  await post('join',{email:'consent@example.test',consent:false}).expect(400);
  for(let i=0;i<3;i++)await register('limits@example.test');
  await post('join',{email:'limits@example.test',consent:true}).expect(429);assert.equal(messages.length,3);
});
integration('API rejects cross-origin writes and exposes no private member listing',async()=>{
  await api.post('/api/waitlist/join').set('Origin','https://elsewhere.example').send({email:'no@example.test',consent:true}).expect(403);
  await api.get('/api/waitlist/members').expect(404);await post('delete').expect(401);
  assert.equal((await store.stats()).verified,0);
});
integration('expired sessions and abandoned unverified entries are cleaned up',async()=>{
  const old=await register('old@example.test');await store.query("UPDATE wl.members SET joined_at=now()-interval '15 days'");
  await store.cleanup();assert.equal((await store.query('SELECT COUNT(*)::integer AS count FROM wl.members'))[0].count,0);
  assert.equal(await store.verify(old.token),null);
});

integration('strategy preferences activate only on confirmation and persist across sign-in',async()=>{
  const preference={product:'strategy',direction:'short',leverage:10};
  await post('join',{email:'strategy@example.test',consent:true,preference}).expect(200);
  assert.equal((await store.query('SELECT preference FROM wl.members'))[0].preference,null);
  const entry=await confirm(messages.at(-1)!.token);
  assert.deepEqual(entry.member.preference,preference);
  const recovered=await confirm((await register('strategy@example.test')).token);
  assert.deepEqual(recovered.member.preference,preference);assert.equal(recovered.member.points,100);
});
integration('oil preferences require the member session to change and do not award points',async()=>{
  const entry=await confirm((await register('oil@example.test')).token);
  const preference={product:'oil-subscription',fuel:'heating-oil',region:'Halifax, Nova Scotia'};
  await post('preference',preference).expect(401);
  const saved=await post('preference',preference).set('Cookie',entry.cookie).expect(200);
  assert.deepEqual(saved.body.member.preference,preference);assert.equal(saved.body.member.points,100);
  await post('join',{email:'oil@example.test',consent:true,preference:{product:'strategy',direction:'long',leverage:5}}).expect(200);
  const unchanged=await api.get('/api/waitlist/me').set('Cookie',entry.cookie).expect(200);
  assert.deepEqual(unchanged.body.member.preference,preference);
});
integration('invalid products, leverage, and oversize regions are rejected',async()=>{
  for(const preference of [{product:'strategy',direction:'neutral',leverage:100},{product:'strategy',direction:'up',leverage:3},{product:'oil-subscription',fuel:'heating-oil',region:'a'.repeat(81)},{product:'oil-subscription',fuel:'heating-oil',region:'Halifax',guaranteedPrice:1}]) {
    await post('join',{email:'invalid@example.test',consent:true,preference}).expect(400);
  }
  assert.equal(messages.length,0);assert.equal((await store.stats()).verified,0);
});
