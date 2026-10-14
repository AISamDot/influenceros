import { createHash, randomBytes, scrypt as scryptCb, type ScryptOptions, timingSafeEqual } from 'node:crypto';
import type { Db } from '@ios/db';
import type { EmailProvider } from '@ios/providers';
import { SESSION_TTL_MS, signSession } from './guard';

/**
 * Owner sign-in (one Owner): a magic link to OWNER_EMAIL via Resend, or the fallback password set from the CLI.
 * Both create a session row and a signed session cookie. Tokens and passwords are stored only as hashes;
 * attempts are throttled; failures never reveal whether an email is the Owner's.
 */

const scrypt = (password: string, salt: Buffer, keylen: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));

const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 64 } as const;
export const MIN_PASSWORD_LENGTH = 12;

/** `scrypt$N$r$p$salt$hash` (base64url). */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`use at least ${MIN_PASSWORD_LENGTH} characters`);
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 128 * SCRYPT.N * SCRYPT.r * 2 });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const N = Number(n);
  const R = Number(r);
  const key = await scrypt(password.normalize('NFKC'), Buffer.from(salt, 'base64url'), expected.length, { N, r: R, p: Number(p), maxmem: 128 * N * R * 2 });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Sets (or replaces) the fallback password and signs out every session. */
export async function setOwnerPassword(db: Db, password: string): Promise<void> {
  const hash = await hashPassword(password);
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO owner_credential (id, password_hash, updated_at) VALUES ('owner', $1, now())
       ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = now()`,
      [hash],
    );
    await tx.query(`UPDATE auth_session SET revoked_at = now() WHERE revoked_at IS NULL`);
  });
}

export async function hasOwnerPassword(db: Db): Promise<boolean> {
  return Boolean(await db.maybeOne(`SELECT 1 FROM owner_credential WHERE id = 'owner'`));
}

export interface Throttle {
  /** Window and maximum per kind (password failures, magic-link requests, verify failures). */
  windowMs: number;
  max: number;
}
export const THROTTLE: Record<'password' | 'magic_link' | 'verify', Throttle> = {
  password: { windowMs: 15 * 60_000, max: 10 },
  magic_link: { windowMs: 15 * 60_000, max: 5 },
  verify: { windowMs: 15 * 60_000, max: 20 },
};

export class AuthError extends Error {
  override readonly name = 'AuthError';
  constructor(
    message: string,
    readonly status: 400 | 401 | 429 | 503,
  ) {
    super(message);
  }
}

async function throttled(db: Db, kind: keyof typeof THROTTLE, countOk: boolean, now: Date): Promise<boolean> {
  const t = THROTTLE[kind];
  const r = await db.one<{ n: number }>(
    `SELECT count(*)::int AS n FROM auth_attempt WHERE kind = $1 AND created_at > $2 AND ($3 OR NOT ok)`,
    [kind, new Date(now.getTime() - t.windowMs), countOk],
  );
  return r.n >= t.max;
}

async function attempt(db: Db, kind: keyof typeof THROTTLE, ok: boolean, ipHash: string | null): Promise<void> {
  await db.query('INSERT INTO auth_attempt (kind, ok, ip_hash) VALUES ($1, $2, $3)', [kind, ok, ipHash]);
}

/** A salted hash of the client IP for the attempt log (never the raw address). */
export function hashIp(ip: string | null, secret: string): string | null {
  return ip ? createHash('sha256').update(`${secret}:${ip}`).digest('hex').slice(0, 24) : null;
}

export interface IssuedSession {
  sid: string;
  token: string;
  expiresAt: Date;
}

export async function createSession(db: Db, input: { method: 'magic_link' | 'password'; userAgent?: string | null; secret: string; now?: Date }): Promise<IssuedSession> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  const { id } = await db.one<{ id: string }>(
    `INSERT INTO auth_session (method, user_agent, created_at, expires_at) VALUES ($1, $2, $3, $4) RETURNING id`,
    [input.method, (input.userAgent ?? '').slice(0, 200) || null, now, expiresAt],
  );
  return { sid: id, token: signSession({ sid: id, exp: expiresAt.getTime() }, input.secret), expiresAt };
}

/** Is the session row still valid (not signed out or revoked, not expired)? */
export async function sessionActive(db: Db, sid: string, now: Date = new Date()): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(sid)) return false;
  return Boolean(await db.maybeOne(`SELECT 1 FROM auth_session WHERE id = $1 AND revoked_at IS NULL AND expires_at > $2`, [sid, now]));
}

export async function revokeSession(db: Db, sid: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(sid)) return;
  await db.query(`UPDATE auth_session SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [sid]);
}

export async function revokeAllSessions(db: Db): Promise<number> {
  return (await db.query(`UPDATE auth_session SET revoked_at = now() WHERE revoked_at IS NULL RETURNING id`)).length;
}

/** Password sign-in. Throttled on failures; the same error for "no password set" and "wrong password". */
export async function loginWithPassword(
  db: Db,
  input: { password: string; secret: string; userAgent?: string | null; ipHash?: string | null; now?: Date },
): Promise<IssuedSession> {
  const now = input.now ?? new Date();
  if (await throttled(db, 'password', false, now)) throw new AuthError('too many attempts: try again in 15 minutes', 429);
  const row = await db.maybeOne<{ password_hash: string }>(`SELECT password_hash FROM owner_credential WHERE id = 'owner'`);
  const ok = Boolean(row && input.password && input.password.length <= 1024 && (await verifyPassword(input.password, row.password_hash)));
  await attempt(db, 'password', ok, input.ipHash ?? null);
  if (!ok) throw new AuthError('wrong password', 401);
  return createSession(db, { method: 'password', userAgent: input.userAgent, secret: input.secret, now });
}

export const MAGIC_LINK_TTL_MS = 15 * 60_000;

/**
 * Sends a one-time sign-in link when `email` is the Owner's (OWNER_EMAIL). The caller always shows the same
 * message, so nobody learns which address is the Owner's. Returns the raw link only for local development logs
 * (when the email provider is a fake); never log it otherwise.
 */
export async function requestMagicLink(
  db: Db,
  email: EmailProvider,
  input: { email: string; ownerEmail: string | null | undefined; from: string; baseUrl: string; ipHash?: string | null; now?: Date },
): Promise<{ sent: boolean; link: string | null }> {
  const now = input.now ?? new Date();
  if (await throttled(db, 'magic_link', true, now)) throw new AuthError('too many sign-in links requested: try again in 15 minutes', 429);
  const owner = input.ownerEmail?.trim().toLowerCase();
  const match = Boolean(owner) && input.email.trim().toLowerCase() === owner;
  await attempt(db, 'magic_link', match, input.ipHash ?? null);
  if (!match || !owner) return { sent: false, link: null };
  const token = randomBytes(32).toString('base64url');
  await db.query(`INSERT INTO auth_token (token_hash, purpose, expires_at) VALUES ($1, 'magic_link', $2)`, [sha256(token), new Date(now.getTime() + MAGIC_LINK_TTL_MS)]);
  const link = `${input.baseUrl.replace(/\/$/, '')}/login/verify?token=${token}`;
  await email.send({
    from: input.from,
    to: owner,
    subject: 'Sign in to Influencer OS',
    html: `<p>Sign in to your Influencer OS dashboard:</p><p><a href="${link}">Sign in</a></p><p>The link works once and expires in 15 minutes. If you didn't ask for it, ignore this email.</p>`,
    tags: { purpose: 'owner_sign_in' },
  });
  return { sent: true, link };
}

/** Exchanges a magic-link token (single use, unexpired) for a session. */
export async function loginWithMagicToken(
  db: Db,
  input: { token: string; secret: string; userAgent?: string | null; ipHash?: string | null; now?: Date },
): Promise<IssuedSession> {
  const now = input.now ?? new Date();
  if (await throttled(db, 'verify', false, now)) throw new AuthError('too many attempts: try again in 15 minutes', 429);
  const token = input.token.trim();
  const used = token.length >= 20 && token.length <= 200
    ? await db.maybeOne(
        `UPDATE auth_token SET used_at = $2 WHERE token_hash = $1 AND purpose = 'magic_link' AND used_at IS NULL AND expires_at > $2 RETURNING id`,
        [sha256(token), now],
      )
    : null;
  await attempt(db, 'verify', Boolean(used), input.ipHash ?? null);
  if (!used) throw new AuthError('this sign-in link is invalid, used or expired: request a new one', 401);
  return createSession(db, { method: 'magic_link', userAgent: input.userAgent, secret: input.secret, now });
}

export async function authStatus(db: Db): Promise<{ passwordSet: boolean; activeSessions: number }> {
  const r = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM auth_session WHERE revoked_at IS NULL AND expires_at > now()`);
  return { passwordSet: await hasOwnerPassword(db), activeSessions: r.n };
}
