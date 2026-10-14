import { type KnowledgeHit, type KnowledgeService, MEDIA_RENDER_JOB, type MediaRenderPayload } from '@ios/agents';
import { createTestStudio, makeTestPersona } from '@ios/agents/testing';
import { claimNext, DeferJob } from '@ios/core';
import { describe, expect, it } from 'vitest';
import { pipelineBoard, slotDetail } from '../src/board';
import { planWeek } from '../src/calendar';
import { dryRun } from '../src/dryrun';
import { jobs } from '../src/jobs';
import { processSlot, stageOf } from '../src/pipeline';
import { attachSampleBible } from '../src/sample';
import { wordCount } from '../src/util';

const NOW = new Date('2026-10-14T10:00:00Z');
const NEXT_MONDAY = new Date('2026-10-19T00:00:00Z');

describe('content pipeline: dry run on fakes', () => {
  it('goes persona → week of 10 slots → hook-lab scripts → Q1 → Gate → 10 media.render jobs', async () => {
    const r = await dryRun({ now: NOW });
    try {
      expect(r.slots).toHaveLength(10);
      expect(r.postsPerWeek).toBe(10);
      for (const s of r.slots) {
        expect(s.status).toBe('media_queued');
        expect(s.q1Pass).toBe(true);
        expect(['green', 'amber']).toContain(s.verdict);
        expect(s.hook).toBeTruthy();
        expect(s.variants).toHaveLength(2);
        expect(s.ctaKeyword).toBeTruthy();
      }
      expect(r.mediaJobs).toHaveLength(10);
      const spoken = r.mediaJobs.filter((j) => j.format === 'talking' || j.format === 'voiceover');
      expect(spoken).toHaveLength(5);
      for (const j of spoken) {
        expect(wordCount(j.voiceover!)).toBeGreaterThanOrEqual(40);
        expect(wordCount(j.voiceover!)).toBeLessThanOrEqual(95);
        expect(j.voiceover).not.toMatch(/\d|\$|%/); // pronunciation-safe after Q1
        expect(j.voiceover).toMatch(new RegExp(`Comment ${j.ctaKeyword}`));
      }
      const carousel = r.mediaJobs.find((j) => j.format === 'carousel')!;
      expect(carousel.carousel!.length).toBeGreaterThanOrEqual(6);
      expect(carousel.voiceover).toBeNull();
      const activity = r.mediaJobs.find((j) => j.format === 'activity_text')!;
      expect(activity.onScreenText.length).toBeGreaterThanOrEqual(3);
      for (const j of r.mediaJobs) {
        expect(j.caption).toContain(j.ctaKeyword);
        expect(j.hashtags.length).toBeGreaterThanOrEqual(3);
        expect(j.visualBrief).toMatch(/AI label/);
      }
      // Monetization: FR-20.1 lead magnet + entry product, listing packs and launch plans.
      expect(r.monetization.products.map((p) => p.rung).sort()).toEqual(['entry', 'lead_magnet']);
      expect(r.monetization.listings).toHaveLength(2);
      // Q2: the clean read passes, the misheard CTA keyword fails.
      expect(r.q2?.clean.pass).toBe(true);
      expect(r.q2?.misheard.pass).toBe(false);
      // Every slot's LLM spend is attributed to its calendar slot (D builds per-post P&L from it).
      expect(r.ledger.find((l) => l.refType === 'calendar_slot')!.usd).toBeGreaterThan(0);
      expect(r.ledger.find((l) => l.refType === 'product')!.usd).toBeGreaterThan(0);
    } finally {
      await r.close();
    }
  });
});

describe('content pipeline: stages', () => {
  it('is idempotent: a re-run never redoes work or enqueues media twice', async () => {
    const t = await createTestStudio({ now: () => NOW });
    const p = await makeTestPersona(t);
    await attachSampleBible(t.db, p.id);
    const { slotIds } = await planWeek(t.services, p.id, NEXT_MONDAY);
    const first = await processSlot(t.services, slotIds[0]!);
    expect(first.status).toBe('media_queued');
    const again = await processSlot(t.services, slotIds[0]!);
    expect(again.status).toBe('media_queued');
    const n = await t.db.one<{ scripts: number; jobs: number }>(
      `SELECT (SELECT count(*) FROM script WHERE slot_id = $1)::int AS scripts, (SELECT count(*) FROM job WHERE kind = $2)::int AS jobs`,
      [slotIds[0], MEDIA_RENDER_JOB],
    );
    expect(n).toEqual({ scripts: 1, jobs: 1 });
    // Resuming from the Gate stage re-runs only the Gate and finds the existing media job.
    await t.db.query(`UPDATE calendar_slot SET status = 'gate' WHERE id = $1`, [slotIds[0]]);
    expect((await processSlot(t.services, slotIds[0]!)).mediaJobId).toBe(first.mediaJobId);
    await t.db.close();
  });

  it('blocks a Gate red with the reason, never queues it for media, and tells the Owner', async () => {
    const t = await createTestStudio({ now: () => NOW });
    const p = await makeTestPersona(t);
    await attachSampleBible(t.db, p.id);
    const slot = await t.db.one<{ id: string }>(
      `INSERT INTO calendar_slot (persona_id, slot_at, format, purpose, pillar, title, cta_keyword) VALUES ($1, $2, 'talking', 'sell', 'Products', 'How I made $10K with this budget sheet', 'SHEET') RETURNING id`,
      [p.id, new Date('2026-10-20T23:00:00Z')],
    );
    const out = await processSlot(t.services, slot.id);
    expect(out.status).toBe('blocked');
    expect(out.verdict).toBe('red');
    expect(out.blockReason).toMatch(/Gate red: fabricated results/);
    expect((await t.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM job WHERE kind = $1`, [MEDIA_RENDER_JOB])).n).toBe(0);
    expect((await t.db.one<{ status: string }>(`SELECT status FROM script WHERE slot_id = $1`, [slot.id])).status).toBe('rejected');
    expect((await t.db.one<{ kind: string; link: string }>(`SELECT kind, link FROM notification`)).link).toBe(`/pipeline/${slot.id}`);
    const board = await pipelineBoard(t.db, t.studioId, {});
    expect(board[0]).toMatchObject({ stage: 'blocked', gateVerdict: 'red' });
    await t.db.close();
  });

  it('cites knowledge hits as evidence and carries them into the media payload', async () => {
    const hit: KnowledgeHit = {
      kind: 'node',
      id: '11111111-1111-4111-8111-111111111111',
      niche: 'Personal finance',
      title: 'Sinking funds',
      text: 'Sinking funds spread irregular costs across the months before they are due.',
      citations: [{ url: 'https://example.org/sinking' }],
      score: 0.9,
      lastVerifiedAt: null,
    };
    const knowledge = (): KnowledgeService => ({ retrieve: async () => [hit], latestBriefing: async () => null });
    const t = await createTestStudio({ now: () => NOW, knowledge });
    const p = await makeTestPersona(t);
    await attachSampleBible(t.db, p.id);
    const slot = await t.db.one<{ id: string }>(
      `INSERT INTO calendar_slot (persona_id, slot_at, format, purpose, pillar, title, cta_keyword) VALUES ($1, $2, 'talking', 'trust', 'Budget basics', 'Sinking funds explained', 'PLAN') RETURNING id`,
      [p.id, new Date('2026-10-20T23:00:00Z')],
    );
    expect((await processSlot(t.services, slot.id)).status).toBe('media_queued');
    const job = await t.db.one<{ payload: MediaRenderPayload }>(`SELECT payload FROM job WHERE kind = $1`, [MEDIA_RENDER_JOB]);
    expect(job.payload.evidence).toEqual([hit.id]);
    const detail = await slotDetail(t.db, t.studioId, slot.id);
    expect(detail?.script?.claims).toEqual([{ text: expect.stringContaining('Sinking funds spread'), evidence_id: hit.id }]);
    expect(detail?.qc[0]?.checks.find((c) => c.check === 'claims_cited')?.pass).toBe(true);
    await t.db.close();
  });

  it('defers (no attempt spent) when the persona budget cap is reached', async () => {
    const t = await createTestStudio({ now: () => NOW });
    const p = await makeTestPersona(t, { budget: { llm_usd_month: 0 } });
    const slot = await t.db.one<{ id: string }>(
      `INSERT INTO calendar_slot (persona_id, slot_at, format, purpose, title) VALUES ($1, $2, 'talking', 'reach', 'A calm payday') RETURNING id`,
      [p.id, new Date('2026-10-20T23:00:00Z')],
    );
    await t.db.query(`INSERT INTO job (studio_id, persona_id, kind, payload) VALUES ($1, $2, 'pipeline.slot', $3::jsonb)`, [t.studioId, p.id, JSON.stringify({ slotId: slot.id })]);
    const job = (await claimNext(t.db, { workerId: 'w1', kinds: ['pipeline.slot'] }))!;
    await expect(jobs['pipeline.slot']!({ services: t.services, job, heartbeat: async () => true })).rejects.toBeInstanceOf(DeferJob);
    const row = await t.db.one<{ status: string; waiting: string }>(`SELECT status, meta->>'waiting' AS waiting FROM calendar_slot WHERE id = $1`, [slot.id]);
    expect(row.status).toBe('planned');
    expect(row.waiting).toMatch(/budget cap/);
    await t.db.close();
  });

  it('maps every slot status to a board stage', () => {
    expect(stageOf('planned')).toBe('idea');
    expect(stageOf('scripted')).toBe('script');
    expect(stageOf('media_queued')).toBe('media_queued');
    expect(stageOf('rendering')).toBe('render');
    expect(stageOf('qc')).toBe('final_gate');
    expect(stageOf('blocked')).toBe('blocked');
    expect(stageOf('skipped')).toBeNull();
  });
});
