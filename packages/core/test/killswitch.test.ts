import { createFakeProviders } from '@troupe/providers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearKillSwitch,
  decide,
  OWNER,
  propose,
  publishBlockers,
  PublishBlockedError,
  publishPost,
  setKillSwitch,
  STUDIO_MANAGER,
} from '../src';
import { type Ctx, makePersona, setup } from './helpers';

let ctx: Ctx;
beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => ctx.db.close());

/** A post that passed QC and the Gate and was approved by the Owner. */
async function readyPost(personaId: string, platform: 'tiktok' | 'instagram' = 'tiktok', gate: 'green' | 'red' = 'green'): Promise<string> {
  const { id: acc } = await ctx.db.one<{ id: string }>(
    `INSERT INTO account (persona_id, platform, handle, status) VALUES ($1, $2, $3, 'active') RETURNING id`,
    [personaId, platform, `h_${Math.random().toString(36).slice(2, 8)}`],
  );
  const { id } = await ctx.db.one<{ id: string }>(
    `INSERT INTO post (persona_id, account_id, platform, format, caption, media, status) VALUES ($1, $2, $3, 'talking', 'hi', '[{"url":"m.mp4"}]', 'awaiting_approval') RETURNING id`,
    [personaId, acc, platform],
  );
  await ctx.db.query(`INSERT INTO gate_result (persona_id, subject_type, subject_id, stage, verdict) VALUES ($1, 'post', $2, 'pre_publish', $3)`, [personaId, id, gate]);
  await ctx.db.query(`INSERT INTO qc_report (persona_id, subject_type, subject_id, stage, pass) VALUES ($1, 'post', $2, 'Q4', true)`, [personaId, id]);
  if (gate !== 'red') {
    const a = await propose(ctx.db, { studioId: ctx.studioId, personaId, kind: 'post', title: 'post', subjectType: 'post', subjectId: id, proposedBy: STUDIO_MANAGER, gate });
    await ctx.db.query('UPDATE post SET approval_id = $2 WHERE id = $1', [id, a.id]);
    await decide(ctx.db, { approvalId: a.id, decision: 'approve', actor: OWNER });
  }
  return id;
}

describe('kill switches', () => {
  it('global, per-persona and per-platform switches are all checked before any publish', async () => {
    const a = await makePersona(ctx, { name: 'A' });
    const b = await makePersona(ctx, { name: 'B' });
    const pub = createFakeProviders().publish;

    // Clear to publish: goes out with the AI label and is verified live.
    const p0 = await readyPost(a);
    const res = await publishPost(ctx.db, pub, p0);
    expect(res.url).toMatch(/^https:\/\/fake\.tiktok\.local\//);
    expect(pub.callsTo('publish')[0]?.args).toMatchObject({ aiLabel: true, platform: 'tiktok' });
    expect((await ctx.db.one<{ status: string }>('SELECT status FROM post WHERE id = $1', [p0])).status).toBe('live');

    // Global switch blocks everyone.
    await setKillSwitch(ctx.db, ctx.studioId, { scope: 'global' }, OWNER, '/pause all');
    const p1 = await readyPost(b);
    await expect(publishPost(ctx.db, pub, p1)).rejects.toBeInstanceOf(PublishBlockedError);
    await clearKillSwitch(ctx.db, ctx.studioId, { scope: 'global' }, OWNER);

    // Persona switch blocks only that persona.
    await setKillSwitch(ctx.db, ctx.studioId, { scope: 'persona', personaId: a }, OWNER);
    expect(await publishBlockers(ctx.db, a, 'tiktok')).toEqual(['A is paused']);
    expect(await publishBlockers(ctx.db, b, 'tiktok')).toEqual([]);

    // Platform switch blocks only that platform.
    await setKillSwitch(ctx.db, ctx.studioId, { scope: 'platform', platform: 'tiktok' }, OWNER);
    expect(await publishBlockers(ctx.db, b, 'tiktok')).toEqual(['tiktok is paused']);
    expect(await publishBlockers(ctx.db, b, 'instagram')).toEqual([]);
    const p2 = await readyPost(b, 'instagram');
    await publishPost(ctx.db, pub, p2);

    // Nothing blocked ever reached the provider.
    expect(pub.callsTo('publish')).toHaveLength(2);

    // Setting the same switch twice is idempotent; clearing resumes.
    await setKillSwitch(ctx.db, ctx.studioId, { scope: 'platform', platform: 'tiktok' }, OWNER);
    await clearKillSwitch(ctx.db, ctx.studioId, { scope: 'platform', platform: 'tiktok' }, OWNER);
    await clearKillSwitch(ctx.db, ctx.studioId, { scope: 'persona', personaId: a }, OWNER);
    await publishPost(ctx.db, pub, p1);
    expect(pub.callsTo('publish')).toHaveLength(3);
  });

  it('killed personas, Gate reds and unapproved posts never publish', async () => {
    const pub = createFakeProviders().publish;
    const killed = await makePersona(ctx, { state: 'KILLED', name: 'K' });
    const p = await readyPost(killed);
    await expect(publishPost(ctx.db, pub, p)).rejects.toThrow(/K is KILLED/);

    const live = await makePersona(ctx);
    const red = await readyPost(live, 'tiktok', 'red');
    await expect(publishPost(ctx.db, pub, red)).rejects.toThrow(/Compliance Gate: red/);

    // L1 post still inside its veto window.
    const { id: queued } = await ctx.db.one<{ id: string }>(`INSERT INTO post (persona_id, platform, format, status) VALUES ($1, 'tiktok', 'static', 'awaiting_approval') RETURNING id`, [live]);
    const a = await propose(ctx.db, { studioId: ctx.studioId, personaId: live, kind: 'post', title: 'q', subjectType: 'post', subjectId: queued, proposedBy: STUDIO_MANAGER, gate: 'green' });
    await ctx.db.query('UPDATE post SET approval_id = $2 WHERE id = $1', [queued, a.id]);
    await expect(publishPost(ctx.db, pub, queued)).rejects.toThrow(/veto window/);
    expect(pub.callsTo('publish')).toHaveLength(0);
  });
});
