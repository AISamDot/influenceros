import { enqueueOnceFor, loadPersonaKit, type StudioServices } from '@ios/agents';
import type { Db } from '@ios/db';
import { json } from '@ios/db';
import { renderEmail } from './render';
import { getCommerceSettings, senderFor } from './settings';
import { publicEndpointUrl, sitePageUrl, sitePersona, type SitePersona } from './sites';
import { issueToken, findToken, readToken } from './tokens';
import { clientHash, emailHash, isEmail, needsDoubleOptIn, newToken, normEmail, PublicInputError, rateLimit } from './util';

/**
 * Owned audience per persona (FR-11): one Resend audience (list) per persona, sign-ups from the persona's site with
 * consent records, double opt-in for EU/EEA/UK/CH (and unknown regions), unsubscribe, and enrolment in the welcome
 * sequence. Public entry points never reveal whether an address is already on the list (one response for all).
 */

export const SEND_DUE_JOB = 'email.send_due';
export const WRITE_WELCOME_JOB = 'email.write_welcome';

export const consentWording = (personaName: string, leadMagnet: string | null): string =>
  `Send me ${leadMagnet ? `"${leadMagnet}"` : 'the free guide'} and emails from ${personaName}. I can unsubscribe at any time.`;

/** The persona's Resend audience (created on first use) and sending identity. */
export async function ensureList(services: StudioServices, personaId: string): Promise<{ audienceId: string; from: string; fromEmail: string; fromName: string }> {
  const { db } = services;
  const existing = await db.maybeOne<{ audience_id: string; from_name: string; from_email: string }>('SELECT audience_id, from_name, from_email FROM email_list WHERE persona_id = $1', [personaId]);
  const p = await db.one<{ slug: string; name: string; studio_id: string }>('SELECT slug, name, studio_id FROM persona WHERE id = $1', [personaId]);
  const sender = senderFor(p, await getCommerceSettings(db, p.studio_id));
  if (existing && existing.from_email === sender.fromEmail) return { audienceId: existing.audience_id, from: sender.from, fromEmail: sender.fromEmail, fromName: sender.fromName };
  const { audienceId } = existing ? { audienceId: existing.audience_id } : await services.providers.audience.ensureAudience({ name: `${p.name} (${p.slug})` });
  await db.query(
    `INSERT INTO email_list (persona_id, audience_id, from_name, from_email) VALUES ($1, $2, $3, $4)
     ON CONFLICT (persona_id) DO UPDATE SET audience_id = EXCLUDED.audience_id, from_name = EXCLUDED.from_name, from_email = EXCLUDED.from_email, updated_at = now()`,
    [personaId, audienceId, sender.fromName, sender.fromEmail],
  );
  return { audienceId, from: sender.from, fromEmail: sender.fromEmail, fromName: sender.fromName };
}

export interface SubscribeInput {
  readonly slug: string;
  readonly email: string;
  readonly firstName?: string | null;
  /** ISO country from the edge (x-vercel-ip-country) or the form; unknown → double opt-in. */
  readonly region?: string | null;
  readonly ip?: string | null;
  /** Short link code the visitor arrived with (attribution). */
  readonly src?: string | null;
  /** Honeypot field: bots fill it, people never see it. */
  readonly honeypot?: string | null;
  readonly source?: string;
  readonly studioId?: string;
}

export type SubscribeOutcome = 'confirm_sent' | 'subscribed' | 'already' | 'ignored' | 'limited';

async function leadMagnetName(db: Db, personaId: string): Promise<string | null> {
  const r = await db.maybeOne<{ name: string }>(
    `SELECT name FROM product WHERE persona_id = $1 AND ladder_rung = 'lead_magnet' AND status IN ('approved','live') ORDER BY created_at DESC LIMIT 1`,
    [personaId],
  );
  return r?.name ?? null;
}

/** A site sign-up. The visible response is the same for every outcome (no account enumeration). */
export async function subscribe(services: StudioServices, input: SubscribeInput): Promise<{ outcome: SubscribeOutcome; persona: SitePersona }> {
  const { db } = services;
  const now = services.now();
  const persona = await sitePersona(db, input.slug, input.studioId);
  if (!persona) throw new PublicInputError('unknown site');
  if (input.honeypot && input.honeypot.trim()) return { outcome: 'ignored', persona };
  const email = normEmail(input.email ?? '');
  if (!isEmail(email)) throw new PublicInputError('Enter a valid email address.');
  const firstName = input.firstName?.replace(/[<>"\\\r\n]/g, '').trim().slice(0, 60) || null;
  const client = clientHash(input.ip);
  if (client && !(await rateLimit(db, `subscribe:${client}`, 8, 3_600_000, now))) return { outcome: 'limited', persona };
  const hash = emailHash(email);
  if (!(await rateLimit(db, `subscribe-email:${persona.id}:${hash.slice(0, 24)}`, 3, 3_600_000, now))) return { outcome: 'limited', persona };

  const region = input.region?.trim().toUpperCase().slice(0, 2) || null;
  const doubleOptIn = needsDoubleOptIn(region);
  const link = input.src && /^[a-z2-9]{4,16}$/.test(input.src)
    ? await db.maybeOne<{ id: string; post_id: string | null }>('SELECT id, post_id FROM short_link WHERE slug = $1 AND persona_id = $2', [input.src, persona.id])
    : null;
  const wording = consentWording(persona.name, await leadMagnetName(db, persona.id));

  const existing = await db.maybeOne<{ id: string; status: string; first_name: string | null }>('SELECT id, status, first_name FROM subscriber WHERE persona_id = $1 AND email = $2', [persona.id, email]);
  if (existing?.status === 'active') return { outcome: 'already', persona };
  // An opt-out stands until the person proves they control the mailbox. Anyone can type an address into the form, so
  // a complained or bounced address is never mailed again from here, and an unsubscribed one only gets the double
  // opt-in email; its status (and the provider's suppression) is unchanged until that link is clicked.
  if (existing && (existing.status === 'complained' || existing.status === 'bounced')) return { outcome: 'already', persona };
  if (existing?.status === 'unsubscribed') {
    await db.query(
      `INSERT INTO consent_record (persona_id, subscriber_id, kind, wording, source, region, ip_hash) VALUES ($1, $2, 'opt_in_requested', $3, $4, $5, $6)`,
      [persona.id, existing.id, wording, input.source ?? 'site', region, client],
    );
    await sendConfirmation(services, persona, existing.id, email, firstName ?? existing.first_name, { resubscribe: true });
    return { outcome: 'confirm_sent', persona };
  }

  const sub = await db.one<{ id: string }>(
    `INSERT INTO subscriber (persona_id, email, email_hash, first_name, consent, consent_at, status, double_opt_in, region, source, source_post_id, short_link_id, unsub_token)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (persona_id, email) DO UPDATE SET first_name = COALESCE(EXCLUDED.first_name, subscriber.first_name), consent = EXCLUDED.consent,
       consent_at = EXCLUDED.consent_at, status = EXCLUDED.status, double_opt_in = EXCLUDED.double_opt_in, region = EXCLUDED.region,
       source_post_id = COALESCE(subscriber.source_post_id, EXCLUDED.source_post_id), short_link_id = COALESCE(subscriber.short_link_id, EXCLUDED.short_link_id),
       unsub_token = COALESCE(subscriber.unsub_token, EXCLUDED.unsub_token), updated_at = now()
     RETURNING id`,
    [
      persona.id,
      email,
      hash,
      firstName,
      !doubleOptIn,
      doubleOptIn ? null : now,
      doubleOptIn ? 'pending' : 'active',
      doubleOptIn,
      region,
      input.source ?? 'site',
      link?.post_id ?? null,
      link?.id ?? null,
      newToken(18),
    ],
  );
  await db.query(
    `INSERT INTO consent_record (persona_id, subscriber_id, kind, wording, source, region, ip_hash) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [persona.id, sub.id, doubleOptIn ? 'opt_in_requested' : 'opt_in', wording, input.source ?? 'site', region, client],
  );
  if (doubleOptIn) {
    await sendConfirmation(services, persona, sub.id, email, firstName);
    return { outcome: 'confirm_sent', persona };
  }
  await activate(services, sub.id);
  return { outcome: 'subscribed', persona };
}

/** The double opt-in email (transactional: it's the request to confirm, not marketing). */
async function sendConfirmation(services: StudioServices, persona: SitePersona, subscriberId: string, email: string, firstName: string | null, opts: { resubscribe?: boolean } = {}): Promise<void> {
  const { db } = services;
  const now = services.now();
  const token = await issueToken(db, { personaId: persona.id, purpose: 'confirm', subscriberId, now, ref: opts.resubscribe ? { resubscribe: true } : {} });
  const list = await ensureList(services, persona.id);
  const kit = await loadPersonaKit(db, persona.id);
  const settings = await getCommerceSettings(db, persona.studioId);
  const url = sitePageUrl(persona.slug, `/confirm?t=${token}`);
  const mail = renderEmail({
    personaName: persona.name,
    colors: kit.colors,
    body: `Hi {{first_name}},\n\nPlease confirm you want emails from ${persona.name}. Tap the button and you're in.\n\nIf you didn't sign up, ignore this email and nothing happens.`,
    cta: { label: 'Confirm my email', url },
    footer: { reason: `Someone (hopefully you) asked to join ${persona.name}'s list.`, unsubscribeUrl: null, physicalAddress: settings.physicalAddress },
    vars: firstName ? { first_name: firstName } : {},
  });
  const subject = `Confirm your email for ${persona.name}`;
  const sent = await services.providers.audience.send({ from: list.from, to: email, subject, html: mail.html, text: mail.text, tags: { persona: persona.slug, kind: 'confirm' } });
  await db.query(
    `INSERT INTO email_message (persona_id, subscriber_id, kind, provider_id, subject) VALUES ($1, $2, 'confirm', $3, $4) ON CONFLICT (provider_id) DO NOTHING`,
    [persona.id, subscriberId, sent.id, subject],
  );
}

/** Confirms a double opt-in. Idempotent: a second click on the same link is a success. */
export async function confirmSubscription(services: StudioServices, token: string): Promise<{ ok: boolean; slug: string | null }> {
  const { db } = services;
  const now = services.now();
  const row = await readToken(db, token, 'confirm', now, { consume: true });
  if (!row) {
    const used = await findToken(db, token, 'confirm');
    if (used?.used_at && used.subscriber_id) {
      const s = await db.maybeOne<{ status: string; slug: string }>(`SELECT s.status, p.slug FROM subscriber s JOIN persona p ON p.id = s.persona_id WHERE s.id = $1`, [used.subscriber_id]);
      if (s?.status === 'active') return { ok: true, slug: s.slug };
    }
    return { ok: false, slug: null };
  }
  const s = await db.one<{ id: string; status: string; persona_id: string; slug: string; region: string | null }>(
    `SELECT s.id, s.status, s.persona_id, p.slug, s.region FROM subscriber s JOIN persona p ON p.id = s.persona_id WHERE s.id = $1`,
    [row.subscriber_id],
  );
  // Pending sign-ups confirm; an unsubscribed person comes back only through a link issued for that (resubscribe).
  const resubscribe = s.status === 'unsubscribed' && row.ref?.resubscribe === true;
  if (s.status !== 'pending' && !resubscribe) return { ok: s.status === 'active', slug: s.slug };
  await db.query(
    `UPDATE subscriber SET status = 'active', consent = true, consent_at = $2, confirmed_at = $2, unsubscribed_at = NULL, double_opt_in = true, provider_synced = true, updated_at = now() WHERE id = $1 AND status IN ('pending','unsubscribed')`,
    [s.id, now],
  );
  await db.query(`INSERT INTO consent_record (persona_id, subscriber_id, kind, source, region) VALUES ($1, $2, 'confirmed', 'double_opt_in', $3)`, [s.persona_id, s.id, s.region]);
  await db.query(`INSERT INTO email_event (persona_id, subscriber_id, type, meta) VALUES ($1, $2, 'confirmed', '{}'::jsonb)`, [s.persona_id, s.id]);
  await activate(services, s.id);
  return { ok: true, slug: s.slug };
}

/** A subscriber became active: sync the Resend contact, enrol in the welcome sequence and queue the first send. */
export async function activate(services: StudioServices, subscriberId: string): Promise<void> {
  const { db } = services;
  const s = await db.one<{ id: string; persona_id: string; email: string; first_name: string | null; studio_id: string }>(
    `SELECT s.id, s.persona_id, s.email, s.first_name, p.studio_id FROM subscriber s JOIN persona p ON p.id = s.persona_id WHERE s.id = $1`,
    [subscriberId],
  );
  const list = await ensureList(services, s.persona_id);
  const contact = await services.providers.audience.upsertContact({ audienceId: list.audienceId, email: s.email, firstName: s.first_name ?? undefined, unsubscribed: false });
  await db.query(`UPDATE subscriber SET contact_id = $2, updated_at = now() WHERE id = $1`, [s.id, contact.contactId]);
  await db.query(`INSERT INTO email_event (persona_id, subscriber_id, type, meta) VALUES ($1, $2, 'subscribed', $3::jsonb)`, [s.persona_id, s.id, json({ list: list.audienceId })]);
  const now = services.now();
  await db.query(
    `INSERT INTO email_enrollment (persona_id, subscriber_id, kind, next_step, started_at, next_at, status) VALUES ($1, $2, 'welcome', 0, $3, $3, 'active')
     ON CONFLICT (subscriber_id, kind) DO NOTHING`,
    [s.persona_id, s.id, now],
  );
  const seq = await db.maybeOne(`SELECT 1 FROM email_sequence WHERE persona_id = $1 AND kind = 'welcome' AND status = 'active'`, [s.persona_id]);
  if (!seq) await enqueueOnceFor(db, { kind: WRITE_WELCOME_JOB, key: `welcome:${s.persona_id}`, payload: { personaId: s.persona_id }, studioId: s.studio_id, personaId: s.persona_id });
  await enqueueOnceFor(db, { kind: SEND_DUE_JOB, key: 'email.send_due', payload: {}, studioId: s.studio_id, priority: 50 });
}

/** Unsubscribes by the subscriber's link token (one click or the page). Idempotent; true when the token is known. */
export async function unsubscribe(services: StudioServices, token: string, source: 'link' | 'one_click' | 'webhook' = 'link'): Promise<{ ok: boolean; slug: string | null }> {
  const { db } = services;
  if (!token || token.length > 100 || !/^[A-Za-z0-9_-]+$/.test(token)) return { ok: false, slug: null };
  const s = await db.maybeOne<{ id: string }>('SELECT id FROM subscriber WHERE unsub_token = $1', [token]);
  if (!s) return { ok: false, slug: null };
  return unsubscribeSubscriber(services, s.id, source);
}

export async function unsubscribeSubscriber(services: StudioServices, subscriberId: string, source: string, kind: 'unsubscribed' | 'complaint' = 'unsubscribed'): Promise<{ ok: boolean; slug: string | null }> {
  const { db } = services;
  const s = await db.one<{ id: string; persona_id: string; email: string; status: string; slug: string }>(
    `SELECT s.id, s.persona_id, s.email, s.status, p.slug FROM subscriber s JOIN persona p ON p.id = s.persona_id WHERE s.id = $1`,
    [subscriberId],
  );
  if (s.status === 'unsubscribed' || s.status === 'complained') return { ok: true, slug: s.slug };
  const now = services.now();
  await db.query(`UPDATE subscriber SET status = $2, unsubscribed_at = $3, updated_at = now() WHERE id = $1`, [s.id, kind === 'complaint' ? 'complained' : 'unsubscribed', now]);
  await db.query(`UPDATE email_enrollment SET status = 'stopped', updated_at = now() WHERE subscriber_id = $1 AND status = 'active'`, [s.id]);
  await db.query(`INSERT INTO consent_record (persona_id, subscriber_id, kind, source) VALUES ($1, $2, $3, $4)`, [s.persona_id, s.id, kind, source]);
  await db.query(`INSERT INTO email_event (persona_id, subscriber_id, type, meta) VALUES ($1, $2, $3, $4::jsonb)`, [s.persona_id, s.id, kind === 'complaint' ? 'complained' : 'unsubscribed', json({ source })]);
  if (source !== 'webhook') {
    // Broadcasts go to the provider's audience, so the opt-out must reach it. A failure is recorded (provider_synced =
    // false): email.send_due retries it, and sendBroadcast refuses while any opt-out of this persona is unsynced.
    await db.query(`UPDATE subscriber SET provider_synced = false WHERE id = $1`, [s.id]);
    await syncSubscriberOptOut(services, s.id);
  }
  return { ok: true, slug: s.slug };
}

/** Pushes one local opt-out to the provider; true when it is synced (or there is nothing to sync). */
async function syncSubscriberOptOut(services: StudioServices, subscriberId: string): Promise<boolean> {
  const { db } = services;
  const s = await db.maybeOne<{ id: string; persona_id: string; email: string; status: string }>(`SELECT id, persona_id, email, status FROM subscriber WHERE id = $1`, [subscriberId]);
  if (!s) return true;
  // The person came back (a confirmed resubscribe) after an opt-out that never synced: that opt-out is superseded, and
  // pushing it now would suppress an active subscriber at the provider.
  if (!['unsubscribed', 'complained', 'bounced'].includes(s.status)) {
    await db.query(`UPDATE subscriber SET provider_synced = true WHERE id = $1`, [s.id]);
    return true;
  }
  const list = await db.maybeOne<{ audience_id: string }>('SELECT audience_id FROM email_list WHERE persona_id = $1', [s.persona_id]);
  try {
    if (list) await services.providers.audience.upsertContact({ audienceId: list.audience_id, email: s.email, unsubscribed: true });
  } catch {
    return false;
  }
  await db.query(`UPDATE subscriber SET provider_synced = true WHERE id = $1`, [s.id]);
  return true;
}

/** Retries opt-outs that haven't reached the provider (email.send_due, and before every broadcast). Returns how many are still unsynced. */
export async function syncPendingOptOuts(services: StudioServices, opts: { personaId?: string; limit?: number } = {}): Promise<{ synced: number; pending: number }> {
  const { db } = services;
  const rows = await db.query<{ id: string }>(
    `SELECT id FROM subscriber WHERE provider_synced = false AND ($1::uuid IS NULL OR persona_id = $1) ORDER BY updated_at LIMIT $2`,
    [opts.personaId ?? null, opts.limit ?? 200],
  );
  let synced = 0;
  for (const r of rows) if (await syncSubscriberOptOut(services, r.id)) synced += 1;
  const left = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM subscriber WHERE provider_synced = false AND ($1::uuid IS NULL OR persona_id = $1)`, [opts.personaId ?? null]);
  return { synced, pending: left.n };
}

/** The unsubscribe URL for a subscriber (List-Unsubscribe + footer). */
export const unsubscribeUrl = (slug: string, token: string): string => sitePageUrl(slug, `/unsubscribe?t=${token}`);
export const oneClickUnsubscribeUrl = (slug: string, token: string): string => publicEndpointUrl(slug, `/api/public/unsubscribe?t=${token}`);

/** Queue the due-email sender now (e.g. after a confirmation). */
export async function kickSender(db: Db, studioId: string | null): Promise<void> {
  await enqueueOnceFor(db, { kind: SEND_DUE_JOB, key: 'email.send_due', payload: {}, studioId, priority: 50 });
}

