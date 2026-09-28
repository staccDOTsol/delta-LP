import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { z } from 'zod';
import { preferenceSchema, type Preference } from './preferences.js';

export const signupSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  referral: z.string().regex(/^[A-Za-z0-9_-]{12}$/).optional(),
  consent: z.literal(true),
  website: z.string().max(200).optional(),
  preference: preferenceSchema.optional(),
}).strict();
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');
export function canonicalEmail(email: string) {
  const [local, domain] = email.trim().toLowerCase().split('@');
  return ['gmail.com', 'googlemail.com'].includes(domain) ? `${local.split('+')[0].replaceAll('.', '')}@gmail.com` : `${local}@${domain}`;
}
export type MemberStatus = {
  email: string; code: string; points: number; referrals: number; position: number;
  total: number; joinedAt: string; tier: 'Waitlist' | 'Priority' | 'Early circle';
  preference: Preference | null;
  activity: { kind: string; points: number; createdAt: string }[];
};

export class WaitlistStore {
  private sql;
  constructor(url: string, private schema = 'delta_waitlist') {
    if (!/^[a-z][a-z0-9_]{0,48}$/.test(schema)) throw new Error('Invalid database namespace.');
    this.sql = neon(url);
  }
  async query(text: string, args: unknown[] = []): Promise<Record<string, any>[]> {
    return await this.sql.query(text.replaceAll('wl.', `"${this.schema}".`), args) as Record<string, any>[];
  }
  async migrate() {
    const statements = [
      `CREATE SCHEMA IF NOT EXISTS "${this.schema}"`,
      `CREATE TABLE IF NOT EXISTS wl.members (
        id uuid PRIMARY KEY, sequence bigserial UNIQUE NOT NULL, email text UNIQUE NOT NULL,
        code text UNIQUE NOT NULL, referrer_id uuid REFERENCES wl.members(id) ON DELETE SET NULL,
        joined_at timestamptz NOT NULL DEFAULT now(), verified_at timestamptz,
        consent_version text NOT NULL DEFAULT '2026-09-28', CHECK (referrer_id IS DISTINCT FROM id)
      )`,
      `CREATE TABLE IF NOT EXISTS wl.tokens (
        token_hash text PRIMARY KEY, member_id uuid NOT NULL REFERENCES wl.members(id) ON DELETE CASCADE,
        expires_at timestamptz NOT NULL DEFAULT now() + interval '20 minutes'
      )`,
      `CREATE TABLE IF NOT EXISTS wl.sessions (
        token_hash text PRIMARY KEY, member_id uuid NOT NULL REFERENCES wl.members(id) ON DELETE CASCADE,
        expires_at timestamptz NOT NULL DEFAULT now() + interval '30 days'
      )`,
      `ALTER TABLE wl.members ADD COLUMN IF NOT EXISTS preference jsonb`,
      `ALTER TABLE wl.tokens ADD COLUMN IF NOT EXISTS preference jsonb`,
      `CREATE TABLE IF NOT EXISTS wl.points (
        id text PRIMARY KEY, member_id uuid NOT NULL REFERENCES wl.members(id) ON DELETE CASCADE,
        source_id uuid NOT NULL REFERENCES wl.members(id) ON DELETE CASCADE,
        kind text NOT NULL CHECK(kind IN ('email_verified','referral_verified')),
        points integer NOT NULL CHECK((kind = 'email_verified' AND points = 100) OR (kind = 'referral_verified' AND points = 50)),
        created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(source_id, kind)
      )`,
      `CREATE INDEX IF NOT EXISTS points_member_idx ON wl.points(member_id)`,
      `CREATE TABLE IF NOT EXISTS wl.rate_limits (key text PRIMARY KEY, hits integer NOT NULL, expires_at timestamptz NOT NULL)`,
      `CREATE OR REPLACE FUNCTION wl.register(p_email text, p_code text, p_id uuid, p_ref text, p_token text, p_preference jsonb)
        RETURNS uuid LANGUAGE plpgsql AS $$
        DECLARE found_id uuid; referring uuid;
        BEGIN
          PERFORM pg_advisory_xact_lock(hashtextextended(p_email, 0));
          SELECT id INTO found_id FROM wl.members WHERE email = p_email;
          IF found_id IS NULL THEN
            SELECT id INTO referring FROM wl.members WHERE code = p_ref AND verified_at IS NOT NULL AND email <> p_email;
            INSERT INTO wl.members(id,email,code,referrer_id) VALUES(p_id,p_email,p_code,referring) RETURNING id INTO found_id;
          END IF;
          INSERT INTO wl.tokens(token_hash,member_id,preference) VALUES(p_token,found_id,p_preference);
          RETURN found_id;
        END $$`,
      `CREATE OR REPLACE FUNCTION wl.verify(p_token text, p_session text)
        RETURNS uuid LANGUAGE plpgsql AS $$
        DECLARE found_id uuid; referring uuid; selected_preference jsonb;
        BEGIN
          SELECT member_id INTO found_id FROM wl.tokens WHERE token_hash = p_token AND expires_at > now();
          IF found_id IS NULL THEN RETURN NULL; END IF;
          SELECT referrer_id INTO referring FROM wl.members WHERE id = found_id FOR UPDATE;
          DELETE FROM wl.tokens WHERE token_hash = p_token AND expires_at > now() RETURNING member_id,preference INTO found_id,selected_preference;
          IF found_id IS NULL THEN RETURN NULL; END IF;
          UPDATE wl.members SET verified_at = COALESCE(verified_at, now()), preference = COALESCE(selected_preference,preference) WHERE id = found_id;
          INSERT INTO wl.points(id,member_id,source_id,kind,points) VALUES('join:' || found_id,found_id,found_id,'email_verified',100) ON CONFLICT DO NOTHING;
          IF referring IS NOT NULL THEN
            INSERT INTO wl.points(id,member_id,source_id,kind,points)
              SELECT 'ref:' || found_id,referring,found_id,'referral_verified',50
              WHERE EXISTS(SELECT 1 FROM wl.members WHERE id = referring AND verified_at IS NOT NULL)
              ON CONFLICT DO NOTHING;
          END IF;
          DELETE FROM wl.tokens WHERE member_id = found_id;
          INSERT INTO wl.sessions(token_hash,member_id) VALUES(p_session,found_id);
          RETURN found_id;
        END $$`,
      `CREATE OR REPLACE VIEW wl.ranking AS
        SELECT m.id, m.email, m.code, m.joined_at, COALESCE(SUM(p.points),0)::integer AS points,
          COUNT(p.id) FILTER (WHERE p.kind = 'referral_verified')::integer AS referrals,
          ROW_NUMBER() OVER (ORDER BY COALESCE(SUM(p.points),0) DESC, m.sequence ASC)::integer AS position,
          COUNT(*) OVER ()::integer AS total
        FROM wl.members m LEFT JOIN wl.points p ON p.member_id = m.id
        WHERE m.verified_at IS NOT NULL GROUP BY m.id`,
    ];
    for (const statement of statements) await this.query(statement);
  }
  async register(email: string, referral?: string, preference?: Preference) {
    const token = newToken();
    const selected = preference === undefined ? null : JSON.stringify(preferenceSchema.parse(preference));
    const [row] = await this.query('SELECT wl.register($1,$2,$3,$4,$5,$6::jsonb) AS id', [canonicalEmail(email), randomBytes(9).toString('base64url'), randomUUID(), referral ?? null, hash(token), selected]);
    return { id: row.id as string, token };
  }
  async discardToken(token: string) { await this.query('DELETE FROM wl.tokens WHERE token_hash=$1', [hash(token)]); }
  async verify(token: string) {
    const session = newToken();
    const [row] = await this.query('SELECT wl.verify($1,$2) AS id', [hash(token), hash(session)]);
    return row.id ? session : null;
  }
  async status(session: string): Promise<MemberStatus | null> {
    const [row] = await this.query(`SELECT r.*,m.preference FROM wl.ranking r JOIN wl.members m ON m.id=r.id JOIN wl.sessions s ON s.member_id=r.id WHERE s.token_hash=$1 AND s.expires_at > now()`, [hash(session)]);
    if (!row) return null;
    const activity = await this.query('SELECT kind,points,created_at AS "createdAt" FROM wl.points WHERE member_id=$1 ORDER BY created_at DESC,id DESC LIMIT 20', [row.id]);
    return { email: row.email, code: row.code, points: row.points, referrals: row.referrals, position: row.position, total: row.total, joinedAt: row.joined_at, tier: row.points >= 600 ? 'Early circle' : row.points >= 250 ? 'Priority' : 'Waitlist', preference: row.preference, activity: activity as MemberStatus['activity'] };
  }
  async setPreference(session: string, preference: Preference) {
    const rows = await this.query(`UPDATE wl.members SET preference=$2::jsonb WHERE id=(SELECT member_id FROM wl.sessions WHERE token_hash=$1 AND expires_at > now()) RETURNING id`, [hash(session), JSON.stringify(preferenceSchema.parse(preference))]);
    return rows.length > 0;
  }
  async stats() { const [r] = await this.query('SELECT COUNT(*)::integer AS verified FROM wl.members WHERE verified_at IS NOT NULL'); return r; }
  async logout(session: string) { await this.query('DELETE FROM wl.sessions WHERE token_hash=$1', [hash(session)]); }
  async remove(session: string) { await this.query('DELETE FROM wl.members WHERE id=(SELECT member_id FROM wl.sessions WHERE token_hash=$1 AND expires_at > now())', [hash(session)]); }
  async allow(key: string, limit: number) {
    const [row] = await this.query(`INSERT INTO wl.rate_limits(key,hits,expires_at) VALUES($1,1,now()+interval '15 minutes')
      ON CONFLICT(key) DO UPDATE SET hits=CASE WHEN wl.rate_limits.expires_at <= now() THEN 1 ELSE wl.rate_limits.hits+1 END,
      expires_at=CASE WHEN wl.rate_limits.expires_at <= now() THEN now()+interval '15 minutes' ELSE wl.rate_limits.expires_at END RETURNING hits`, [key]);
    return row.hits <= limit;
  }
  async cleanup() {
    for (const table of ['tokens','sessions','rate_limits']) await this.query(`DELETE FROM wl.${table} WHERE expires_at <= now()`);
    await this.query("DELETE FROM wl.members WHERE verified_at IS NULL AND joined_at < now()-interval '14 days'");
  }
}
