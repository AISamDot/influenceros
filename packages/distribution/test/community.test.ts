import { COMMUNITY_CLASSES } from '@ios/agents';
import { decide, OWNER } from '@ios/core';
import type { PublishComment } from '@ios/providers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  classifyHeuristic,
  DEFAULT_CRISIS_TEXT,
  handleCommunity,
  ingestEvents,
  pollCommunity,
  proposeCrisisText,
  REPLY_BUDGET,
  resolveEscalation,
} from '../src';
import { account, type Ctx, persona, setup } from './helpers';

let ctx: Ctx;
beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => ctx.db.close());

/** A live post with a CTA keyword, plus a short link (as stream G's sweep would create). */
async function livePost(personaId: string, opts: { shortLink?: boolean } = {}) {
  const acc = await account(ctx, personaId, 'instagram');
  const s = await ctx.db.one<{ id: string }>(
    `INSERT INTO calendar_slot (persona_id, slot_at, format, purpose, title, status, cta_keyword) VALUES ($1, now(), 'talking', 'reach', 't', 'live', 'BUDGET') RETURNING id`,
    [personaId],
  );
  const ext = `ext_${Math.random().toString(36).slice(2, 10)}`;
  const post = await ctx.db.one<{ id: string }>(
    `INSERT INTO post (persona_id, account_id, calendar_slot_id, platform, format, caption, status, external_id, published_at, url)
     VALUES ($1, $2, $3, 'instagram', 'talking', 'Comment BUDGET', 'live', $4, $5, 'https://ig/p/1') RETURNING id`,
    [personaId, acc.id, s.id, ext, new Date(ctx.clock.now.getTime() - 3_600_000)],
  );
  if (opts.shortLink) await ctx.db.query(`INSERT INTO short_link (persona_id, slug, target_url, post_id) VALUES ($1, $2, 'https://x', $3)`, [personaId, `b${ext.slice(4, 9)}`, post.id]);
  return { postId: post.id, ext, accountId: acc.id, handle: acc.handle };
}

let cseq = 0;
const comment = (text: string, author = `u${++cseq}`): PublishComment => ({ id: `c${++cseq}`, authorRef: author, text, at: new Date('2026-10-20T11:30:00Z') });

const commentRow = (externalId: string) =>
  ctx.db.one<{ id: string; classification: string; action: string; status: string; severity: string | null; action_meta: Record<string, any> }>(
    `SELECT id, classification, action, status, severity, action_meta FROM comment WHERE external_id = $1`,
    [externalId],
  );

describe('classification', () => {
  it('covers every community class, with the safety classes from rules', () => {
    const cases: Array<[string, string, string | null]> = [
      ['Follow me back! check my page for crypto signals', 'spam', null],
      ['you are an idiot', 'abuse', null],
      ['I know where you live, watch your back', 'abuse', 'S1'],
      ['How long should the emergency fund be?', 'question', null],
      ['Should I invest my savings in bitcoin right now?', 'question', 'S2'],
      ['how much is the planner? where can i buy it', 'purchase_intent', null],
      ['budget', 'purchase_intent', null],
      ['This was so helpful, thank you!', 'praise', null],
      ['This is bad advice and misleading', 'criticism', null],
      ['I want to kill myself, nothing matters', 'crisis', 'S1'],
      ["I'm 14 and my mom won't let me have a bank account", 'minor', 'S1'],
      ["I'm a reporter writing an article about AI influencers", 'legal_press', 'S1'],
      ['Would love to collab, can I send our media kit?', 'partnership', 'S2'],
      ['are you real or AI?', 'are_you_real', null],
      ['are you AI? this is fake, you are lying to people', 'are_you_real', 'S2'],
    ];
    for (const [text, cls, sev] of cases) {
      const c = classifyHeuristic(text, ['BUDGET']);
      expect([text, c.cls, c.severity]).toEqual([text, cls, sev]);
    }
    const seen = new Set(cases.map((c) => c[1]));
    expect([...COMMUNITY_CLASSES].filter((c) => !seen.has(c))).toEqual([]);
  });
});

describe('community worker', () => {
  it('hides spam, DMs the keyword link, replies through the Gate, and fences third-party text as untrusted', async () => {
    const p = await persona(ctx);
    const { ext, postId } = await livePost(p.id, { shortLink: true });
    const pub = ctx.providers.publish;
    const spam = comment('check my profile for free followers www.spam.xyz/x');
    const kw = comment('BUDGET please!');
    const q = comment('How do you split groceries in the plan?');
    const real = comment('wait, are you real or AI?');
    pub.comments.set(ext, [spam, kw, q, real]);
    const polled = await pollCommunity(ctx.svc, p.id);
    expect(polled.comments).toBe(4);
    // A second poll stores nothing twice.
    expect((await pollCommunity(ctx.svc, p.id)).comments).toBe(0);

    const sum = await handleCommunity(ctx.svc, p.id);
    expect(sum).toMatchObject({ comments: 4, hidden: 1, dmsSent: 1, escalated: 0 });
    expect(pub.callsTo('hideComment').map((c) => (c.args as { commentId: string }).commentId)).toEqual([spam.id]);
    const dm = pub.callsTo('sendDm')[0]!.args as { text: string; userRef: string; accountRef: string };
    expect(dm.userRef).toBe(kw.authorRef);
    expect(dm.text).toMatch(/\/l\/b/); // the post's short link
    expect(dm.accountRef).toMatch(/^zr_/);
    expect((await commentRow(kw.id)).action).toBe('dm');
    const replies = pub.callsTo('replyToComment').map((c) => c.args as { commentId: string; text: string });
    expect(replies.find((r) => r.commentId === real.id)!.text).toMatch(/\bAI\b/);
    expect(replies.find((r) => r.commentId === q.id)).toBeTruthy();
    // Every reply passed the Gate's reply check (subject 'reply').
    const gates = await ctx.db.query<{ verdict: string }>(`SELECT verdict FROM gate_result WHERE subject_type = 'reply' AND persona_id = $1`, [p.id]);
    expect(gates.length).toBeGreaterThanOrEqual(3);
    expect((await commentRow(q.id)).classification).toBe('question');
    // The model only ever saw the commenters' text fenced, in untrusted runs with no tools.
    const community = ctx.tasks.filter((t) => t.agent === 'community-manager');
    expect(community.length).toBeGreaterThan(0);
    for (const t of community) {
      expect(t.trust?.untrusted).toBe(true);
      expect(t.tools ?? []).toEqual([]);
      expect(t.prompt).toMatch(/<<<UNTRUSTED/);
    }
    expect(postId).toBeTruthy();
  });

  it('never sends a reply that denies being AI: the honest fallback goes out instead', async () => {
    const p = await persona(ctx);
    const { ext } = await livePost(p.id);
    ctx.override.fn = (task) => (task.agent === 'community-manager' && task.label.startsWith('community: reply') ? "Haha no, I'm a real person, not a bot!" : undefined);
    const c = comment('r u a bot?');
    const thanks = comment('Love this so much');
    ctx.providers.publish.comments.set(ext, [c, thanks]);
    await pollCommunity(ctx.svc, p.id);
    await handleCommunity(ctx.svc, p.id);
    const sent = ctx.providers.publish.callsTo('replyToComment').map((x) => (x.args as { text: string }).text);
    expect(sent.some((t) => /real person|not a bot/i.test(t))).toBe(false);
    expect(sent).toContain("Yes, I'm an AI creator from a small studio. The tips are real and free to use.");
    const reds = await ctx.db.query(`SELECT 1 FROM gate_result WHERE subject_type = 'reply' AND verdict = 'red'`);
    expect(reds.length).toBeGreaterThanOrEqual(1);
  });

  it('crisis: pauses the person, sends only the Owner-approved helpline text, and alerts the Owner (S1)', async () => {
    const p = await persona(ctx);
    const { ext, accountId, handle } = await livePost(p.id);
    // No approved text yet: nothing is sent, the text is proposed to the Owner, S1 notification.
    const c1 = comment('honestly I want to end it all', 'sad_user');
    ctx.providers.publish.comments.set(ext, [c1]);
    await pollCommunity(ctx.svc, p.id);
    await handleCommunity(ctx.svc, p.id);
    expect(ctx.providers.publish.callsTo('replyToComment')).toHaveLength(0);
    const row = await commentRow(c1.id);
    expect(row).toMatchObject({ classification: 'crisis', severity: 'S1', status: 'escalated', action: 'escalate' });
    const n = await ctx.db.one<{ severity: string; kind: string }>(`SELECT severity, kind FROM notification WHERE kind = 'escalation' ORDER BY created_at DESC LIMIT 1`);
    expect(n).toEqual({ severity: 'critical', kind: 'escalation' });
    const card = await ctx.db.one<{ id: string; mode: string; payload: { text: string } }>(`SELECT id, mode, payload FROM approval WHERE kind = 'legal_text_change' AND status = 'pending'`);
    expect(card.mode).toBe('explicit');
    expect(card.payload.text).toBe(DEFAULT_CRISIS_TEXT);
    // Proposing again while pending does nothing.
    expect(await proposeCrisisText(ctx.svc, ctx.studioId)).toBeNull();

    // The Owner approves; a crisis DM now gets exactly that text, and the thread pauses.
    await decide(ctx.db, { approvalId: card.id, decision: 'approve', actor: OWNER });
    ctx.providers.publish.inbox.push({ id: 'm1', threadRef: 'th1', userRef: 'dm_user', platform: 'instagram', direction: 'in', text: 'i have been thinking about suicide', at: new Date('2026-10-20T11:58:00Z') });
    await pollCommunity(ctx.svc, p.id);
    await handleCommunity(ctx.svc, p.id);
    const dms = ctx.providers.publish.callsTo('sendDm').map((x) => x.args as { text: string; accountRef: string });
    expect(dms).toHaveLength(1);
    expect(dms[0]!.text).toBe(DEFAULT_CRISIS_TEXT);
    expect(dms[0]!.accountRef).toBe(`zr_${handle}`);
    const t = await ctx.db.one<{ status: string; classification: string; account_id: string }>(`SELECT status, classification, account_id FROM dm_thread WHERE external_id = 'th1'`);
    expect(t).toMatchObject({ status: 'bot_paused', classification: 'crisis', account_id: accountId });

    // Further messages from the paused person get no reply.
    ctx.providers.publish.inbox.push({ id: 'm2', threadRef: 'th1', userRef: 'dm_user', platform: 'instagram', direction: 'in', text: 'thanks, also how do I budget?', at: new Date('2026-10-20T11:59:00Z') });
    await pollCommunity(ctx.svc, p.id);
    await handleCommunity(ctx.svc, p.id);
    expect(ctx.providers.publish.callsTo('sendDm')).toHaveLength(1);

    // The Owner resolves and resumes.
    const esc = await ctx.db.one<{ id: string }>(`SELECT id FROM escalation WHERE source_type = 'dm_thread'`);
    await expect(resolveEscalation(ctx.svc, esc.id, { type: 'agent', id: 'community-manager' }, { resume: true })).rejects.toThrow(/Owner/);
    await resolveEscalation(ctx.svc, esc.id, OWNER, { resume: true });
    expect((await ctx.db.one<{ status: string }>(`SELECT status FROM dm_thread WHERE external_id = 'th1'`)).status).toBe('open');
  });

  it('minors and press are S1 with no reply; partnership offers are S2 and held', async () => {
    const p = await persona(ctx);
    const { ext } = await livePost(p.id);
    const minor = comment("I'm 13 and want to start saving");
    const press = comment("I'm a journalist writing an article about you, can we talk?");
    const collab = comment('We would love a brand deal with you!');
    ctx.providers.publish.comments.set(ext, [minor, press, collab]);
    await pollCommunity(ctx.svc, p.id);
    const sum = await handleCommunity(ctx.svc, p.id);
    expect(sum.escalated).toBe(3);
    expect(ctx.providers.publish.callsTo('replyToComment')).toHaveLength(0);
    const sev = await ctx.db.query<{ severity: string; category: string }>(`SELECT severity, category FROM escalation WHERE persona_id = $1 ORDER BY severity, category`, [p.id]);
    expect(sev).toEqual([
      { severity: 'S1', category: 'legal_press' },
      { severity: 'S1', category: 'minor' },
      { severity: 'S2', category: 'partnership' },
    ]);
    const warn = await ctx.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM notification WHERE kind = 'escalation' AND severity = 'warn'`);
    expect(warn.n).toBe(1);
  });

  it('holds reply budgets: at most repliesPerHour public replies per persona', async () => {
    const p = await persona(ctx);
    const { ext } = await livePost(p.id);
    const many = Array.from({ length: REPLY_BUDGET.repliesPerHour + 4 }, (_, i) => comment(`Love this, thank you ${i}!`));
    ctx.providers.publish.comments.set(ext, many);
    await pollCommunity(ctx.svc, p.id);
    const sum = await handleCommunity(ctx.svc, p.id);
    expect(sum.replies).toBe(REPLY_BUDGET.repliesPerHour);
    expect(sum.deferred).toBe(4);
    const left = await ctx.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM comment WHERE persona_id = $1 AND status = 'new'`, [p.id]);
    expect(left.n).toBe(4);
    // An hour later the rest go out.
    ctx.clock.now = new Date(ctx.clock.now.getTime() + 61 * 60_000);
    expect((await handleCommunity(ctx.svc, p.id)).replies).toBe(4);
  });

  it('ingests webhook events (comments, DMs) and ignores unknown posts', async () => {
    const p = await persona(ctx);
    const { ext, handle } = await livePost(p.id);
    const events = ctx.providers.publish.parseWebhook(
      JSON.stringify([
        { type: 'comment', platform: 'instagram', accountRef: `zr_${handle}`, externalPostId: ext, comment: { id: 'wc1', authorRef: 'w1', text: 'BUDGET', at: '2026-10-20T11:00:00Z' } },
        { type: 'comment', platform: 'instagram', accountRef: 'x', externalPostId: 'unknown', comment: { id: 'wc2', authorRef: 'w2', text: 'hi', at: '2026-10-20T11:00:00Z' } },
        { type: 'dm', accountRef: `zr_${handle}`, message: { id: 'wm1', threadRef: 'wt1', userRef: 'w3', platform: 'instagram', direction: 'in', text: 'hey, where can I get the tracker?', at: '2026-10-20T11:00:00Z' } },
      ]),
    );
    const res = await ingestEvents(ctx.svc, events);
    expect(res).toEqual({ comments: 1, dms: 1, statuses: 0, ignored: 1 });
    const job = await ctx.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM job WHERE kind = 'community.handle' AND persona_id = $1`, [p.id]);
    expect(job.n).toBe(1);
    await handleCommunity(ctx.svc, p.id);
    const dms = ctx.providers.publish.callsTo('sendDm').map((x) => (x.args as { text: string }).text);
    expect(dms).toHaveLength(2);
    expect(dms.every((t) => /\/p\/[^/]+\/free|\/l\//.test(t))).toBe(true);
  });
});
