import { loadPersonaKit, type StudioServices } from '@troupe/agents';
import { briefProduct } from '@troupe/content';
import type { Db } from '@troupe/db';
import type { StoreEvent } from '@troupe/providers';
import { ensureList } from './audience';
import { renderEmail } from './render';
import { getCommerceSettings } from './settings';
import { sitePageUrl, sitePersona } from './sites';
import { productFileKey } from './store';
import { issueToken, readToken } from './tokens';
import { clientHash, emailHash, isEmail, monthKey, newToken, normEmail, rateLimit, sha256 } from './util';

/**
 * Membership (FR-22): Lemon Squeezy subscriptions gate a monthly drop in the members area of the persona's site.
 * Members sign in with a magic link (cookie `ios_member`, host-only, HttpOnly; never the Owner's session). Access:
 * trial and active; past due for a 7-day grace period; cancelled until the paid period ends. Discord gating comes
 * later behind `CommunityGate`.
 */

export const MEMBER_COOKIE = 'ios_member';
export const MEMBER_SESSION_DAYS = 30;
export const GRACE_DAYS = 7;
export const MEMBERSHIP_DROP_JOB = 'membership.drop';

export type MembershipStatus = 'trial' | 'active' | 'past_due' | 'cancelled';

export interface MembershipRow {
  id: string;
  persona_id: string;
  status: MembershipStatus;
  plan: string;
  price_cents: number;
  ends_at: Date | null;
  past_due_since: Date | null;
  email_hash: string | null;
  subscriber_id: string | null;
  store_subscription_id: string | null;
}

/** A community platform gate (Discord later). Grant on access, revoke when it ends. */
export interface CommunityGate {
  readonly platform: string;
  grant(m: { membershipId: string; personaId: string }): Promise<{ userRef: string } | null>;
  revoke(m: { membershipId: string; personaId: string; userRef: string }): Promise<void>;
}

export function hasAccess(m: Pick<MembershipRow, 'status' | 'ends_at' | 'past_due_since'>, now: Date): boolean {
  if (m.status === 'trial' || m.status === 'active') return true;
  if (m.status === 'past_due') return !m.past_due_since || now.getTime() - new Date(m.past_due_since).getTime() < GRACE_DAYS * 86_400_000;
  return Boolean(m.ends_at && new Date(m.ends_at).getTime() > now.getTime());
}

const STATUS_MAP: Record<string, MembershipStatus> = {
  on_trial: 'trial',
  active: 'active',
  paused: 'past_due',
  past_due: 'past_due',
  unpaid: 'past_due',
  cancelled: 'cancelled',
  expired: 'cancelled',
};

/**
 * A subscription update for a subscription we haven't seen created yet (out-of-order delivery). The webhook answers
 * 5xx so the vendor retries after subscription_created has landed, instead of dropping the update.
 */
export class UnknownSubscription extends Error {
  override readonly name = 'UnknownSubscription';
  constructor(readonly subscriptionId: string) {
    super(`unknown subscription ${subscriptionId}`);
  }
}

/** Applies a subscription webhook event. Returns the membership id (null when created for an unknown persona). Throws UnknownSubscription for an update to an unknown subscription. */
export async function applySubscriptionEvent(
  services: StudioServices,
  ev: Extract<StoreEvent, { type: 'subscription_created' | 'subscription_updated' | 'subscription_payment_failed' }>,
  ctx: { personaId: string | null; productId: string | null; sourcePostId?: string | null; gate?: CommunityGate | null },
): Promise<string | null> {
  const { db } = services;
  const now = services.now();
  let id: string | null = null;
  if (ev.type === 'subscription_created') {
    if (!ctx.personaId) return null;
    const product = ctx.productId ? await db.maybeOne<{ name: string; price_cents: number }>('SELECT name, price_cents FROM product WHERE id = $1', [ctx.productId]) : null;
    const hash = ev.email ? emailHash(ev.email) : (ev.emailHash ?? null);
    const sub = hash ? await db.maybeOne<{ id: string }>('SELECT id FROM subscriber WHERE persona_id = $1 AND email_hash = $2', [ctx.personaId, hash]) : null;
    const row = await db.one<{ id: string }>(
      `INSERT INTO membership (persona_id, subscriber_id, plan, price_cents, status, store_subscription_id, product_id, email_hash, source_post_id, started_at, email)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (store_subscription_id) WHERE store_subscription_id IS NOT NULL DO UPDATE SET updated_at = now()
       RETURNING id`,
      [
        ctx.personaId,
        sub?.id ?? null,
        product?.name ?? 'Membership',
        ev.priceCents ?? product?.price_cents ?? 0,
        ev.status === 'on_trial' ? 'trial' : 'active',
        ev.subscriptionId,
        ctx.productId,
        hash,
        ctx.sourcePostId ?? null,
        now,
        ev.email ? normEmail(ev.email) : null,
      ],
    );
    id = row.id;
  } else {
    const m = await db.maybeOne<{ id: string; status: MembershipStatus; past_due_since: Date | null; store_updated_at: Date | null }>(
      'SELECT id, status, past_due_since, store_updated_at FROM membership WHERE store_subscription_id = $1',
      [ev.subscriptionId],
    );
    if (!m) throw new UnknownSubscription(ev.subscriptionId);
    id = m.id;
    if (ev.type === 'subscription_updated' && ev.source === 'invoice') {
      // A payment went through: it clears past-due only. A retried or late invoice never revives a cancelled or
      // expired subscription, and never touches ends_at.
      if (m.status === 'past_due') {
        await db.query(`UPDATE membership SET status = 'active', past_due_since = NULL, updated_at = now() WHERE id = $1 AND status = 'past_due'`, [m.id]);
      }
      await syncCommunityAccess(services, id, ctx.gate ?? null);
      return id;
    }
    // Out-of-order delivery: an event older than the last one applied changes nothing.
    const updatedAt = ev.type === 'subscription_updated' && ev.updatedAt ? new Date(ev.updatedAt) : null;
    if (updatedAt && !Number.isNaN(updatedAt.getTime()) && m.store_updated_at && updatedAt.getTime() < new Date(m.store_updated_at).getTime()) return id;
    const status: MembershipStatus = ev.type === 'subscription_payment_failed' ? 'past_due' : (STATUS_MAP[ev.status] ?? m.status);
    const endsAt = ev.type === 'subscription_updated' && ev.endsAt ? new Date(ev.endsAt) : null;
    if (updatedAt && !Number.isNaN(updatedAt.getTime())) await db.query(`UPDATE membership SET store_updated_at = $2 WHERE id = $1`, [m.id, updatedAt]);
    await db.query(
      `UPDATE membership SET status = $2,
              ends_at = CASE WHEN $3::timestamptz IS NOT NULL THEN $3 WHEN $2 IN ('active','trial') THEN NULL ELSE ends_at END,
              past_due_since = CASE WHEN $2 = 'past_due' THEN COALESCE(past_due_since, $4) ELSE NULL END,
              cancelled_at = CASE WHEN $2 = 'cancelled' THEN COALESCE(cancelled_at, $4) WHEN $2 IN ('active','trial') THEN NULL ELSE cancelled_at END,
              updated_at = now()
        WHERE id = $1`,
      [m.id, status, endsAt, now],
    );
  }
  if (id) await syncCommunityAccess(services, id, ctx.gate ?? null);
  return id;
}

/** Keeps the community platform in step with access (no-op until a gate is configured). */
export async function syncCommunityAccess(services: StudioServices, membershipId: string, gate: CommunityGate | null): Promise<void> {
  if (!gate) return;
  const { db } = services;
  const m = await db.one<MembershipRow>('SELECT * FROM membership WHERE id = $1', [membershipId]);
  const member = await db.maybeOne<{ id: string; user_ref: string; access_state: string }>(
    `SELECT id, user_ref, access_state FROM community_member WHERE membership_id = $1 AND platform = $2`,
    [membershipId, gate.platform],
  );
  const access = hasAccess(m, services.now());
  if (access && (!member || member.access_state === 'revoked')) {
    const granted = await gate.grant({ membershipId, personaId: m.persona_id });
    if (!granted) return;
    if (member) await db.query(`UPDATE community_member SET access_state = 'granted', user_ref = $2 WHERE id = $1`, [member.id, granted.userRef]);
    else await db.query(`INSERT INTO community_member (persona_id, membership_id, platform, user_ref, access_state) VALUES ($1, $2, $3, $4, 'granted')`, [m.persona_id, membershipId, gate.platform, granted.userRef]);
  } else if (!access && member && member.access_state !== 'revoked') {
    await gate.revoke({ membershipId, personaId: m.persona_id, userRef: member.user_ref });
    await db.query(`UPDATE community_member SET access_state = 'revoked' WHERE id = $1`, [member.id]);
  }
}

// ─────────────────────────────── Magic-link sign-in ───────────────────────────────

/**
 * Sends a sign-in link when the address has a membership with access. The response is the same either way (no
 * enumeration) and the endpoint is rate limited per client and per address.
 */
export async function requestMemberLink(services: StudioServices, args: { slug: string; email: string; ip?: string | null; studioId?: string }): Promise<{ sent: boolean }> {
  const { db } = services;
  const now = services.now();
  const persona = await sitePersona(db, args.slug, args.studioId);
  if (!persona) return { sent: false };
  const email = normEmail(args.email ?? '');
  if (!isEmail(email)) return { sent: false };
  const client = clientHash(args.ip);
  if (client && !(await rateLimit(db, `member-link:${client}`, 10, 3_600_000, now))) return { sent: false };
  const hash = emailHash(email);
  if (!(await rateLimit(db, `member-link-email:${persona.id}:${hash.slice(0, 24)}`, 3, 3_600_000, now))) return { sent: false };
  const members = await db.query<MembershipRow>(`SELECT * FROM membership WHERE persona_id = $1 AND email_hash = $2 ORDER BY started_at DESC`, [persona.id, hash]);
  const m = members.find((x) => hasAccess(x, now));
  if (!m) return { sent: false };
  const token = await issueToken(db, { personaId: persona.id, purpose: 'member_login', membershipId: m.id, now });
  const list = await ensureList(services, persona.id);
  const kit = await loadPersonaKit(db, persona.id);
  const settings = await getCommerceSettings(db, persona.studioId);
  const url = sitePageUrl(persona.slug, `/members/verify?t=${token}`);
  const mail = renderEmail({
    personaName: persona.name,
    colors: kit.colors,
    body: `Here's your sign-in link for the members area. It works once and expires in 20 minutes.\n\nIf you didn't ask for it, ignore this email.`,
    cta: { label: 'Open the members area', url },
    footer: { reason: `You're a member of ${persona.name}'s membership.`, unsubscribeUrl: null, physicalAddress: settings.physicalAddress },
  });
  const subject = `Your sign-in link for ${persona.name}'s members area`;
  const res = await services.providers.audience.send({ from: list.from, to: email, subject, html: mail.html, text: mail.text, tags: { persona: persona.slug, kind: 'member_login' } });
  await db.query(`INSERT INTO email_message (persona_id, kind, provider_id, subject) VALUES ($1, 'member_login', $2, $3) ON CONFLICT (provider_id) DO NOTHING`, [persona.id, res.id, subject]);
  return { sent: true };
}

/** Exchanges a sign-in link token for a member session token (the cookie value). */
export async function verifyMemberLink(services: StudioServices, args: { slug: string; token: string }): Promise<{ session: string; expiresAt: Date } | null> {
  const { db } = services;
  const now = services.now();
  const persona = await sitePersona(db, args.slug);
  if (!persona) return null;
  const t = await readToken(db, args.token, 'member_login', now, { consume: true });
  if (!t || t.persona_id !== persona.id || !t.membership_id) return null;
  const m = await db.one<MembershipRow>('SELECT * FROM membership WHERE id = $1', [t.membership_id]);
  if (!hasAccess(m, now)) return null;
  const session = newToken(32);
  const expiresAt = new Date(now.getTime() + MEMBER_SESSION_DAYS * 86_400_000);
  await db.query(`INSERT INTO member_session (persona_id, membership_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)`, [persona.id, m.id, sha256(session), expiresAt]);
  return { session, expiresAt };
}

/** The member behind a session cookie on this persona's site, if access is still on. */
export async function memberFromSession(db: Db, args: { slug: string; session: string | null | undefined; now: Date }): Promise<{ membership: MembershipRow; personaId: string } | null> {
  if (!args.session || args.session.length > 200 || !/^[A-Za-z0-9_-]+$/.test(args.session)) return null;
  const row = await db.maybeOne<MembershipRow & { slug: string; session_persona: string }>(
    `SELECT m.*, p.slug, s.persona_id AS session_persona FROM member_session s JOIN membership m ON m.id = s.membership_id JOIN persona p ON p.id = s.persona_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2`,
    [sha256(args.session), args.now],
  );
  if (!row || row.slug !== args.slug || !hasAccess(row, args.now)) return null;
  return { membership: row, personaId: row.session_persona };
}

export async function endMemberSession(db: Db, session: string | null | undefined): Promise<void> {
  if (!session || !/^[A-Za-z0-9_-]{1,200}$/.test(session)) return;
  await db.query(`UPDATE member_session SET revoked_at = now() WHERE token_hash = $1`, [sha256(session)]);
}

// ─────────────────────────────── Monthly drop ───────────────────────────────

export interface DropRow {
  id: string;
  month: string;
  title: string;
  summary: string | null;
  product_id: string | null;
  status: 'pending' | 'ready';
}

/**
 * Ensures this month's drop for a persona with a live membership: the newest approved membership-rung product not
 * dropped yet. When there is none, a members pack is briefed (the Product Builder makes it; the Owner approves v1)
 * and the drop waits as 'pending' until it's approved. When it becomes ready, members get an email.
 */
export async function ensureMonthlyDrop(services: StudioServices, personaId: string, now: Date = services.now()): Promise<DropRow | null> {
  const { db } = services;
  const membership = await db.maybeOne<{ id: string }>(`SELECT id FROM product WHERE persona_id = $1 AND ladder_rung = 'membership' AND status = 'live' LIMIT 1`, [personaId]);
  if (!membership) return null;
  const month = monthKey(now);
  let drop = await db.maybeOne<DropRow>(`SELECT id, month, title, summary, product_id, status FROM member_drop WHERE persona_id = $1 AND month = $2`, [personaId, month]);
  if (drop?.status === 'ready') return drop;
  const candidate = await db.maybeOne<{ id: string; name: string; current_version: number | null; summary: string | null }>(
    `SELECT pr.id, pr.name, pr.current_version, (SELECT content->>'promise' FROM product_brief b WHERE b.product_id = pr.id ORDER BY created_at DESC LIMIT 1) AS summary
       FROM product pr
      WHERE pr.persona_id = $1 AND pr.ladder_rung = 'membership' AND pr.id <> $2 AND pr.status IN ('approved','live')
        AND NOT EXISTS (SELECT 1 FROM member_drop d WHERE d.product_id = pr.id AND d.status = 'ready')
      ORDER BY pr.created_at DESC LIMIT 1`,
    [personaId, membership.id],
  );
  if (candidate && (await productFileKey(db, candidate.id))) {
    drop = await db.one<DropRow>(
      `INSERT INTO member_drop (persona_id, month, title, summary, product_id, product_version, status) VALUES ($1, $2, $3, $4, $5, $6, 'ready')
       ON CONFLICT (persona_id, month) DO UPDATE SET title = EXCLUDED.title, summary = EXCLUDED.summary, product_id = EXCLUDED.product_id,
         product_version = EXCLUDED.product_version, status = 'ready'
       RETURNING id, month, title, summary, product_id, status`,
      [personaId, month, candidate.name, candidate.summary, candidate.id, candidate.current_version],
    );
    await announceDrop(services, personaId, drop);
    return drop;
  }
  if (!drop) {
    const name = `${new Date(`${month}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })} members pack`;
    const pending = await db.maybeOne(
      `SELECT 1 FROM product WHERE persona_id = $1 AND ladder_rung = 'membership' AND id <> $2 AND status IN ('idea','brief','building','qc','awaiting_approval')`,
      [personaId, membership.id],
    );
    if (!pending) await briefProduct(services, { personaId, rung: 'membership', title: name, notify: true });
    drop = await db.one<DropRow>(
      `INSERT INTO member_drop (persona_id, month, title, status) VALUES ($1, $2, $3, 'pending') ON CONFLICT (persona_id, month) DO UPDATE SET title = member_drop.title
       RETURNING id, month, title, summary, product_id, status`,
      [personaId, month, name],
    );
  }
  return drop;
}

/** Emails every member with access that the month's drop is ready (once per drop). */
async function announceDrop(services: StudioServices, personaId: string, drop: DropRow): Promise<number> {
  const { db } = services;
  const now = services.now();
  const claimed = await db.maybeOne(`UPDATE member_drop SET announced_at = $2 WHERE id = $1 AND announced_at IS NULL RETURNING id`, [drop.id, now]);
  if (!claimed) return 0;
  const p = await db.one<{ slug: string; name: string; studio_id: string }>('SELECT slug, name, studio_id FROM persona WHERE id = $1', [personaId]);
  const members = await db.query<MembershipRow & { email: string | null }>(
    `SELECT m.*, COALESCE(m.email, s.email) AS email FROM membership m LEFT JOIN subscriber s ON s.id = m.subscriber_id WHERE m.persona_id = $1`,
    [personaId],
  );
  const settings = await getCommerceSettings(db, p.studio_id);
  const list = await ensureList(services, personaId);
  const kit = await loadPersonaKit(db, personaId);
  let sent = 0;
  for (const m of members) {
    if (!m.email || !hasAccess(m, now)) continue;
    const mail = renderEmail({
      personaName: p.name,
      colors: kit.colors,
      body: `This month's members drop is ready: ${drop.title}.\n\n${drop.summary ?? 'Open the members area to download it.'}`,
      cta: { label: 'Open the members area', url: sitePageUrl(p.slug, '/members') },
      footer: { reason: `You're a member of ${p.name}'s membership.`, unsubscribeUrl: null, physicalAddress: settings.physicalAddress },
    });
    const res = await services.providers.audience.send({ from: list.from, to: m.email, subject: `New this month: ${drop.title}`, html: mail.html, text: mail.text, tags: { persona: p.slug, kind: 'member_drop' } });
    await db.query(`INSERT INTO email_message (persona_id, subscriber_id, kind, provider_id, subject) VALUES ($1, $2, 'broadcast', $3, $4) ON CONFLICT (provider_id) DO NOTHING`, [personaId, m.subscriber_id, res.id, `New this month: ${drop.title}`]);
    sent += 1;
  }
  return sent;
}

/** Drops a member can open (newest first). */
export async function memberDrops(db: Db, personaId: string): Promise<DropRow[]> {
  return db.query<DropRow>(`SELECT id, month, title, summary, product_id, status FROM member_drop WHERE persona_id = $1 AND status = 'ready' ORDER BY month DESC LIMIT 24`, [personaId]);
}

/** Membership numbers per persona (dashboard): members with access, MRR, churned this month. */
export async function membershipStats(db: Db, personaId: string, now: Date = new Date()): Promise<{ members: number; mrrCents: number; pastDue: number; churned30d: number }> {
  const rows = await db.query<MembershipRow & { cancelled_at: Date | null }>(`SELECT * FROM membership WHERE persona_id = $1`, [personaId]);
  const withAccess = rows.filter((m) => hasAccess(m, now));
  return {
    members: withAccess.length,
    mrrCents: withAccess.filter((m) => m.status === 'active').reduce((s, m) => s + Number(m.price_cents), 0),
    pastDue: rows.filter((m) => m.status === 'past_due').length,
    churned30d: rows.filter((m) => m.status === 'cancelled' && m.cancelled_at && now.getTime() - new Date(m.cancelled_at).getTime() < 30 * 86_400_000).length,
  };
}

/** Download URL helper for member files (served by the members file route with the session cookie). */
export const memberFilePath = (dropId: string): string => `/api/public/members/file?drop=${dropId}`;
