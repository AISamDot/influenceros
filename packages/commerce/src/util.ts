import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '@troupe/db';

/** Small shared helpers for stream G. */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const EMAIL_RE = /^[^\s@<>()",;:]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Normalised email (trimmed, lower case). */
export const normEmail = (email: string): string => email.trim().toLowerCase();

/** The customer hash every stream compares on: sha256 of the normalised email. */
export const emailHash = (email: string): string => sha256(normEmail(email));

/** A hashed client reference for rate limits and consent records (never the raw IP). */
export const clientHash = (ip: string | null | undefined): string | null => (ip ? sha256(`ios-client:${ip.trim()}`).slice(0, 24) : null);

/** URL-safe random token (base64url). */
export const newToken = (bytes = 24): string => randomBytes(bytes).toString('base64url');

/** Short link code: 7 chars from an unambiguous alphabet. */
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export function newCode(len = 7): string {
  const b = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i += 1) out += CODE_ALPHABET[b[i]! % CODE_ALPHABET.length];
  return out;
}
export const isCode = (s: string): boolean => /^[a-z2-9]{4,16}$/.test(s);

export const isEmail = (s: string): boolean => s.length <= 254 && EMAIL_RE.test(s.trim());

/** EU/EEA, the UK and Switzerland: double opt-in. Unknown regions get double opt-in too (the safe default). */
export const DOUBLE_OPT_IN_REGIONS: ReadonlySet<string> = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK',
  'SI', 'ES', 'SE', 'IS', 'LI', 'NO', 'GB', 'CH',
]);
export function needsDoubleOptIn(region: string | null | undefined): boolean {
  const r = region?.trim().toUpperCase();
  if (!r || !/^[A-Z]{2}$/.test(r) || r === 'XX') return true;
  return DOUBLE_OPT_IN_REGIONS.has(r);
}

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const monthKey = (d: Date): string => d.toISOString().slice(0, 7);
export const startOfUtcDay = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
export const asString = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : fallback);
export const asNumber = (v: unknown, fallback = 0): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Fixed-window rate limit on the public endpoints. Returns false once `limit` hits land in the current window.
 * Old windows are swept opportunistically.
 */
export async function rateLimit(db: Db, bucket: string, limit: number, windowMs: number, now: Date = new Date()): Promise<boolean> {
  const start = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const row = await db.one<{ hits: number }>(
    `INSERT INTO site_rate_limit (bucket, window_start, hits) VALUES ($1, $2, 1)
     ON CONFLICT (bucket, window_start) DO UPDATE SET hits = site_rate_limit.hits + 1 RETURNING hits`,
    [bucket, start],
  );
  if (Math.random() < 0.02) await db.query(`DELETE FROM site_rate_limit WHERE window_start < $1`, [new Date(now.getTime() - 86_400_000)]);
  return Number(row.hits) <= limit;
}

/** Thrown for input the public endpoints refuse (shown to the visitor as a generic message). */
export class PublicInputError extends Error {
  override readonly name = 'PublicInputError';
}
