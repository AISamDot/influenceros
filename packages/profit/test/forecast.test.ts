import { decide, OWNER } from '@ios/core';
import { createTestStudio, makeTestPersona, type TestStudio } from '@ios/agents/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { fitSeries, forecastStudio, HORIZON_WEEKS, latestForecast, proposeKillCandidates, storeForecasts } from '../src';
import { addDebit, addWeeklyHistory, daysAgo, NOW } from './fixtures';

let t: TestStudio | null = null;
afterEach(async () => {
  await t?.db.close();
  t = null;
});

const ordered = (b: { p10: number; median: number; p90: number }) => b.p10 <= b.median && b.median <= b.p90;

describe('90-day Monte Carlo forecast', () => {
  it('returns P10/median/P90 per week and in total, deterministic for a seed', async () => {
    t = await createTestStudio();
    const win = await makeTestPersona(t, { name: 'Winner', state: 'MONETISING' });
    const lose = await makeTestPersona(t, { name: 'Loser' });
    await addWeeklyHistory(t.db, t.studioId, win.id, { weeks: 8, gross: 40_000, cost: 8_000, growth: 1.05 });
    await addWeeklyHistory(t.db, t.studioId, lose.id, { weeks: 8, gross: 0, cost: 8_000 });
    await addDebit(t.db, t.studioId, null, { amount: 10, at: daysAgo(9) }); // studio overhead

    const f = await forecastStudio(t.db, { studioId: t.studioId, now: NOW, runs: 500, seed: 42 });
    expect(f.personas).toHaveLength(2);
    for (const fc of [f.studio, ...f.personas]) {
      expect(fc.horizonDays).toBe(90);
      expect(fc.runs).toBe(500);
      expect(fc.weekly).toHaveLength(HORIZON_WEEKS);
      expect(fc.weekly[0]!.weekStart).toBe('2026-10-19');
      for (const w of fc.weekly) expect(ordered(w)).toBe(true);
      expect(ordered(fc.totalCents)).toBe(true);
      expect(ordered(fc.monthRemainderCents!)).toBe(true);
    }
    const w = f.personas.find((p) => p.personaId === win.id)!;
    const l = f.personas.find((p) => p.personaId === lose.id)!;
    expect(w.totalCents.median).toBeGreaterThan(0);
    expect(w.negativeWeeks).toBe(0);
    expect(w.weeksOfHistory).toBe(8);
    expect(w.totalCents.p90).toBeGreaterThan(w.totalCents.p10); // the fan has width
    expect(l.negativeWeeks).toBe(HORIZON_WEEKS);
    expect(l.totalCents.median).toBeLessThan(-8_000 * 10); // ~$80 a week of cost, nothing sold
    // The studio total is the run-by-run sum (personas + overhead), so its median sits near the sum of medians.
    expect(Math.abs(f.studio.totalCents.median - (w.totalCents.median + l.totalCents.median))).toBeLessThan(Math.abs(w.totalCents.median) * 0.25 + 20_000);

    const again = await forecastStudio(t.db, { studioId: t.studioId, now: NOW, runs: 500, seed: 42 });
    expect(again.studio.totalCents).toEqual(f.studio.totalCents);

    await storeForecasts(t.db, t.studioId, f, NOW);
    await storeForecasts(t.db, t.studioId, f, NOW); // a re-run replaces the week's row
    const stored = await latestForecast(t.db, t.studioId, null);
    expect(stored?.totalCents).toEqual(f.studio.totalCents);
    expect((await t.db.one<{ n: number }>('SELECT count(*)::int AS n FROM profit_forecast')).n).toBe(3);
  });

  it('fits growth, volatility and fee rate from history and ignores the quiet weeks before launch', () => {
    const weeks = Array.from({ length: 8 }, (_, i) => ({
      weekStart: `w${i}`,
      grossCents: i < 3 ? 0 : 10_000 * 1.1 ** (i - 3),
      feesCents: i < 3 ? 0 : 1_000,
      refundsCents: 0,
      costCents: i < 3 ? 0 : 2_000,
      profitCents: 0,
      posts: i < 3 ? 0 : 10,
      views: 0,
    }));
    const fit = fitSeries(weeks);
    expect(fit.weeksOfHistory).toBe(5);
    expect(fit.growth).toBeGreaterThan(0);
    expect(fit.growth).toBeLessThanOrEqual(0.2);
    expect(fit.volatility).toBeGreaterThanOrEqual(0.15);
    expect(fit.feeRate).toBeGreaterThan(0.05);
    expect(fit.costLevelCents).toBe(2_000);
  });
});

describe('kill candidates', () => {
  it('turns a 4+ week negative forecast into exactly one kill proposal (never a kill)', async () => {
    t = await createTestStudio();
    const lose = await makeTestPersona(t, { name: 'Loser' });
    const fresh = await makeTestPersona(t, { name: 'Newbie' });
    await addWeeklyHistory(t.db, t.studioId, lose.id, { weeks: 6, gross: 0, cost: 5_000 });
    await addWeeklyHistory(t.db, t.studioId, fresh.id, { weeks: 1, gross: 0, cost: 5_000 });
    const f = await forecastStudio(t.db, { studioId: t.studioId, now: NOW, runs: 300, seed: 7 });

    const first = await proposeKillCandidates(t.db, t.studioId, f.personas, NOW);
    expect(first.find((k) => k.personaId === lose.id)).toMatchObject({ action: 'kill', approvalId: expect.any(String) });
    expect(first.find((k) => k.personaId === fresh.id)?.skipped).toMatch(/weeks of history/);

    const second = await proposeKillCandidates(t.db, t.studioId, f.personas, NOW);
    expect(second.find((k) => k.personaId === lose.id)?.skipped).toMatch(/already pending/);

    const approvals = await t.db.query<{ kind: string; mode: string; proposed_by: string; payload: { evidence: { source: string; negative_weeks: number } } }>(
      `SELECT kind, mode, proposed_by, payload FROM approval WHERE persona_id = $1`,
      [lose.id],
    );
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ kind: 'persona_kill', mode: 'explicit', proposed_by: 'agent:studio-manager' });
    expect(approvals[0]!.payload.evidence.source).toBe('profit-engine');
    expect(approvals[0]!.payload.evidence.negative_weeks).toBeGreaterThanOrEqual(4);
    expect((await t.db.one<{ state: string }>('SELECT state FROM persona WHERE id = $1', [lose.id])).state).toBe('TESTING');
    expect((await t.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM kill_scale_proposal WHERE persona_id = $1`, [lose.id])).n).toBe(1);
  });

  it('proposes retirement for a BRAND persona and waits after the Owner rejects', async () => {
    t = await createTestStudio();
    const brand = await makeTestPersona(t, { name: 'Brand', state: 'BRAND' });
    await addWeeklyHistory(t.db, t.studioId, brand.id, { weeks: 6, gross: 0, cost: 5_000 });
    const f = await forecastStudio(t.db, { studioId: t.studioId, now: NOW, runs: 300, seed: 7 });
    const [k] = await proposeKillCandidates(t.db, t.studioId, f.personas, NOW);
    expect(k).toMatchObject({ action: 'retire', approvalId: expect.any(String) });
    await decide(t.db, { approvalId: k!.approvalId!, decision: 'reject', actor: OWNER, now: NOW });
    const [again] = await proposeKillCandidates(t.db, t.studioId, f.personas, new Date(NOW.getTime() + 86_400_000));
    expect(again?.skipped).toMatch(/rejected/);
  });
});
