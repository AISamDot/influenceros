import { createFakeProviders } from '@ios/providers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decide, OWNER, propose, PublishBlockedError, publishPost, STUDIO_MANAGER, sweepAutoApprovals } from '../src';
import { type Ctx, makePersona, setup } from './helpers';

let ctx: Ctx;
beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => ctx.db.close());

const status = async (id: string) => (await ctx.db.one<{ status: string }>('SELECT status FROM post WHERE id = $1', [id])).status;

/** A post with an account, QC pass and a stored Gate verdict, awaiting approval. */
async function draft(personaId: string, gate: 'green' | 'amber' | 'red' = 'green'): Promise<string> {
  const { id: acc } = await ctx.db.one<{ id: string }>(
    `INSERT INTO account (persona_id, platform, handle, status) VALUES ($1, 'tiktok', $2, 'active') RETURNING id`,
    [personaId, `h_${Math.random().toString(36).slice(2, 8)}`],
  );
  const { id } = await ctx.db.one<{ id: string }>(
    `INSERT INTO post (persona_id, account_id, platform, format, caption, media, status) VALUES ($1, $2, 'tiktok', 'talking', 'hi', '[{"url":"m.mp4"}]', 'awaiting_approval') RETURNING id`,
    [personaId, acc],
  );
  await ctx.db.query(`INSERT INTO gate_result (persona_id, subject_type, subject_id, stage, verdict) VALUES ($1, 'post', $2, 'pre_publish', $3)`, [personaId, id, gate]);
  await ctx.db.query(`INSERT INTO qc_report (persona_id, subject_type, subject_id, stage, pass) VALUES ($1, 'post', $2, 'Q4', true)`, [personaId, id]);
  return id;
}

async function ownerApproved(personaId: string, gate: 'green' | 'amber' = 'green'): Promise<string> {
  const id = await draft(personaId, gate);
  const a = await propose(ctx.db, { studioId: ctx.studioId, personaId, kind: 'post', title: 'post', subjectType: 'post', subjectId: id, proposedBy: STUDIO_MANAGER });
  await decide(ctx.db, { approvalId: a.id, decision: 'approve', actor: OWNER });
  return id;
}

describe('publishPost', () => {
  it("only the post's own approval unlocks it: a borrowed approval id is refused", async () => {
    const pub = createFakeProviders().publish;
    const l0 = await makePersona(ctx, { autonomy: 'L0' });
    const other = await ownerApproved(l0);
    const mine = await draft(l0);
    const pending = await propose(ctx.db, { studioId: ctx.studioId, personaId: l0, kind: 'post', title: 'mine', subjectType: 'post', subjectId: mine, proposedBy: STUDIO_MANAGER });
    expect(pending.mode).toBe('explicit');
    // Point the post at another post's approved approval, and force it to scheduled.
    const otherApproval = (await ctx.db.one<{ approval_id: string }>('SELECT approval_id FROM post WHERE id = $1', [other])).approval_id;
    await ctx.db.query(`UPDATE post SET approval_id = $2, status = 'scheduled' WHERE id = $1`, [mine, otherApproval]);
    await expect(publishPost(ctx.db, pub, mine)).rejects.toThrow(/not approved/);

    // An auto-approved launch card can't stand in for a post approval either.
    const p = await makePersona(ctx, { state: 'PROPOSED' });
    const launch = await propose(ctx.db, { studioId: ctx.studioId, personaId: p, kind: 'persona_launch', title: 'L', proposedBy: STUDIO_MANAGER });
    await decide(ctx.db, { approvalId: launch.id, decision: 'approve', actor: OWNER });
    await ctx.db.query(`UPDATE post SET approval_id = $2 WHERE id = $1`, [mine, launch.id]);
    await expect(publishPost(ctx.db, pub, mine)).rejects.toThrow(/not approved/);
    expect(pub.callsTo('publish')).toHaveLength(0);
  });

  it('a red is released only by the Owner; an auto-approved amber needs the Owner unless L2', async () => {
    const pub = createFakeProviders().publish;
    const id = await makePersona(ctx, { autonomy: 'L1' });
    const p = await ownerApproved(id);
    await ctx.db.query(`INSERT INTO gate_result (persona_id, subject_type, subject_id, stage, verdict, released_by, created_at) VALUES ($1, 'post', $2, 'pre_publish', 'red', 'agent:publisher', now() + interval '1 second')`, [id, p]);
    await expect(publishPost(ctx.db, pub, p)).rejects.toThrow(/Compliance Gate: red/);
    await ctx.db.query(`UPDATE gate_result SET released_by = 'owner:hossam' WHERE subject_id = $1 AND verdict = 'red'`, [p]);
    await publishPost(ctx.db, pub, p);

    // Green at proposal, auto-approved after the window, then the Gate re-ran amber: blocked at L1.
    const q = await draft(id, 'green');
    const t0 = new Date();
    const a = await propose(ctx.db, { studioId: ctx.studioId, personaId: id, kind: 'post', title: 'q', subjectType: 'post', subjectId: q, proposedBy: STUDIO_MANAGER, now: t0 });
    expect(await sweepAutoApprovals(ctx.db, { now: new Date(t0.getTime() + 121 * 60_000) })).toEqual([a.id]);
    await ctx.db.query(`INSERT INTO gate_result (persona_id, subject_type, subject_id, stage, verdict, created_at) VALUES ($1, 'post', $2, 'pre_publish', 'amber', now() + interval '1 second')`, [id, q]);
    await expect(publishPost(ctx.db, pub, q)).rejects.toThrow(/amber needs the Owner/);
    await ctx.db.query(`UPDATE persona SET autonomy = 'L2' WHERE id = $1`, [id]);
    await publishPost(ctx.db, pub, q);
    expect(pub.callsTo('publish')).toHaveLength(2);
  });

  it('publishes a post once, even when called twice or concurrently', async () => {
    const pub = createFakeProviders().publish;
    const id = await makePersona(ctx);
    const p1 = await ownerApproved(id);
    await publishPost(ctx.db, pub, p1);
    await expect(publishPost(ctx.db, pub, p1)).rejects.toThrow(/post is live/);
    expect(pub.callsTo('publish')).toHaveLength(1);

    const p2 = await ownerApproved(id);
    const results = await Promise.allSettled([publishPost(ctx.db, pub, p2), publishPost(ctx.db, pub, p2)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(PublishBlockedError);
    expect(pub.callsTo('publish')).toHaveLength(2);
    expect(await status(p2)).toBe('live');
  });

  it('a provider failure hands the post back for a retry, and the retry carries the same idempotency key', async () => {
    const pub = createFakeProviders().publish;
    const id = await makePersona(ctx);
    const p = await ownerApproved(id);
    pub.failNext = 1;
    await expect(publishPost(ctx.db, pub, p)).rejects.toThrow(/503/);
    expect(await status(p)).toBe('scheduled');
    await publishPost(ctx.db, pub, p);
    expect(await status(p)).toBe('live');
    expect(pub.callsTo('publish')).toHaveLength(1);
    expect(pub.callsTo('publish')[0]?.args).toMatchObject({ idempotencyKey: p });
  });
});
