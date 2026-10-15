import { describe, expect, it } from 'vitest';
import {
  applySubscriptionEvent,
  ensureMonthlyDrop,
  handleStoreWebhook,
  hasAccess,
  memberDrops,
  memberFile,
  memberFromSession,
  membershipStats,
  requestMemberLink,
  syncCommunityAccess,
  verifyMemberLink,
  type CommunityGate,
} from '../src';
import { linkStore, persona, product, signed, studio } from './helpers';

describe('membership: subscriptions gate the members area', () => {
  it('a subscription webhook makes a member; a magic link signs them in to the monthly drop; cancel ends access at period end', async () => {
    let now = new Date('2026-11-02T10:00:00Z');
    const t = await studio({ now: () => now });
    const p = await persona(t);
    await linkStore(t, p.id, p.slug);
    const club = await product(t, p.id, { name: 'Home Reset Club', rung: 'membership', status: 'live', price: 900, storeProductId: 'lsp_club', checkoutUrl: 'https://a.lemonsqueezy.com/buy/club' });
    const ev = signed(t, { type: 'subscription_created', subscriptionId: 'sub_1', productId: 'lsp_club', storeId: 'st_1', email: 'Mia@Example.com', status: 'active' });
    expect((await handleStoreWebhook(t.services, ev.body, ev.sig)).outcome).toBe('processed');
    const m = await t.db.one<{ id: string; status: string; price_cents: number; product_id: string; email: string }>('SELECT * FROM membership');
    expect(m).toMatchObject({ status: 'active', price_cents: 900, product_id: club.id, email: 'mia@example.com' });
    expect(await membershipStats(t.db, p.id, now)).toMatchObject({ members: 1, mrrCents: 900 });

    // No enumeration: an unknown address "succeeds" the same way but nothing is sent.
    expect(await requestMemberLink(t.services, { slug: p.slug, email: 'nobody@example.com' })).toEqual({ sent: false });
    expect(t.providers.audience.callsTo('send')).toHaveLength(0);
    expect(await requestMemberLink(t.services, { slug: p.slug, email: 'mia@example.com' })).toEqual({ sent: true });
    const mail = t.providers.audience.callsTo('send')[0]!.args as { to: string; html: string };
    expect(mail.to).toBe('mia@example.com');
    const token = /\/members\/verify\?t=([A-Za-z0-9_-]+)/.exec(mail.html)![1]!;
    expect(await verifyMemberLink(t.services, { slug: 'wrong-site', token })).toBeNull();
    const session = (await verifyMemberLink(t.services, { slug: p.slug, token }))!;
    expect(session.session).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(await verifyMemberLink(t.services, { slug: p.slug, token })).toBeNull(); // one use
    expect(await memberFromSession(t.db, { slug: p.slug, session: session.session, now })).not.toBeNull();
    expect(await memberFromSession(t.db, { slug: 'other', session: session.session, now })).toBeNull();
    expect(await memberFromSession(t.db, { slug: p.slug, session: 'forged', now })).toBeNull();

    // The month's drop: none built yet → a members pack is briefed and the drop waits.
    const pending = await ensureMonthlyDrop(t.services, p.id, now);
    expect(pending).toMatchObject({ month: '2026-11', status: 'pending', title: 'November members pack' });
    const briefed = await t.db.one<{ id: string; status: string; ladder_rung: string }>(`SELECT id, status, ladder_rung FROM product WHERE persona_id = $1 AND id <> $2 AND ladder_rung = 'membership'`, [p.id, club.id]);
    expect(briefed.status).toBe('brief');
    await ensureMonthlyDrop(t.services, p.id, now);
    expect((await t.db.query(`SELECT 1 FROM product WHERE ladder_rung = 'membership' AND status = 'brief'`)).length).toBe(1);

    // H builds it, the Owner approves v1: the next run makes it ready and tells members.
    const key = `products/${p.id}/${briefed.id}/v1/a4.pdf`;
    const stored = await t.providers.storage.put({ key, data: '%PDF members', contentType: 'application/pdf' });
    await t.db.query(`UPDATE product SET status = 'approved', current_version = 1 WHERE id = $1`, [briefed.id]);
    await t.db.query(`INSERT INTO product_version (product_id, persona_id, version, file_url, status) VALUES ($1, $2, 1, $3, 'approved')`, [briefed.id, p.id, stored.url]);
    const ready = (await ensureMonthlyDrop(t.services, p.id, now))!;
    expect(ready.status).toBe('ready');
    expect(t.providers.audience.callsTo('send').map((c) => (c.args as { subject: string }).subject).at(-1)).toMatch(/^New this month/);
    await ensureMonthlyDrop(t.services, p.id, now);
    expect(t.providers.audience.callsTo('send').filter((c) => (c.args as { subject: string }).subject.startsWith('New this month'))).toHaveLength(1);
    expect((await memberDrops(t.db, p.id)).map((d) => d.title)).toEqual(['November members pack']);
    const file = await memberFile(t.services, { slug: p.slug, session: session.session, dropId: ready.id });
    expect(new TextDecoder().decode(file!.data)).toBe('%PDF members');
    expect(await memberFile(t.services, { slug: p.slug, session: 'nope', dropId: ready.id })).toBeNull();

    // Cancelled: access continues until the paid period ends, then stops.
    const cancel = signed(t, { type: 'subscription_updated', subscriptionId: 'sub_1', status: 'cancelled', endsAt: '2026-12-02T10:00:00Z' });
    await handleStoreWebhook(t.services, cancel.body, cancel.sig);
    expect(await memberFromSession(t.db, { slug: p.slug, session: session.session, now })).not.toBeNull();
    now = new Date('2026-12-03T00:00:00Z');
    expect(await memberFromSession(t.db, { slug: p.slug, session: session.session, now })).toBeNull();
  });

  it('a failed payment keeps access for the 7-day grace period', async () => {
    const now = new Date('2026-11-10T00:00:00Z');
    expect(hasAccess({ status: 'past_due', past_due_since: new Date('2026-11-05T00:00:00Z'), ends_at: null }, now)).toBe(true);
    expect(hasAccess({ status: 'past_due', past_due_since: new Date('2026-11-01T00:00:00Z'), ends_at: null }, now)).toBe(false);
    expect(hasAccess({ status: 'cancelled', past_due_since: null, ends_at: null }, now)).toBe(false);
    expect(hasAccess({ status: 'trial', past_due_since: null, ends_at: null }, now)).toBe(true);

    const t = await studio({ now: () => now });
    const p = await persona(t);
    await linkStore(t, p.id, p.slug);
    await product(t, p.id, { name: 'Club', rung: 'membership', status: 'live', price: 700, storeProductId: 'lsp_c' });
    const created = signed(t, { type: 'subscription_created', subscriptionId: 'sub_9', productId: 'lsp_c', storeId: 'st_1', email: 'x@example.com' });
    await handleStoreWebhook(t.services, created.body, created.sig);
    const failed = signed(t, { type: 'subscription_payment_failed', subscriptionId: 'sub_9' });
    await handleStoreWebhook(t.services, failed.body, failed.sig);
    const m = await t.db.one<{ status: string; past_due_since: Date }>('SELECT status, past_due_since FROM membership');
    expect(m.status).toBe('past_due');
    expect(new Date(m.past_due_since).toISOString()).toBe(now.toISOString());
    const recovered = signed(t, { type: 'subscription_updated', subscriptionId: 'sub_9', status: 'active' });
    await handleStoreWebhook(t.services, recovered.body, recovered.sig);
    expect(await t.db.one('SELECT status, past_due_since FROM membership')).toEqual({ status: 'active', past_due_since: null });
  });

  it('the community gate interface grants and revokes with access (Discord later)', async () => {
    let now = new Date('2026-11-10T00:00:00Z');
    const t = await studio({ now: () => now });
    const p = await persona(t);
    await product(t, p.id, { name: 'Club', rung: 'membership', status: 'live', price: 700 });
    const log: string[] = [];
    const gate: CommunityGate = {
      platform: 'discord',
      grant: async (m) => (log.push(`grant:${m.membershipId}`), { userRef: 'u1' }),
      revoke: async (m) => void log.push(`revoke:${m.userRef}`),
    };
    const id = (await applySubscriptionEvent(t.services, { type: 'subscription_created', subscriptionId: 's', productId: 'x', email: 'g@example.com' }, { personaId: p.id, productId: null, gate }))!;
    expect(log).toEqual([`grant:${id}`]);
    await syncCommunityAccess(t.services, id, gate);
    expect(log).toHaveLength(1);
    await applySubscriptionEvent(t.services, { type: 'subscription_updated', subscriptionId: 's', status: 'expired' }, { personaId: null, productId: null, gate });
    expect(log).toEqual([`grant:${id}`, 'revoke:u1']);
    expect((await t.db.one<{ access_state: string }>('SELECT access_state FROM community_member')).access_state).toBe('revoked');
  });
});
