import type { Db } from '@ios/db';
import { json } from '@ios/db';
import { newToken, sha256 } from './util';

/** One-time and short-lived tokens (double opt-in, member sign-in, downloads). Only the hash is stored. */
export type TokenPurpose = 'confirm' | 'member_login' | 'download';

export const TOKEN_TTL_MS: Readonly<Record<TokenPurpose, number>> = {
  confirm: 7 * 86_400_000,
  member_login: 20 * 60_000,
  download: 30 * 86_400_000,
};

export async function issueToken(
  db: Db,
  t: { personaId: string; purpose: TokenPurpose; subscriberId?: string | null; membershipId?: string | null; ref?: Record<string, unknown>; now: Date },
): Promise<string> {
  const raw = newToken();
  await db.query(
    `INSERT INTO email_token (persona_id, subscriber_id, membership_id, purpose, token_hash, ref, expires_at) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [t.personaId, t.subscriberId ?? null, t.membershipId ?? null, t.purpose, sha256(raw), json(t.ref ?? {}), new Date(t.now.getTime() + TOKEN_TTL_MS[t.purpose])],
  );
  return raw;
}

export interface TokenRow {
  id: string;
  persona_id: string;
  subscriber_id: string | null;
  membership_id: string | null;
  purpose: TokenPurpose;
  ref: Record<string, unknown>;
  expires_at: Date;
  used_at: Date | null;
}

/** A valid token row (not expired; not used when `consume`). With `consume`, marks it used atomically. */
export async function readToken(db: Db, raw: string, purpose: TokenPurpose, now: Date, opts: { consume?: boolean } = {}): Promise<TokenRow | null> {
  if (!raw || raw.length > 200 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  if (opts.consume) {
    return db.maybeOne<TokenRow>(
      `UPDATE email_token SET used_at = $3 WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > $3
       RETURNING id, persona_id, subscriber_id, membership_id, purpose, ref, expires_at, used_at`,
      [sha256(raw), purpose, now],
    );
  }
  return db.maybeOne<TokenRow>(
    `SELECT id, persona_id, subscriber_id, membership_id, purpose, ref, expires_at, used_at FROM email_token
      WHERE token_hash = $1 AND purpose = $2 AND expires_at > $3`,
    [sha256(raw), purpose, now],
  );
}

/** The token row even if it was used (to make repeated confirm clicks idempotent). */
export async function findToken(db: Db, raw: string, purpose: TokenPurpose): Promise<TokenRow | null> {
  if (!raw || raw.length > 200 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  return db.maybeOne<TokenRow>(
    `SELECT id, persona_id, subscriber_id, membership_id, purpose, ref, expires_at, used_at FROM email_token WHERE token_hash = $1 AND purpose = $2`,
    [sha256(raw), purpose],
  );
}
