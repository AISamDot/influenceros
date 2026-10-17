import { apifyWeekSpendUsd, nullWorld, type StudioServices } from '@troupe/agents';
import { createTestStudio, makeTestPersona, type TestStudio } from '@troupe/agents/testing';
import { DeferJob, type JobRow, runOnce } from '@troupe/core';
import { FakeApify } from '@troupe/providers';
import { afterEach, describe, expect, it } from 'vitest';
import * as radar from '../src';

const DAY = 86_400_000;
let t: TestStudio | null = null;
afterEach(async () => {
  await t?.db.close();
  t = null;
});

function clock(start: string) {
  let now = new Date(start);
  return { now: () => now, advance: (days: number) => (now = new Date(now.getTime() + days * DAY)) };
}

/** Runs every due Radar job (deferrals included) until the queue is empty or only future-deferred jobs remain. */
async function drain(services: StudioServices, now: () => Date, max = 200): Promise<Array<{ kind: string; outcome: string; error?: string }>> {
  const log: Array<{ kind: string; outcome: string; error?: string }> = [];
  const handlers = Object.fromEntries(
    Object.entries(radar.jobs).map(([k, h]) => [k, (job: JobRow) => h({ services, job, heartbeat: async () => true })]),
  );
  for (let i = 0; i < max; i += 1) {
    const r = await runOnce(services.db, handlers, { workerId: 'test', now: new Date(Math.max(Date.now(), now().getTime()) + 60 * 60_000), policy: { baseMs: 1, capMs: 1 } });
    if (!r) break;
    const row = await services.db.one<{ last_error: string | null }>('SELECT last_error FROM job WHERE id = $1', [r.job.id]);
    log.push({ kind: r.job.kind, outcome: r.outcome, ...(row.last_error ? { error: row.last_error } : {}) });
    if (r.outcome === 'deferred' && log.filter((l) => l.kind === r.job.kind && l.outcome === 'deferred').length > 5) break;
  }
  return log;
}

describe('Growth Radar weekly run on fakes', () => {
  it('discovers, snapshots, scores, reviews, clusters, reports and books remix ideas, every run debited through meteredApify', async () => {
    const c = clock('2026-10-12T09:00:00Z');
    t = await createTestStudio({ now: c.now, radar: radar.createRadarService, tools: radar.tools });
    const persona = await makeTestPersona(t, { name: 'Pip Ledger', niche: 'personal finance', state: 'TESTING' });

    // Week 1.
    expect(await radar.enqueueWeekly(t.services, t.studioId)).toBeTruthy();
    const log = await drain(t.services, c.now);
    expect(log.filter((l) => l.outcome !== 'succeeded' && l.outcome !== 'deferred')).toEqual([]);
    expect(log.map((l) => l.kind)).toEqual(expect.arrayContaining(['radar.weekly', 'radar.scan', 'radar.finish', 'remix.weekly', 'radar.report']));

    const db = t.db;
    const accounts = await db.query<{ platform: string; niche: string; source: string; growth_basis: string }>('SELECT platform, niche, source, growth_basis FROM tracked_account WHERE studio_id = $1', [t.studioId]);
    expect(accounts.length).toBeGreaterThan(10);
    expect(new Set(accounts.map((a) => a.platform))).toEqual(new Set(['instagram', 'tiktok']));
    expect(accounts.every((a) => a.niche === 'personal finance')).toBe(true);
    expect(accounts.some((a) => a.source === 'outlier')).toBe(true);
    const snaps = await db.one<{ n: number }>('SELECT count(*)::int AS n FROM profile_snapshot WHERE studio_id = $1', [t.studioId]);
    expect(snaps.n).toBe(accounts.length);

    // Every Apify run went through the governor: ledger debits with provider 'apify' match the run log.
    const runs = await db.query<{ status: string; cost_usd: string }>(`SELECT status, cost_usd FROM radar_run WHERE studio_id = $1 AND kind <> 'discover_done'`, [t.studioId]);
    expect(runs.length).toBeGreaterThan(4);
    expect(runs.every((r) => r.status === 'ok')).toBe(true);
    const ledger = await db.one<{ n: number; usd: number }>(`SELECT count(*)::int AS n, COALESCE(sum(amount),0)::float8 AS usd FROM credit_ledger WHERE studio_id = $1 AND provider = 'apify' AND entry_type = 'debit'`, [t.studioId]);
    expect(ledger.n).toBe(runs.length);
    expect(ledger.usd).toBeCloseTo(runs.reduce((a, r) => a + Number(r.cost_usd), 0), 4);
    expect(await apifyWeekSpendUsd(db, t.studioId, c.now())).toBeCloseTo(ledger.usd, 4);
    const calls = (t.providers.research as FakeApify).calls.filter((x) => x.method === 'runActor');
    expect(calls.every((x) => typeof (x.args as { maxItems?: number }).maxItems === 'number')).toBe(true);

    // Scores: strong outliers exist; accelerating accounts on the first pass.
    const tiers = await db.query<{ tier: string; n: number }>(`SELECT tier, count(*)::int AS n FROM radar_post WHERE studio_id = $1 GROUP BY tier`, [t.studioId]);
    expect(tiers.find((r) => r.tier === 'strong')?.n ?? 0).toBeGreaterThan(0);
    expect(accounts.every((a) => a.growth_basis === 'first_pass')).toBe(true);
    expect((await db.one<{ n: number }>('SELECT count(*)::int AS n FROM tracked_account WHERE accelerating')).n).toBeGreaterThan(0);

    // Reviews, trends, demand signals.
    expect((await db.one<{ n: number }>('SELECT count(*)::int AS n FROM radar_review')).n).toBeGreaterThan(0);
    const trends = await db.query<{ dimension: string; adopters: number }>('SELECT dimension, adopters FROM radar_trend WHERE studio_id = $1', [t.studioId]);
    expect(trends.length).toBeGreaterThan(0);
    expect(trends.every((tr) => tr.adopters >= 2)).toBe(true);
    const signals = await db.query<{ text: string }>(`SELECT text FROM demand_signal WHERE persona_id = $1 AND source = 'radar'`, [persona.id]);
    expect(signals.length).toBeGreaterThan(0);

    // Viral Remix: a brief booked as a new idea the calendar can take.
    const ideas = await db.query<{ status: string; format: string; source: { type: string; remix_brief_id: string } }>(`SELECT status, format, source FROM idea WHERE persona_id = $1 AND source->>'type' = 'remix'`, [persona.id]);
    expect(ideas.length).toBeGreaterThan(0);
    expect(ideas[0]!.status).toBe('new');
    const brief = await db.one<{ status: string; idea_id: string }>('SELECT status, idea_id FROM remix_brief WHERE id = $1', [ideas[0]!.source.remix_brief_id]);
    expect(brief.status).toBe('booked');

    // The Trend Report landed in the Studio chat (and only once).
    const msgs = await db.query<{ body: string; author: string; meta: { kind: string; untrusted: boolean } }>(
      `SELECT m.body, m.author, m.meta FROM chat_message m JOIN chat_thread th ON th.id = m.thread_id WHERE th.studio_id = $1 AND th.kind = 'studio' AND m.meta->>'kind' = 'trend_report'`,
      [t.studioId],
    );
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.author).toBe('agent:trend-scout');
    expect(msgs[0]!.meta.untrusted).toBe(true);
    expect(msgs[0]!.body).toContain('Weekly Trend Report');
    expect(msgs[0]!.body).toMatch(/static image|carousel|photo dump|text note/);
    expect(await radar.postTrendReport(db, t.studioId, c.now())).toBeNull();
    expect((await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM notification WHERE link = '/radar'`)).n).toBe(1);

    // RadarService: benchmarks (incl. stills and carousels), evidence and patterns.
    const bm = await t.services.radar.formatBenchmarks({ studioId: t.studioId, niche: 'Personal Finance' });
    expect(bm).not.toBeNull();
    expect(Object.keys(bm!.formatShare).length).toBeGreaterThan(0);
    expect(Object.values(bm!.formatShare).reduce((a, b) => a + (b ?? 0), 0)).toBeCloseTo(1, 1);
    expect(Object.keys(bm!.formatLift)).toEqual(expect.arrayContaining(['carousel']));
    expect(bm!.storiesPerDay).toBeNull();
    const ev = await t.services.radar.opportunityEvidence({ studioId: t.studioId, niches: ['personal finance'] });
    expect(ev.length).toBeGreaterThan(0);
    expect(ev.every((e) => e.niche === 'personal finance' && e.score >= 0 && e.score <= 1)).toBe(true);
    expect(ev.some((e) => e.signal === 'trend')).toBe(true);
    expect(await t.services.radar.monetisationPatterns({ studioId: t.studioId, niche: 'personal finance' })).not.toEqual([]);
    expect(await t.services.radar.formatBenchmarks({ studioId: t.studioId, niche: 'knitting' })).toBeNull();

    // Weeks 2 and 3: snapshots build history → velocity, then acceleration.
    for (const _ of [1, 2]) {
      c.advance(7);
      await radar.enqueueWeekly(t.services, t.studioId);
      const l = await drain(t.services, c.now);
      expect(l.filter((x) => x.outcome !== 'succeeded' && x.outcome !== 'deferred')).toEqual([]);
    }
    const hist = await db.query<{ growth_basis: string; velocity: string | null; acceleration: string | null; accelerating: boolean }>(
      `SELECT growth_basis, velocity, acceleration, accelerating FROM tracked_account WHERE studio_id = $1 AND status = 'active'`,
      [t.studioId],
    );
    expect(hist.some((h) => h.growth_basis === 'history' && h.acceleration !== null)).toBe(true);
    expect(hist.some((h) => h.accelerating && Number(h.velocity) > 0 && Number(h.acceleration) > 0)).toBe(true);
    expect((await db.one<{ n: number }>(`SELECT count(DISTINCT week_start)::int AS n FROM profile_snapshot`)).n).toBe(3);
  }, 60_000);

  it('defers a scan past the weekly Apify cap and never raises it', async () => {
    const c = clock('2026-10-12T09:00:00Z');
    t = await createTestStudio({ now: c.now, settings: { apify_weekly_cap_usd: 0.1 }, radar: radar.createRadarService });
    await makeTestPersona(t, { niche: 'home baking', state: 'TESTING' });
    await radar.enqueueWeekly(t.services, t.studioId);
    const log = await drain(t.services, c.now);
    expect(log.some((l) => l.kind === 'radar.scan' && l.outcome === 'deferred' && /weekly cap/i.test(l.error ?? ''))).toBe(true);
    const capped = await t.db.query(`SELECT 1 FROM radar_run WHERE status = 'capped'`);
    expect(capped.length).toBeGreaterThan(0);
    expect(await apifyWeekSpendUsd(t.db, t.studioId, c.now())).toBeLessThanOrEqual(0.1);
    const settings = await t.db.one<{ cap: number }>(`SELECT (settings->>'apify_weekly_cap_usd')::float8 AS cap FROM studio WHERE id = $1`, [t.studioId]);
    expect(settings.cap).toBe(0.1);
    // The deferred scan waits for spend to roll out of the 7-day window (≥ 1 h).
    const job = await t.db.one<{ status: string; run_at: Date }>(`SELECT status, run_at FROM job WHERE kind = 'radar.scan'`);
    expect(job.status).toBe('queued');
    expect(new Date(job.run_at).getTime()).toBeGreaterThan(c.now().getTime() + 59 * 60_000);
    expect(DeferJob).toBeDefined();
  });

  it('scans nothing for an empty studio', async () => {
    t = await createTestStudio({ radar: radar.createRadarService });
    const sched = radar.schedules.find((s) => s.name === 'radar.weekly')!;
    expect(await sched.run(t.services, new Date())).toEqual({ queued: 0 });
    expect(await t.services.radar.opportunityEvidence({ studioId: t.studioId })).toEqual([]);
  });

  it('a remix brief blocked by the no-repeat check books nothing', async () => {
    const c = clock('2026-10-12T09:00:00Z');
    t = await createTestStudio({
      now: c.now,
      radar: radar.createRadarService,
      world: (base) => ({ ...nullWorld(base), checkConcept: async () => ({ ok: false, similarity: 0.97, nearest: { id: 'x', title: 'an old concept', scope: 'persona' as const, similarity: 0.97 }, reason: 'too close' }) }),
    });
    const p = await makeTestPersona(t, { niche: 'personal finance', state: 'TESTING' });
    const cfg = await radar.loadConfig(t.db, t.studioId);
    const scan = (await radar.nichesToScan(t.db, t.studioId, cfg, c.now()))[0]!;
    await radar.discoverNiche(t.services, t.studioId, scan, cfg);
    await radar.snapshotNiche(t.services, t.studioId, scan.niche, cfg);
    const r = await radar.createRemixBrief(t.services, { personaId: p.id });
    expect(r).not.toBeNull();
    expect(r!.status).toBe('blocked_repeat');
    expect(r!.ideaId).toBeNull();
    expect((await t.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM idea WHERE persona_id = $1`, [p.id])).n).toBe(0);
    // Idempotent per persona and source post.
    expect((await radar.createRemixBrief(t.services, { personaId: p.id, radarPostId: (await t.db.one<{ radar_post_id: string }>('SELECT radar_post_id FROM remix_brief')).radar_post_id }))!.existing).toBe(true);
  });
});
