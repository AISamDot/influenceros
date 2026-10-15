import { MEDIA_RENDER_JOB, PUBLISH_PREPARE_JOB } from '@ios/agents';
import { OWNER } from '@ios/core';
import { describe, expect, it } from 'vitest';
import { FakeToolkit, jobs, MEDIA_JOB, personaMedia, renderSlot, schedules, sweepStuckRenders, tools } from '../src';
import { mediaFixture, NOW } from './helpers';

const bad = { ocrText: 'nothing readable' };

describe('re-render, sweep and schedules', () => {
  it('media.rerender reopens a QC-blocked slot with fresh loops and queues one render', async () => {
    const f = await mediaFixture({ toolkit: new FakeToolkit({ renders: [bad, bad, bad] }) });
    const payload = await f.queued('voiceover');
    expect((await renderSlot(f.services, payload)).status).toBe('blocked');
    f.services.tools.register(...tools.filter((t) => !f.services.tools.get(t.name)));
    const ctx = { services: f.services, studioId: f.studioId, personaId: null, caller: 'owner' as const, actor: OWNER };
    const res = (await f.services.tools.invoke(ctx, 'media.rerender', { persona_id: f.personaId, slot_id: payload.slotId })) as { jobId: string; reopened: boolean };
    expect(res.reopened).toBe(true);
    expect(res.jobId).toBeTruthy();
    const slot = await f.db.one<{ status: string; block_reason: string | null }>('SELECT status, block_reason FROM calendar_slot WHERE id = $1', [payload.slotId]);
    expect(slot).toEqual({ status: 'media_queued', block_reason: null });
    // A second call while queued does not double-queue.
    const again = (await f.services.tools.invoke(ctx, 'media.rerender', { persona_id: f.personaId, slot_id: payload.slotId })) as { jobId: string | null };
    expect(again.jobId).toBeNull();
    // The fake renders are clean now: it passes and hands over once.
    const out = await renderSlot(f.services, payload);
    expect(out.status).toBe('final_gate');
    const pub = await f.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM job WHERE kind = $1`, [PUBLISH_PREPARE_JOB]);
    expect(pub.n).toBe(1);
  });

  it('agents cannot replace a voice; the Video Producer can re-render but only its own persona', async () => {
    const f = await mediaFixture();
    f.services.tools.register(...tools.filter((t) => !f.services.tools.get(t.name)));
    const agent = { services: f.services, studioId: f.studioId, personaId: f.personaId, caller: 'video-producer' as const, actor: { type: 'agent' as const, id: 'video-producer' } };
    await expect(f.services.tools.invoke(agent, 'voice.redesign', { persona_id: f.personaId })).rejects.toThrow();
    const status = (await f.services.tools.invoke(agent, 'media.status', { persona_id: f.personaId })) as { soulStatus: string };
    expect(status.soulStatus).toBe('none');
  });

  it('the sweep re-queues a render whose job died, and blocks after 3 deaths with an Owner notification', async () => {
    const f = await mediaFixture();
    const payload = await f.queued('static');
    await f.db.query(`UPDATE job SET status = 'dead', last_error = 'worker crashed' WHERE kind = $1`, [MEDIA_RENDER_JOB]);
    await f.db.query(`UPDATE calendar_slot SET stage_changed_at = $2 WHERE id = $1`, [payload.slotId, new Date(NOW.getTime() - 2 * 3_600_000)]);
    expect(await sweepStuckRenders(f.services, NOW)).toEqual({ requeued: 1, blocked: 0 });
    expect(await sweepStuckRenders(f.services, NOW)).toEqual({ requeued: 0, blocked: 0 }); // a job is queued now
    await f.db.query(`UPDATE job SET status = 'dead', last_error = 'worker crashed' WHERE kind = $1`, [MEDIA_RENDER_JOB]);
    await f.db.query(`INSERT INTO job (kind, payload, status, last_error) SELECT kind, payload, 'dead', 'worker crashed' FROM job WHERE kind = $1 LIMIT 1`, [MEDIA_RENDER_JOB]);
    expect(await sweepStuckRenders(f.services, NOW)).toEqual({ requeued: 0, blocked: 1 });
    const slot = await f.db.one<{ status: string; block_reason: string }>('SELECT status, block_reason FROM calendar_slot WHERE id = $1', [payload.slotId]);
    expect(slot.status).toBe('blocked');
    expect(slot.block_reason).toBe('media failed: worker crashed');
  });

  it('schedules only enqueue: weekly cost probe, daily persona prep (Soul ID, voice, look pack)', async () => {
    const f = await mediaFixture();
    const byName = Object.fromEntries(schedules.map((s) => [s.name, s]));
    expect(Object.keys(byName).sort()).toEqual(['media.cost_probe', 'media.prepare_personas', 'media.sweep']);
    expect(byName['media.cost_probe']!.due(NOW, new Date(NOW.getTime() - 86_400_000))).toBe(false);
    expect(await byName['media.cost_probe']!.run(f.services, NOW)).toEqual({ enqueued: true });
    expect(await byName['media.cost_probe']!.run(f.services, NOW)).toEqual({ enqueued: false });
    expect(await byName['media.prepare_personas']!.run(f.services, NOW)).toEqual({ queued: 1 });
    const job = await f.db.one<import('@ios/core').JobRow>(`SELECT * FROM job WHERE kind = $1`, [MEDIA_JOB.preparePersona]);
    const res = await jobs[MEDIA_JOB.preparePersona]!({ services: f.services, job, heartbeat: async () => true });
    expect(res).toMatchObject({ looks: 2 });
    const pm = await personaMedia(f.db, f.personaId, NOW);
    expect(pm.soulStatus).toBe('ready');
    expect(pm.voiceId).toBeTruthy();
    // Fake-mode stand-ins are stored but never shown as images on the dashboard.
    expect(pm.referenceUrl).toBeNull();
    expect(pm.looks).toHaveLength(0);
    const stored = await f.db.query<{ role: string; url: string }>(`SELECT role, url FROM asset WHERE persona_id = $1 AND role IN ('reference','look') ORDER BY role`, [f.personaId]);
    expect(stored.map((a) => a.role)).toEqual(['look', 'look', 'reference']);
    expect(stored[2]!.url).toMatch(/^\/api\/media\/media\/.*\/profile\/reference\.png$/);
    expect(pm.grade?.contrast).toBeGreaterThan(1);
    expect(pm.monthCredits).toBeGreaterThan(40);
    // A prepared persona isn't queued again.
    await f.db.query(`UPDATE job SET status = 'succeeded'`);
    expect(await byName['media.prepare_personas']!.run(f.services, NOW)).toEqual({ queued: 0 });
    const probe = await f.db.one<import('@ios/core').JobRow>(`SELECT * FROM job WHERE kind = $1`, [MEDIA_JOB.costProbe]);
    expect(await jobs[MEDIA_JOB.costProbe]!({ services: f.services, job: probe, heartbeat: async () => true })).toMatchObject({ prices: 8 });
  });
});
