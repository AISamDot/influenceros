import { type ProviderEnv, ToolPermissionError } from '@troupe/agents';
import { createTestStudio, makeTestPersona } from '@troupe/agents/testing';
import { OWNER, STUDIO_MANAGER } from '@troupe/core';
import { describe, expect, it } from 'vitest';
import { jobs, liveProviders, schedules, tools } from '../src';
import { ElevenLabsTranscriber, ELEVENLABS_STT_URL } from '../src/live';
import { attachSampleBible } from '../src/sample';

const NOW = new Date('2026-10-15T10:00:00Z'); // a Thursday: next week gets planned too
const NAMESPACES = ['calendar', 'content', 'script', 'hooks', 'monetization', 'gate', 'qc', 'pipeline'];

describe('StudioModule exports', () => {
  it('registers tools, jobs and schedules only in stream B namespaces', () => {
    expect(tools.length).toBeGreaterThanOrEqual(14);
    for (const t of tools) {
      expect(NAMESPACES).toContain(t.name.split('.')[0]);
      expect(t.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(t.ownerOnly).toBeFalsy(); // agents can't release a red or approve anything here
    }
    expect(Object.keys(jobs).sort()).toEqual(['calendar.plan_week', 'monetization.cycle', 'pipeline.slot', 'qc.voice']);
    expect(schedules.map((s) => s.name).sort()).toEqual(['calendar.weekly_plan', 'monetization.weekly_cycle', 'pipeline.advance']);
  });

  it('runs tools through the registry with persona scope enforced in code', async () => {
    const t = await createTestStudio({ tools, now: () => NOW });
    const a = await makeTestPersona(t);
    const b = await makeTestPersona(t);
    await attachSampleBible(t.db, a.id);
    const asManager = { services: t.services, studioId: t.studioId, personaId: a.id, caller: 'persona-manager' as const, actor: { type: 'agent' as const, id: 'persona-manager' } };
    const planned = (await t.services.tools.invoke(asManager, 'calendar.plan_week', { persona_id: a.id })) as { created: number; queued: number };
    expect(planned).toMatchObject({ created: 10, queued: 10 });
    await expect(t.services.tools.invoke(asManager, 'calendar.plan_week', { persona_id: b.id })).rejects.toBeInstanceOf(ToolPermissionError);
    await expect(t.services.tools.invoke(asManager, 'calendar.plan_week', { persona_id: a.id, extra: 1 })).rejects.toThrow(/unknown input/);
    // Agents can't plan (and queue paid work for) weeks beyond next week.
    await expect(t.services.tools.invoke(asManager, 'calendar.plan_week', { persona_id: a.id, week_start: '2026-12-07' })).rejects.toThrow(/this week or next week/);
    // A persona manager can't run Q2 (QC is independent of the makers).
    await expect(t.services.tools.invoke(asManager, 'qc.voice_check', { persona_id: a.id, script_id: a.id, audio_url: 'https://x/a.mp3' })).rejects.toBeInstanceOf(ToolPermissionError);

    const gate = (await t.services.tools.invoke(asManager, 'gate.check', { persona_id: a.id, text: 'Guaranteed returns, every month.' })) as { verdict: string };
    expect(gate.verdict).toBe('red');
    const reply = (await t.services.tools.invoke(asManager, 'gate.check_reply', { persona_id: a.id, incoming: 'are you a bot?', reply: 'nope, all me!' })) as { verdict: string };
    expect(reply.verdict).toBe('red');

    const asStudio = { ...asManager, personaId: null, caller: 'studio-manager' as const, actor: STUDIO_MANAGER };
    const board = (await t.services.tools.invoke(asStudio, 'pipeline.board', { days: 14 })) as { by_stage: Record<string, number> };
    expect(board.by_stage.idea).toBe(10);
    const week = (await t.services.tools.invoke(asStudio, 'calendar.week', { persona_id: a.id, week_start: '2026-10-19' })) as unknown[];
    expect(week).toHaveLength(10);
    const asOwner = { ...asStudio, caller: 'owner' as const, actor: OWNER };
    const brief = (await t.services.tools.invoke(asOwner, 'monetization.brief', { persona_id: a.id, rung: 'lead_magnet' })) as { product_id: string };
    await expect(t.services.tools.invoke(asOwner, 'monetization.listing_pack', { persona_id: b.id, product_id: brief.product_id })).rejects.toThrow(/not found for this persona/);
    const audited = await t.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE action LIKE 'tool.%'`);
    expect(audited.n).toBe(3); // plan_week, check_reply, brief
    await t.db.close();
  });

  it('schedules only enqueue, and are idempotent', async () => {
    const t = await createTestStudio({ now: () => NOW });
    const a = await makeTestPersona(t);
    await makeTestPersona(t, { state: 'PROPOSED' });
    const plan = schedules.find((s) => s.name === 'calendar.weekly_plan')!;
    expect(plan.due(NOW, null)).toBe(true);
    expect(plan.due(NOW, new Date('2026-10-15T00:30:00Z'))).toBe(false);
    expect(await plan.run(t.services, NOW)).toEqual({ queued: 2 }); // this week + next week, active persona only
    expect(await plan.run(t.services, NOW)).toEqual({ queued: 0 });
    const queued = await t.db.query<{ kind: string; persona_id: string; payload: { weekStart: string } }>(`SELECT kind, persona_id, payload FROM job ORDER BY payload->>'weekStart'`);
    expect(queued.map((j) => j.payload.weekStart)).toEqual(['2026-10-12', '2026-10-19']);
    expect(queued.every((j) => j.persona_id === a.id && j.kind === 'calendar.plan_week')).toBe(true);

    const money = schedules.find((s) => s.name === 'monetization.weekly_cycle')!;
    expect(money.due(NOW, new Date('2026-10-12T07:00:00Z'))).toBe(false);
    expect(money.due(NOW, new Date('2026-10-12T05:00:00Z'))).toBe(true);
    expect(await money.run(t.services, NOW)).toEqual({ queued: 1 });

    const advance = schedules.find((s) => s.name === 'pipeline.advance')!;
    await t.db.query(`INSERT INTO calendar_slot (persona_id, slot_at, format, purpose, title) VALUES ($1, $2, 'static', 'reach', 'seeded slot')`, [a.id, new Date('2026-10-16T19:00:00Z')]);
    expect(advance.due(NOW, new Date(NOW.getTime() - 10 * 60_000))).toBe(false);
    expect(await advance.run(t.services, NOW)).toEqual({ queued: 1 });
    expect(await advance.run(t.services, NOW)).toEqual({ queued: 0 });

    await t.db.close();
  });

  it('re-queues a slot after a dead pipeline job with a backoff, blocks it after 3 dead jobs, and run_slot reopens it', async () => {
    let clock = NOW;
    const t = await createTestStudio({ tools, now: () => clock });
    const a = await makeTestPersona(t);
    const advance = schedules.find((s) => s.name === 'pipeline.advance')!;
    const { id: slotId } = await t.db.one<{ id: string }>(
      `INSERT INTO calendar_slot (persona_id, slot_at, format, purpose, title) VALUES ($1, $2, 'static', 'reach', 'seeded slot') RETURNING id`,
      [a.id, new Date('2026-10-17T19:00:00Z')],
    );
    const at = (min: number) => new Date(NOW.getTime() + min * 60_000);
    const die = (when: Date, error: string) =>
      t.db.query(`UPDATE job SET status = 'dead', last_error = $2, finished_at = $1, updated_at = $1 WHERE kind = 'pipeline.slot' AND status IN ('queued','running')`, [when, error]);
    const slot = () => t.db.one<{ status: string; block_reason: string | null }>('SELECT status, block_reason FROM calendar_slot WHERE id = $1', [slotId]);

    expect(await advance.run(t.services, at(0))).toEqual({ queued: 1 });
    // A transient outage kills the job: the slot stays open and gets a new job once the 1h backoff has passed.
    await die(at(0), 'provider timeout');
    expect(await advance.run(t.services, at(30))).toEqual({ queued: 0 });
    expect(await slot()).toEqual({ status: 'planned', block_reason: null });
    expect(await advance.run(t.services, at(61))).toEqual({ queued: 1 });
    // The second dead job doubles the backoff (2h).
    await die(at(61), 'provider timeout');
    expect(await advance.run(t.services, at(61 + 90))).toEqual({ queued: 0 });
    expect(await advance.run(t.services, at(61 + 121))).toEqual({ queued: 1 });
    // The third dead job blocks the slot with the last error: no more paid retries every 30 minutes.
    await die(at(182), 'every hook was excluded');
    expect(await advance.run(t.services, at(182))).toEqual({ queued: 0 });
    expect(await slot()).toEqual({ status: 'blocked', block_reason: 'pipeline failed: every hook was excluded' });
    expect(await advance.run(t.services, at(600))).toEqual({ queued: 0 });

    // run_slot reopens it (back to planned, dead-job count reset) and queues it; slots blocked by the Gate stay put.
    clock = at(600);
    const asManager = { services: t.services, studioId: t.studioId, personaId: a.id, caller: 'persona-manager' as const, actor: { type: 'agent' as const, id: 'persona-manager' } };
    const ran = (await t.services.tools.invoke(asManager, 'pipeline.run_slot', { persona_id: a.id, slot_id: slotId })) as { job_id: string | null; reopened: boolean };
    expect(ran.reopened).toBe(true);
    expect(ran.job_id).toBeTruthy();
    expect(await slot()).toEqual({ status: 'planned', block_reason: null });
    // One more failure after the reopen is a fresh count: back off, don't block.
    await die(at(601), 'provider timeout');
    expect(await advance.run(t.services, at(601))).toEqual({ queued: 0 });
    expect((await slot()).status).toBe('planned');
    expect(await advance.run(t.services, at(662))).toEqual({ queued: 1 });

    await t.db.query(`UPDATE calendar_slot SET status = 'blocked', block_reason = 'Gate: red (medical_claims)' WHERE id = $1`, [slotId]);
    await die(at(663), 'x');
    expect(((await t.services.tools.invoke(asManager, 'pipeline.run_slot', { persona_id: a.id, slot_id: slotId })) as { reopened: boolean }).reopened).toBe(false);
    expect((await slot()).status).toBe('blocked');
    await t.db.close();
  });
});

describe('live providers', () => {
  const env = (live: boolean, key: string | null): ProviderEnv => ({ isLive: (id) => live && id === 'elevenlabs', secret: (n) => (n === 'elevenlabs.api_key' ? key : null) });

  it('stays on the fake transcriber without a live ElevenLabs key', () => {
    expect(liveProviders(env(false, 'k'))).toEqual({});
    expect(liveProviders(env(true, null))).toEqual({});
    expect(liveProviders(env(true, 'k')).transcribe).toBeInstanceOf(ElevenLabsTranscriber);
  });

  it('calls ElevenLabs speech-to-text with word timestamps (no network: fetch is injected)', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.startsWith('https://cdn.example.com/')) return new Response(new Blob([new Uint8Array([1, 2, 3])]), { status: 200 });
      return Response.json({
        text: 'Comment plan now.',
        words: [
          { text: 'Comment', start: 0, end: 0.4, type: 'word' },
          { text: ' ', start: 0.4, end: 0.45, type: 'spacing' },
          { text: 'plan', start: 0.45, end: 0.8, type: 'word' },
          { text: 'now.', start: 0.9, end: 1.2, type: 'word' },
        ],
      });
    };
    const stt = new ElevenLabsTranscriber('secret-key', fetchFn);
    const res = await stt.transcribe({ audioUrl: 'https://cdn.example.com/a.mp3' });
    expect(res.words).toEqual([
      { word: 'Comment', startS: 0, endS: 0.4 },
      { word: 'plan', startS: 0.45, endS: 0.8 },
      { word: 'now.', startS: 0.9, endS: 1.2 },
    ]);
    expect(res.durationS).toBe(1.2);
    expect(res.costUsd).toBeGreaterThan(0);
    expect(calls[1]!.url).toBe(ELEVENLABS_STT_URL);
    expect((calls[1]!.init!.headers as Record<string, string>)['xi-api-key']).toBe('secret-key');
    const form = calls[1]!.init!.body as FormData;
    expect(form.get('model_id')).toBe('scribe_v1');
    expect(form.get('timestamps_granularity')).toBe('word');
    await expect(stt.transcribe({ audioUrl: 'http://cdn.example.com/a.mp3' })).rejects.toThrow(/https/);
  });
});
