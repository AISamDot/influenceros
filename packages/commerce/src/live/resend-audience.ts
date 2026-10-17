import { createHmac, timingSafeEqual } from 'node:crypto';
import { inspect } from 'node:util';
import type { AudienceProvider, EmailWebhookEvent } from '@troupe/providers';
import { asRecord, asString } from '../util';

/**
 * Live Resend audiences adapter (REST, https://api.resend.com): one audience per persona list, contacts, single sends
 * (sequence steps, double opt-in, member sign-in links) with List-Unsubscribe headers, broadcasts, and Svix-signed
 * webhooks. Without `resend.webhook_secret` webhooks are refused (verify returns false) and the studio relies on
 * its own unsubscribe links. Keys stay inside this object.
 */
export const RESEND_API = 'https://api.resend.com';
const TOLERANCE_S = 5 * 60;

const tagValue = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 256);

export class ResendAudience implements AudienceProvider {
  readonly name = 'resend-audience';
  readonly #apiKey: string;
  readonly #webhookSecret: string | null;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;

  constructor(opts: { apiKey: string; webhookSecret?: string | null; fetch?: typeof fetch; now?: () => Date }) {
    if (!opts.apiKey) throw new Error('ResendAudience needs an API key');
    this.#apiKey = opts.apiKey;
    this.#webhookSecret = opts.webhookSecret || null;
    this.#fetch = opts.fetch ?? fetch;
    this.#now = opts.now ?? (() => new Date());
  }

  async #call<T = Record<string, unknown>>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<{ ok: boolean; status: number; body: T }> {
    const res = await this.#fetch(`${RESEND_API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.#apiKey}`, 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    return { ok: res.ok, status: res.status, body: (await res.json().catch(() => ({}))) as T };
  }

  #fail(what: string, r: { status: number; body: unknown }): never {
    const b = asRecord(r.body);
    throw new Error(`resend ${what}: ${r.status} ${asString(b.name)} ${asString(b.message)}`.trim());
  }

  async ensureAudience(req: { name: string }): Promise<{ audienceId: string }> {
    const list = await this.#call<{ data?: Array<{ id: string; name: string }> }>('GET', '/audiences');
    if (!list.ok) this.#fail('audiences', list);
    const found = list.body.data?.find((a) => a.name === req.name);
    if (found) return { audienceId: found.id };
    const created = await this.#call<{ id?: string }>('POST', '/audiences', { name: req.name });
    if (!created.ok || !created.body.id) this.#fail('create audience', created);
    return { audienceId: created.body.id! };
  }

  async upsertContact(req: { audienceId: string; email: string; firstName?: string; unsubscribed?: boolean }): Promise<{ contactId: string }> {
    const fields = { ...(req.firstName ? { first_name: req.firstName } : {}), unsubscribed: req.unsubscribed ?? false };
    const aid = encodeURIComponent(req.audienceId);
    const created = await this.#call<{ id?: string }>('POST', `/audiences/${aid}/contacts`, { email: req.email, ...fields });
    if (created.ok && created.body.id) return { contactId: created.body.id };
    // Already in the audience: update it in place.
    const updated = await this.#call<{ id?: string }>('PATCH', `/audiences/${aid}/contacts/${encodeURIComponent(req.email)}`, fields);
    if (!updated.ok) this.#fail('contact', updated);
    return { contactId: updated.body.id ?? req.email };
  }

  async send(req: {
    from: string;
    to: string;
    subject: string;
    html: string;
    text?: string;
    replyTo?: string;
    headers?: Readonly<Record<string, string>>;
    tags?: Readonly<Record<string, string>>;
  }): Promise<{ id: string }> {
    const r = await this.#call<{ id?: string }>('POST', '/emails', {
      from: req.from,
      to: [req.to],
      subject: req.subject,
      html: req.html,
      ...(req.text ? { text: req.text } : {}),
      ...(req.replyTo ? { reply_to: req.replyTo } : {}),
      ...(req.headers ? { headers: req.headers } : {}),
      ...(req.tags ? { tags: Object.entries(req.tags).map(([name, value]) => ({ name: tagValue(name), value: tagValue(value) })) } : {}),
    });
    if (!r.ok || !r.body.id) this.#fail('send', r);
    return { id: r.body.id! };
  }

  async sendBroadcast(req: { audienceId: string; from: string; subject: string; html: string; name?: string }): Promise<{ id: string }> {
    const created = await this.#call<{ id?: string }>('POST', '/broadcasts', {
      audience_id: req.audienceId,
      from: req.from,
      subject: req.subject,
      html: req.html,
      ...(req.name ? { name: req.name } : {}),
    });
    if (!created.ok || !created.body.id) this.#fail('broadcast', created);
    const sent = await this.#call('POST', `/broadcasts/${encodeURIComponent(created.body.id!)}/send`, {});
    if (!sent.ok) this.#fail('broadcast send', sent);
    return { id: created.body.id! };
  }

  verifyWebhook(rawBody: string, headers: Readonly<Record<string, string | null | undefined>>): boolean {
    if (!this.#webhookSecret) return false;
    return verifySvix(this.#webhookSecret, rawBody, headers, this.#now());
  }

  parseWebhook(rawBody: string): EmailWebhookEvent[] {
    return parseResendWebhook(rawBody);
  }

  toJSON(): string {
    return '[ResendAudience]';
  }
  [inspect.custom](): string {
    return '[ResendAudience]';
  }
}

/** Svix signature check: base64 HMAC-SHA256 of `${id}.${timestamp}.${body}` with the `whsec_` secret, 5-minute tolerance. */
export function verifySvix(secret: string, rawBody: string, headers: Readonly<Record<string, string | null | undefined>>, now: Date = new Date()): boolean {
  const id = headers['svix-id'];
  const ts = headers['svix-timestamp'];
  const sigs = headers['svix-signature'];
  if (!id || !ts || !sigs || !/^\d{1,12}$/.test(ts)) return false;
  if (Math.abs(now.getTime() / 1000 - Number(ts)) > TOLERANCE_S) return false;
  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${ts}.${rawBody}`).digest();
  return sigs.split(' ').some((part) => {
    const [version, sig] = part.split(',');
    if (version !== 'v1' || !sig) return false;
    const got = Buffer.from(sig, 'base64');
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

/** Signs like Svix (tests and local tooling). */
export function signSvix(secret: string, rawBody: string, id: string, timestamp: number): string {
  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest('base64')}`;
}

const EMAIL_TYPES: Record<string, Exclude<EmailWebhookEvent['type'], 'contact_unsubscribed'>> = {
  'email.delivered': 'delivered',
  'email.opened': 'opened',
  'email.clicked': 'clicked',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
};

/** Resend webhook body → events. Unknown types (sent, delivery_delayed, contact.created …) map to nothing. */
export function parseResendWebhook(rawBody: string): EmailWebhookEvent[] {
  const v = JSON.parse(rawBody) as unknown;
  const items = Array.isArray(v) ? v : [v];
  const out: EmailWebhookEvent[] = [];
  for (const item of items) {
    const e = asRecord(item);
    const type = asString(e.type);
    const d = asRecord(e.data);
    const at = new Date(asString(e.created_at) || asString(d.created_at) || Date.now());
    if (EMAIL_TYPES[type]) {
      const to = Array.isArray(d.to) ? asString(d.to[0]) : asString(d.to);
      const link = asString(asRecord(d.click).link) || undefined;
      out.push({ type: EMAIL_TYPES[type]!, emailId: asString(d.email_id), to, at, ...(link ? { link } : {}) });
    } else if (type === 'contact.updated' && d.unsubscribed === true) {
      out.push({ type: 'contact_unsubscribed', audienceId: asString(d.audience_id), email: asString(d.email), at });
    }
  }
  return out;
}
