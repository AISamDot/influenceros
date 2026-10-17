import { decide, OWNER, propose, publishPost, runOnce, STUDIO_MANAGER } from '@troupe/core';
import { describe, expect, it } from 'vitest';
import { jobs, RECOVER_PUBLISHING_JOB, schedules } from '../src';
import { createTestStudio, makeTestPersona } from '../src/testing';

describe('stream A jobs and schedules', () => {
  it('the recovery schedule enqueues one job, and the job confirms a post whose verify threw', async () => {
    const t = await createTestStudio();
    const p = await makeTestPersona(t);
    const { id: acc } = await t.db.one<{ id: string }>(`INSERT INTO account (persona_id, platform, handle, status) VALUES ($1, 'tiktok', 'h_jobs', 'active') RETURNING id`, [p.id]);
    const { id: post } = await t.db.one<{ id: string }>(
      `INSERT INTO post (persona_id, account_id, platform, format, caption, media, status) VALUES ($1, $2, 'tiktok', 'talking', 'hi', '[{"url":"m.mp4"}]', 'draft') RETURNING id`,
      [p.id, acc],
    );
    await t.db.query(`INSERT INTO gate_result (persona_id, subject_type, subject_id, stage, verdict) VALUES ($1, 'post', $2, 'pre_publish', 'green')`, [p.id, post]);
    await t.db.query(`INSERT INTO qc_report (persona_id, subject_type, subject_id, stage, pass) VALUES ($1, 'post', $2, 'Q4', true)`, [p.id, post]);
    const a = await propose(t.db, { studioId: t.studioId, personaId: p.id, kind: 'post', title: 'p', subjectType: 'post', subjectId: post, proposedBy: STUDIO_MANAGER });
    await decide(t.db, { approvalId: a.id, decision: 'approve', actor: OWNER });
    const pub = t.providers.publish;
    const verify = pub.verify.bind(pub);
    pub.verify = async () => {
      throw new Error('timeout');
    };
    await publishPost(t.db, pub, post);
    pub.verify = verify;
    await t.db.query(`UPDATE post SET publishing_at = now() - interval '1 hour' WHERE id = $1`, [post]);

    const sched = schedules.find((s) => s.name === 'studio.recover_publishing')!;
    expect(sched.due(new Date(), null)).toBe(true);
    expect(sched.due(new Date(), new Date())).toBe(false);
    expect(await sched.run(t.services, new Date())).toEqual({ enqueued: true });
    expect(await sched.run(t.services, new Date())).toEqual({ enqueued: false });

    const handlers = Object.fromEntries(Object.entries(jobs).map(([k, h]) => [k, (job: Parameters<typeof h>[0]['job']) => h({ services: t.services, job, heartbeat: async () => true })]));
    const r = await runOnce(t.db, handlers, { workerId: 'w', kinds: [RECOVER_PUBLISHING_JOB] });
    expect(r?.outcome).toBe('succeeded');
    expect((await t.db.one<{ status: string }>('SELECT status FROM post WHERE id = $1', [post])).status).toBe('live');
    await t.db.close();
  });

  it('uses only stream A namespaces', () => {
    expect(Object.keys(jobs).every((k) => k.startsWith('agent.') || k.startsWith('chat.'))).toBe(true);
    expect(schedules.every((s) => s.name.startsWith('studio.') || s.name.startsWith('persona.'))).toBe(true);
  });
});
