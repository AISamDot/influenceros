import type { AgentTask, StudioServices } from '@ios/agents';
import { describe, expect, it } from 'vitest';
import {
  confirmSubscription,
  downloadByToken,
  handleEmailWebhook,
  sendBroadcast,
  sendDueEmails,
  subscribe,
  syncPendingOptOuts,
  unsubscribe,
  writeWelcomeSequence,
} from '../src';
import { ADDRESS, persona, product, studio } from './helpers';

const sends = (t: { providers: { audience: { callsTo(m: string): Array<{ args: unknown }> } } }) =>
  t.providers.audience.callsTo('send').map((c) => c.args as { to: string; subject: string; html: string; text: string; headers?: Record<string, string>; tags?: Record<string, string> });

describe('opt-in: consent records, double opt-in for the EU, no enumeration', () => {
  it('an EU sign-up is pending until confirmed; confirming activates, logs consent and enrols in the welcome sequence', async () => {
    const t = await studio();
    const p = await persona(t);
    const r = await subscribe(t.services, { slug: p.slug, email: ' Ana@Example.com ', firstName: 'Ana', region: 'DE', ip: '1.2.3.4' });
    expect(r.outcome).toBe('confirm_sent');
    const s = await t.db.one<{ id: string; status: string; consent: boolean; email: string }>('SELECT id, status, consent, email FROM subscriber');
    expect(s).toMatchObject({ status: 'pending', consent: false, email: 'ana@example.com' });
    const mail = sends(t)[0]!;
    expect(mail.to).toBe('ana@example.com');
    const token = /\/confirm\?t=([A-Za-z0-9_-]+)/.exec(mail.html)![1]!;
    expect(t.providers.audience.callsTo('upsertContact')).toHaveLength(0);

    expect(await confirmSubscription(t.services, 'not-a-token')).toEqual({ ok: false, slug: null });
    expect(await confirmSubscription(t.services, token)).toEqual({ ok: true, slug: p.slug });
    expect(await confirmSubscription(t.services, token)).toEqual({ ok: true, slug: p.slug }); // second click is fine
    const after = await t.db.one<{ status: string; consent: boolean; confirmed_at: Date | null }>('SELECT status, consent, confirmed_at FROM subscriber');
    expect(after.status).toBe('active');
    expect(after.consent).toBe(true);
    expect(after.confirmed_at).not.toBeNull();
    const kinds = (await t.db.query<{ kind: string; wording: string | null }>('SELECT kind, wording FROM consent_record ORDER BY created_at')).map((c) => c.kind);
    expect(kinds).toEqual(['opt_in_requested', 'confirmed']);
    expect(t.providers.audience.callsTo('upsertContact')).toHaveLength(1);
    expect((await t.db.query(`SELECT 1 FROM email_enrollment WHERE status = 'active'`)).length).toBe(1);
    expect((await t.db.query(`SELECT kind FROM job WHERE kind IN ('email.write_welcome','email.send_due')`)).length).toBe(2);
  });

  it('outside the EU it is single opt-in with consent logged; unknown regions get double opt-in', async () => {
    const t = await studio();
    const p = await persona(t);
    expect((await subscribe(t.services, { slug: p.slug, email: 'us@example.com', region: 'US' })).outcome).toBe('subscribed');
    expect((await subscribe(t.services, { slug: p.slug, email: 'who@example.com', region: null })).outcome).toBe('confirm_sent');
    const rows = await t.db.query<{ email: string; status: string; double_opt_in: boolean }>('SELECT email, status, double_opt_in FROM subscriber ORDER BY email');
    expect(rows).toEqual([
      { email: 'us@example.com', status: 'active', double_opt_in: false },
      { email: 'who@example.com', status: 'pending', double_opt_in: true },
    ]);
    const c = await t.db.one<{ kind: string; wording: string }>(`SELECT c.kind, c.wording FROM consent_record c JOIN subscriber s ON s.id = c.subscriber_id WHERE s.email = 'us@example.com'`);
    expect(c.kind).toBe('opt_in');
    expect(c.wording).toMatch(/unsubscribe at any time/);
  });

  it('honeypots, repeats and rate limits look the same from outside; bad input and hidden sites are refused', async () => {
    const t = await studio();
    const p = await persona(t);
    expect((await subscribe(t.services, { slug: p.slug, email: 'bot@example.com', honeypot: 'http://spam', region: 'US' })).outcome).toBe('ignored');
    expect((await t.db.query('SELECT 1 FROM subscriber')).length).toBe(0);
    await subscribe(t.services, { slug: p.slug, email: 'a@example.com', region: 'US' });
    expect((await subscribe(t.services, { slug: p.slug, email: 'a@example.com', region: 'US' })).outcome).toBe('already');
    for (let i = 0; i < 8; i += 1) await subscribe(t.services, { slug: p.slug, email: `x${i}@example.com`, region: 'US', ip: '9.9.9.9' });
    expect((await subscribe(t.services, { slug: p.slug, email: 'late@example.com', region: 'US', ip: '9.9.9.9' })).outcome).toBe('limited');
    await expect(subscribe(t.services, { slug: p.slug, email: 'not-an-email', region: 'US' })).rejects.toThrow(/valid email/);
    const killed = await persona(t, { state: 'KILLED' });
    await expect(subscribe(t.services, { slug: killed.slug, email: 'a@example.com' })).rejects.toThrow(/unknown site/);
  });
});

describe('welcome sequence: 5 Gate-checked emails, unsubscribe and the physical-address footer', () => {
  it('writes five green emails and sends them over a week with List-Unsubscribe and the footer; unsubscribing stops it', async () => {
    let now = new Date('2026-10-12T09:00:00Z');
    const t = await studio({ now: () => now });
    const p = await persona(t);
    await product(t, p.id, { name: 'Free Fridge Checklist', rung: 'lead_magnet', status: 'live', price: 0, file: true });
    await product(t, p.id, { name: 'Kitchen Reset Workbook', status: 'live', checkoutUrl: 'https://s.lemonsqueezy.com/buy/1' });
    const w = await writeWelcomeSequence(t.services, p.id);
    expect(w).toMatchObject({ status: 'active', verdict: 'green' });
    const seq = await t.db.one<{ steps: Array<{ day: number; gate: { verdict: string } }> }>('SELECT steps FROM email_sequence WHERE id = $1', [w.sequenceId]);
    expect(seq.steps.map((s) => s.day)).toEqual([0, 1, 3, 5, 7]);
    expect(seq.steps.every((s) => s.gate.verdict === 'green')).toBe(true);

    await subscribe(t.services, { slug: p.slug, email: 'ben@example.com', firstName: 'Ben', region: 'US' });
    expect((await sendDueEmails(t.services)).sent).toBe(1);
    const first = sends(t).at(-1)!;
    expect(first.subject).toBe('Here\'s Free Fridge Checklist');
    expect(first.html).toContain('Hi Ben,');
    expect(first.html).toContain(ADDRESS);
    expect(first.html).toMatch(/\/unsubscribe\?t=/);
    expect(first.text).toContain(ADDRESS);
    expect(first.headers?.['List-Unsubscribe']).toMatch(/^<.*\/api\/public\/unsubscribe\?t=[A-Za-z0-9_-]+>$/);
    expect(first.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    // The lead magnet download link works without the Owner session.
    const dl = /\/api\/public\/download\?t=([A-Za-z0-9_-]+)/.exec(first.html)![1]!;
    const file = await downloadByToken(t.services, dl);
    expect(file?.contentType).toBe('application/pdf');
    expect(new TextDecoder().decode(file!.data)).toContain('%PDF');

    expect((await sendDueEmails(t.services)).sent).toBe(0); // nothing due yet
    now = new Date('2026-10-13T09:00:01Z');
    expect((await sendDueEmails(t.services)).sent).toBe(1);
    now = new Date('2026-10-15T09:00:01Z');
    expect((await sendDueEmails(t.services)).sent).toBe(1);
    expect(sends(t).at(-1)!.html).not.toContain('{{');

    const tok = (await t.db.one<{ unsub_token: string }>('SELECT unsub_token FROM subscriber')).unsub_token;
    expect(await unsubscribe(t.services, tok, 'one_click')).toEqual({ ok: true, slug: p.slug });
    expect(await unsubscribe(t.services, tok)).toEqual({ ok: true, slug: p.slug });
    expect(t.providers.audience.callsTo('upsertContact').at(-1)!.args).toMatchObject({ unsubscribed: true });
    now = new Date('2026-10-30T09:00:00Z');
    expect((await sendDueEmails(t.services)).sent).toBe(0);
    expect((await t.db.one<{ status: string }>('SELECT status FROM email_enrollment')).status).toBe('stopped');
    expect((await t.db.query(`SELECT 1 FROM email_event WHERE type = 'sent'`)).length).toBe(3);
  });

  it('never sends marketing email without a physical address (the Owner is told once)', async () => {
    const t = await studio({ address: false });
    const p = await persona(t);
    await writeWelcomeSequence(t.services, p.id);
    await subscribe(t.services, { slug: p.slug, email: 'c@example.com', region: 'US' });
    const r = await sendDueEmails(t.services);
    expect(r).toMatchObject({ sent: 0, waiting: 1, blocked: 'physical_address' });
    await sendDueEmails(t.services);
    expect((await t.db.query(`SELECT 1 FROM notification WHERE title LIKE 'Add the physical address%'`)).length).toBe(1);
    expect(sends(t)).toHaveLength(0);
    const b = await sendBroadcast(t.services, { personaId: p.id, subject: 'Hello', body: 'A short note about kitchen zones and how to set them up this week.', createdBy: 'owner' });
    expect(b).toMatchObject({ status: 'blocked', reason: 'physical_address' });
  });

  it('a red draft gets one rewrite; still red, it stays a draft, nothing sends and the Owner is told', async () => {
    const t = await studio();
    const p = await persona(t);
    const real = t.services.runtime;
    const runtime = {
      mode: real.mode,
      run: async <T>(task: AgentTask<T>) => {
        if (task.agent !== 'email-writer') return real.run(task);
        const bad = Array.from({ length: 5 }, (_, i) => ({ subject: `Email ${i + 1}`, preheader: '', body: 'This system is guaranteed to make you $5,000 a month. Only 3 spots left, buy now before midnight!', cta_label: 'Go' }));
        return real.run({ ...task, fake: () => task.parse!({ emails: bad }) });
      },
    };
    const services: StudioServices = { ...t.services, runtime };
    const w = await writeWelcomeSequence(services, p.id);
    expect(w).toMatchObject({ status: 'draft', verdict: 'red' });
    expect((await t.db.query(`SELECT 1 FROM agent_run WHERE agent = 'email-writer'`)).length).toBe(2);
    expect((await t.db.query(`SELECT 1 FROM email_sequence WHERE status = 'active'`)).length).toBe(0);
    expect((await t.db.query(`SELECT 1 FROM notification WHERE title LIKE '%blocked by the Gate'`)).length).toBe(1);
    await subscribe(t.services, { slug: p.slug, email: 'd@example.com', region: 'US' });
    expect((await sendDueEmails(t.services)).sent).toBe(0);

    const b = await sendBroadcast(t.services, { personaId: p.id, subject: 'Big news', body: 'Guaranteed income: you will make $5,000 a month with this.', createdBy: 'persona-manager' });
    expect(b).toMatchObject({ status: 'blocked', reason: 'gate_red' });
    expect(t.providers.audience.callsTo('sendBroadcast')).toHaveLength(0);
  });

  it('broadcasts go to the persona audience with Resend’s unsubscribe placeholder and the address', async () => {
    const t = await studio();
    const p = await persona(t);
    const b = await sendBroadcast(t.services, { personaId: p.id, subject: 'Three fridge zones', body: 'Hi {{first_name}},\n\nHere are the three zones I use: top shelf for leftovers, middle for dairy, bottom for raw food.', createdBy: 'owner' });
    expect(b.status).toBe('sent');
    const call = t.providers.audience.callsTo('sendBroadcast')[0]!.args as { html: string; audienceId: string; from: string };
    expect(call.html).toContain('{{{RESEND_UNSUBSCRIBE_URL}}}');
    expect(call.html).toContain(ADDRESS);
    expect(call.from).toBe(`${p.name} <${p.slug}@mail.studio.test>`);
  });
});

describe('opt-outs stand', () => {
  it('an unsubscribe that fails to reach Resend is retried, and broadcasts wait until it lands', async () => {
    const t = await studio();
    const p = await persona(t);
    await subscribe(t.services, { slug: p.slug, email: 'gone@example.com', region: 'US' });
    const token = (await t.db.one<{ unsub_token: string }>('SELECT unsub_token FROM subscriber')).unsub_token;
    const aud = t.providers.audience;
    const real = aud.upsertContact.bind(aud);
    aud.upsertContact = async () => {
      throw new Error('resend 503');
    };
    expect((await unsubscribe(t.services, token)).ok).toBe(true);
    const row = await t.db.one<{ status: string; provider_synced: boolean }>('SELECT status, provider_synced FROM subscriber');
    expect(row).toEqual({ status: 'unsubscribed', provider_synced: false });
    const blocked = await sendBroadcast(t.services, { personaId: p.id, subject: 'Three fridge zones', body: 'Here are the three zones I use: top shelf for leftovers, middle for dairy.', createdBy: 'owner' });
    expect(blocked).toMatchObject({ status: 'blocked', reason: 'unsynced_unsubscribes' });
    expect(aud.callsTo('sendBroadcast')).toHaveLength(0);
    // Resend is back: the sweep syncs it and the next broadcast goes out.
    aud.upsertContact = real;
    expect(await syncPendingOptOuts(t.services)).toEqual({ synced: 1, pending: 0 });
    expect([...aud.contacts.values()].find((c) => c.email === 'gone@example.com')!.unsubscribed).toBe(true);
    const sent = await sendBroadcast(t.services, { personaId: p.id, subject: 'Three fridge zones', body: 'Here are the three zones I use: top shelf for leftovers, middle for dairy.', createdBy: 'owner' });
    expect(sent.status).toBe('sent');
  });

  it('a third party typing an opted-out address never re-enrols it; an unsubscribed person can come back via the confirm link', async () => {
    const t = await studio();
    const p = await persona(t);
    await subscribe(t.services, { slug: p.slug, email: 'left@example.com', region: 'US' });
    await subscribe(t.services, { slug: p.slug, email: 'complainer@example.com', region: 'US' });
    const token = (await t.db.one<{ unsub_token: string }>(`SELECT unsub_token FROM subscriber WHERE email = 'left@example.com'`)).unsub_token;
    await unsubscribe(t.services, token);
    await t.db.query(`UPDATE subscriber SET status = 'complained' WHERE email = 'complainer@example.com'`);
    const before = sends(t).length;
    const upserts = t.providers.audience.callsTo('upsertContact').length;

    expect((await subscribe(t.services, { slug: p.slug, email: 'complainer@example.com', region: 'US' })).outcome).toBe('already');
    expect((await subscribe(t.services, { slug: p.slug, email: 'left@example.com', region: 'US' })).outcome).toBe('confirm_sent');
    const statuses = await t.db.query<{ email: string; status: string }>('SELECT email, status FROM subscriber ORDER BY email');
    expect(statuses).toEqual([
      { email: 'complainer@example.com', status: 'complained' },
      { email: 'left@example.com', status: 'unsubscribed' },
    ]);
    // Only the confirm email went out (to the unsubscribed address), and Resend's suppression is untouched.
    const mails = sends(t).slice(before);
    expect(mails.map((m) => m.to)).toEqual(['left@example.com']);
    expect(t.providers.audience.callsTo('upsertContact')).toHaveLength(upserts);
    const link = /\/confirm\?t=([A-Za-z0-9_-]+)/.exec(mails[0]!.html)![1]!;
    expect(await confirmSubscription(t.services, link)).toEqual({ ok: true, slug: p.slug });
    expect((await t.db.one<{ status: string }>(`SELECT status FROM subscriber WHERE email = 'left@example.com'`)).status).toBe('active');
  });
});

describe('Resend webhooks', () => {
  it('records delivery events, bounces stop the sequence, complaints unsubscribe; unsigned is refused; replays skip', async () => {
    const t = await studio();
    const p = await persona(t);
    await writeWelcomeSequence(t.services, p.id);
    await subscribe(t.services, { slug: p.slug, email: 'e@example.com', region: 'US' });
    await subscribe(t.services, { slug: p.slug, email: 'f@example.com', region: 'US' });
    await sendDueEmails(t.services);
    const msgs = await t.db.query<{ provider_id: string; email: string }>(`SELECT m.provider_id, s.email FROM email_message m JOIN subscriber s ON s.id = m.subscriber_id ORDER BY s.email`);
    const body = JSON.stringify([
      { type: 'delivered', emailId: msgs[0]!.provider_id, to: 'e@example.com', at: new Date().toISOString() },
      { type: 'bounced', emailId: msgs[0]!.provider_id, to: 'e@example.com', at: new Date().toISOString() },
      { type: 'complained', emailId: msgs[1]!.provider_id, to: 'f@example.com', at: new Date().toISOString() },
    ]);
    expect((await handleEmailWebhook(t.services, body, { 'svix-signature': 'nope' })).status).toBe(401);
    const headers = { 'svix-id': 'msg_1', 'svix-signature': t.providers.audience.sign(body) };
    expect(await handleEmailWebhook(t.services, body, headers)).toMatchObject({ status: 200, outcome: 'processed' });
    expect(await handleEmailWebhook(t.services, body, headers)).toMatchObject({ outcome: 'duplicate' });
    const subs = await t.db.query<{ email: string; status: string }>('SELECT email, status FROM subscriber ORDER BY email');
    expect(subs).toEqual([
      { email: 'e@example.com', status: 'bounced' },
      { email: 'f@example.com', status: 'complained' },
    ]);
    expect((await t.db.query(`SELECT 1 FROM email_enrollment WHERE status = 'active'`)).length).toBe(0);
    const types = (await t.db.query<{ type: string }>(`SELECT type FROM email_event WHERE type IN ('delivered','bounced','complained') ORDER BY type`)).map((r) => r.type);
    expect(types).toEqual(['bounced', 'complained', 'delivered']);

    const list = await t.db.one<{ audience_id: string }>('SELECT audience_id FROM email_list');
    await subscribe(t.services, { slug: p.slug, email: 'g@example.com', region: 'US' });
    const unsub = JSON.stringify({ type: 'contact_unsubscribed', audienceId: list.audience_id, email: 'g@example.com', at: new Date().toISOString() });
    await handleEmailWebhook(t.services, unsub, { 'svix-id': 'msg_2', 'svix-signature': t.providers.audience.sign(unsub) });
    expect((await t.db.one<{ status: string }>(`SELECT status FROM subscriber WHERE email = 'g@example.com'`)).status).toBe('unsubscribed');
  });
});
