import { CADENCE_BOUNDS, DEFAULT_CADENCE, WINNER_CADENCE } from '@troupe/agents';
import { createTestStudio, makeTestPersona, type TestStudio } from '@troupe/agents/testing';
import { json } from '@troupe/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createCadencePolicy, createRoutingPolicy, formatBounds, leverInputs, listLeverActions, measureLevers, planCadence, planFormatMix, runLevers, scaleTarget, validTarget } from '../src';
import { addDebit, addOrder, addPost, addWeeklyHistory, DAY, daysAgo, NOW } from './fixtures';

let t: TestStudio | null = null;
afterEach(async () => {
  await t?.db.close();
  t = null;
});

const NEXT_MONDAY = new Date('2026-10-19T00:00:00Z');
const sumOf = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);

async function qc(db: TestStudio['db'], personaId: string, n: number, pass: boolean, at: Date) {
  for (let i = 0; i < n; i++) {
    await db.query(
      `INSERT INTO qc_report (persona_id, subject_type, subject_id, stage, pass, created_at) VALUES ($1, 'script', gen_random_uuid(), 'Q1', $2, $3)`,
      [personaId, pass, at],
    );
  }
}

describe('Profit Engine levers', () => {
  it('raises a winner, trims a loser, logs expected impact and feeds the cadence policy', async () => {
    t = await createTestStudio({ cadence: createCadencePolicy, now: () => NOW });
    const win = await makeTestPersona(t, { name: 'Winner', state: 'MONETISING' });
    const lose = await makeTestPersona(t, { name: 'Loser' });
    await addWeeklyHistory(t.db, t.studioId, win.id, { weeks: 3, gross: 20_000, cost: 1_000 });
    await addWeeklyHistory(t.db, t.studioId, lose.id, { weeks: 3, gross: 0, cost: 3_000 });

    const applied = await runLevers(t.db, t.studioId, NOW);
    const raise = applied.find((a) => a.lever === 'cadence' && a.personaId === win.id)!;
    const trim = applied.find((a) => a.lever === 'cadence' && a.personaId === lose.id)!;
    expect(raise).toMatchObject({ before: { postsPerWeek: 10 }, after: { postsPerWeek: 13 }, status: 'applied', measuredImpactCents: null });
    expect(raise.expectedImpactCents).toBeGreaterThan(0);
    expect(trim).toMatchObject({ before: { postsPerWeek: 10 }, after: { postsPerWeek: 8 } });
    expect(trim.expectedImpactCents).toBeGreaterThan(0); // trimming loss-making posts saves money

    // Stream B's calendar reads the new targets from next Monday; this week keeps the default.
    const w = await t.services.cadence.target(win.id, NEXT_MONDAY);
    expect(w).toMatchObject({ postsPerWeek: 13, source: 'lever' });
    expect(validTarget(w)).toBe(true);
    expect(sumOf(w.formatMix)).toBe(13);
    expect(sumOf(w.purposeMix)).toBe(13);
    expect(w.purposeMix.sell).toBeGreaterThanOrEqual(1);
    expect(await t.services.cadence.target(win.id, new Date('2026-10-12T00:00:00Z'))).toEqual(DEFAULT_CADENCE);
    expect((await t.services.cadence.target(lose.id, NEXT_MONDAY)).postsPerWeek).toBe(8);

    // Every action is audited and logged; a second run the same week changes nothing.
    expect((await t.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'profit.lever_applied'`)).n).toBe(applied.length);
    expect(await runLevers(t.db, t.studioId, NOW)).toEqual([]);
    expect((await listLeverActions(t.db, t.studioId)).length).toBe(applied.length);
  });

  it('builds winner levers on the 17-a-week winner cadence, never on the 10-post default', async () => {
    t = await createTestStudio({ cadence: createCadencePolicy, now: () => NOW });
    const win = await makeTestPersona(t, { name: 'Scaler', state: 'SCALING' });
    expect(await t.services.cadence.target(win.id, NEXT_MONDAY)).toEqual(WINNER_CADENCE);
    await addWeeklyHistory(t.db, t.studioId, win.id, { weeks: 3, gross: 20_000, cost: 1_000 });
    const applied = await runLevers(t.db, t.studioId, NOW);
    const raise = applied.find((a) => a.lever === 'cadence' && a.personaId === win.id)!;
    expect(raise.before).toMatchObject({ postsPerWeek: 17 });
    const after = await t.services.cadence.target(win.id, NEXT_MONDAY);
    expect(after.postsPerWeek).toBeGreaterThan(17);
    expect(validTarget(after)).toBe(true);

    // A format-mix shift alone keeps the winner at 17.
    const fmtOnly = await makeTestPersona(t, { name: 'Brand', state: 'BRAND' });
    for (let i = 0; i < 4; i++) {
      const talk = await addPost(t.db, fmtOnly.id, { format: 'talking', at: daysAgo(3 + i * 5), views: 2000 });
      await addOrder(t.db, fmtOnly.id, { amount: 5_000, fee: 250, at: daysAgo(2 + i * 5), postId: talk.postId });
      const act = await addPost(t.db, fmtOnly.id, { format: 'activity_text', at: daysAgo(4 + i * 5), views: 500 });
      await addDebit(t.db, t.studioId, fmtOnly.id, { amount: 10, at: daysAgo(4 + i * 5), refType: 'post', refId: act.postId });
    }
    const fmt = await planFormatMix(await leverInputs(t.db, t.studioId, NOW), fmtOnly.id, { ignoreCooldown: true });
    expect(fmt).not.toBeNull();
    expect(sumOf(fmt!.after.formatMix as Record<string, number>)).toBe(17);
    expect((fmt!.effect as { target: { postsPerWeek: number } }).target.postsPerWeek).toBe(17);
  });

  it('keeps cadence inside 7–21 a week', async () => {
    t = await createTestStudio({ now: () => NOW });
    const top = await makeTestPersona(t, { name: 'Top', state: 'SCALING' });
    const low = await makeTestPersona(t, { name: 'Low' });
    await addWeeklyHistory(t.db, t.studioId, top.id, { weeks: 3, gross: 50_000, cost: 1_000 });
    await addWeeklyHistory(t.db, t.studioId, low.id, { weeks: 3, gross: 0, cost: 3_000 });
    for (const [id, n] of [
      [top.id, CADENCE_BOUNDS.max],
      [low.id, CADENCE_BOUNDS.min],
    ] as const) {
      const target = scaleTarget(DEFAULT_CADENCE, n, 'lever');
      await t.db.query(
        `INSERT INTO profit_cadence_override (studio_id, persona_id, effective_from, posts_per_week, format_mix, purpose_mix) VALUES ($1, $2, '2026-01-05', $3, $4::jsonb, $5::jsonb)`,
        [t.studioId, id, n, json(target.formatMix), json(target.purposeMix)],
      );
    }
    const inp = await leverInputs(t.db, t.studioId, NOW);
    expect(await planCadence(inp, top.id)).toBeNull();
    expect(await planCadence(inp, low.id)).toBeNull();
    // The database refuses an out-of-bounds target too.
    await expect(
      t.db.query(`INSERT INTO profit_cadence_override (studio_id, persona_id, effective_from, posts_per_week, format_mix, purpose_mix) VALUES ($1, $2, '2026-01-05', 30, '{}', '{}')`, [t.studioId, top.id]),
    ).rejects.toThrow();
  });

  it('shifts the format mix toward the most profitable format, within bounds', async () => {
    t = await createTestStudio({ cadence: createCadencePolicy, now: () => NOW });
    const p = await makeTestPersona(t, { name: 'Formats' });
    for (let i = 0; i < 4; i++) {
      const talk = await addPost(t.db, p.id, { format: 'talking', at: daysAgo(3 + i * 5), views: 2000 });
      await addOrder(t.db, p.id, { amount: 5_000, fee: 250, at: daysAgo(2 + i * 5), postId: talk.postId });
      const act = await addPost(t.db, p.id, { format: 'activity_text', at: daysAgo(4 + i * 5), views: 500 });
      await addDebit(t.db, t.studioId, p.id, { amount: 10, at: daysAgo(4 + i * 5), refType: 'post', refId: act.postId });
    }
    const applied = await runLevers(t.db, t.studioId, NOW);
    const fmt = applied.find((a) => a.lever === 'format_mix')!;
    expect(fmt).toBeDefined();
    const before = fmt.before.formatMix as Record<string, number>;
    const after = fmt.after.formatMix as Record<string, number>;
    expect(after.talking).toBe(before.talking! + 1);
    expect(after.activity_text).toBe(before.activity_text! - 1);
    const target = await t.services.cadence.target(p.id, NEXT_MONDAY);
    expect(validTarget(target)).toBe(true);
    expect(target.formatMix.talking).toBeGreaterThan(target.formatMix.activity_text);
    for (const v of Object.values(target.formatMix)) {
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(Math.ceil(target.postsPerWeek / 2));
    }
  });

  it('steps the scriptwriter down a tier while QC passes and reverts when quality drops', async () => {
    t = await createTestStudio({ routing: createRoutingPolicy, now: () => NOW });
    const p = await makeTestPersona(t, { name: 'Router' });
    await qc(t.db, p.id, 8, true, daysAgo(2));
    for (let i = 0; i < 2; i++) {
      await t.db.query(`INSERT INTO agent_run (studio_id, persona_id, agent, model, cost_usd, outcome, started_at) VALUES ($1, $2, 'scriptwriter', 'claude-sonnet-5-5', 0.6, 'ok', $3)`, [
        t.studioId,
        p.id,
        daysAgo(3 + i),
      ]);
    }
    const applied = await runLevers(t.db, t.studioId, NOW);
    const route = applied.find((a) => a.lever === 'model_routing')!;
    expect(route).toMatchObject({ before: { agent: 'scriptwriter', tier: 'standard' }, after: { agent: 'scriptwriter', tier: 'fast' } });
    expect(route.expectedImpactCents).toBeGreaterThan(0);
    expect(await t.services.routing.tierFor({ studioId: t.studioId, personaId: p.id, agent: 'scriptwriter' })).toBe('fast');
    expect(await t.services.routing.tierFor({ studioId: t.studioId, personaId: p.id, agent: 'compliance-gate' })).toBeNull();

    // The fake runtime routes through the policy: a scriptwriter run now uses the fast tier.
    const run = await t.services.runtime.run({ agent: 'scriptwriter', scope: { studioId: t.studioId, personaId: p.id }, label: 'x', system: 's', prompt: 'p', fake: () => 'ok' });
    expect(run.model).toBe('fake:claude-haiku-5-5');

    await qc(t.db, p.id, 5, false, new Date(NOW.getTime() + DAY));
    const m = await measureLevers(t.db, t.studioId, new Date(NOW.getTime() + 4 * DAY));
    expect(m.reverted.map((r) => r.id)).toEqual([route.id]);
    expect(m.reverted[0]!.status).toBe('reverted');
    expect(await t.services.routing.tierFor({ studioId: t.studioId, personaId: p.id, agent: 'scriptwriter' })).toBeNull();
  });

  it('still reverts a routing step-down after it was measured, keeping the measured impact', async () => {
    t = await createTestStudio({ routing: createRoutingPolicy, now: () => NOW });
    const p = await makeTestPersona(t, { name: 'Router' });
    await qc(t.db, p.id, 8, true, daysAgo(2));
    for (let i = 0; i < 2; i++) {
      await t.db.query(`INSERT INTO agent_run (studio_id, persona_id, agent, model, cost_usd, outcome, started_at) VALUES ($1, $2, 'scriptwriter', 'claude-sonnet-5-5', 0.6, 'ok', $3)`, [t.studioId, p.id, daysAgo(3 + i)]);
    }
    const route = (await runLevers(t.db, t.studioId, NOW)).find((a) => a.lever === 'model_routing')!;
    await qc(t.db, p.id, 10, true, new Date(NOW.getTime() + 5 * DAY));
    const m1 = await measureLevers(t.db, t.studioId, new Date(NOW.getTime() + 15 * DAY));
    const measured = m1.measured.find((x) => x.id === route.id)!;
    expect(measured.status).toBe('measured');
    await qc(t.db, p.id, 20, false, new Date(NOW.getTime() + 18 * DAY));
    const m2 = await measureLevers(t.db, t.studioId, new Date(NOW.getTime() + 20 * DAY));
    expect(m2.reverted.map((r) => r.id)).toEqual([route.id]);
    expect(m2.reverted[0]!.measuredImpactCents).toBe(measured.measuredImpactCents);
    expect(await t.services.routing.tierFor({ studioId: t.studioId, personaId: p.id, agent: 'scriptwriter' })).toBeNull();
  });

  it('reallocates next week\'s credits by profit per credit (70/20/10) without touching caps', async () => {
    t = await createTestStudio({ now: () => NOW });
    const win = await makeTestPersona(t, { name: 'Winner', state: 'MONETISING', budget: { hf_credits_month: 1200 } });
    const lose = await makeTestPersona(t, { name: 'Loser' });
    await addWeeklyHistory(t.db, t.studioId, win.id, { weeks: 3, gross: 20_000, cost: 1_000 });
    await addWeeklyHistory(t.db, t.studioId, lose.id, { weeks: 3, gross: 0, cost: 3_000 });
    const applied = await runLevers(t.db, t.studioId, NOW);
    const alloc = applied.find((a) => a.lever === 'credit_reallocation')!;
    expect(alloc.personaId).toBeNull();
    expect(alloc.expectedImpactCents).toBe(0);
    expect(alloc.rationale).toMatch(/^Plan only/);
    const rows = await t.db.query<{ persona_id: string | null; credits: number; source: string; lever_action_id: string }>(
      `SELECT persona_id, credits, source, lever_action_id FROM budget_allocation WHERE week_start = '2026-10-19'`,
    );
    expect(rows).toHaveLength(3);
    const credits = (id: string | null) => rows.find((r) => r.persona_id === id)!.credits;
    expect(credits(win.id)).toBeGreaterThan(credits(lose.id));
    expect(credits(null)).toBeGreaterThan(0); // studio reserve
    expect(rows.every((r) => r.source === 'lever' && r.lever_action_id === alloc.id)).toBe(true);
    expect(rows.reduce((a, r) => a + r.credits, 0)).toBeLessThanOrEqual(Math.ceil((8000 * 7) / 30.44));
    expect(credits(win.id)).toBeLessThanOrEqual(Math.ceil((1200 * 7) / 30.44)); // never above the persona's cap
    const budgets = await t.db.query<{ budget: Record<string, number> }>('SELECT budget FROM persona WHERE id = ANY($1::uuid[]) ORDER BY name DESC', [[win.id, lose.id]]);
    expect(budgets.map((b) => b.budget)).toEqual([{ hf_credits_month: 1200 }, {}]);
  });

  it('measures each lever after its review window', async () => {
    t = await createTestStudio({ now: () => NOW });
    const win = await makeTestPersona(t, { name: 'Winner', state: 'MONETISING' });
    await addWeeklyHistory(t.db, t.studioId, win.id, { weeks: 3, gross: 20_000, cost: 1_000 });
    const applied = await runLevers(t.db, t.studioId, NOW);
    expect(applied.length).toBeGreaterThan(0);
    // Better weeks after the change.
    for (let d = 1; d <= 20; d += 3) await addOrder(t.db, win.id, { amount: 10_000, fee: 500, at: new Date(NOW.getTime() + d * DAY) });
    expect((await measureLevers(t.db, t.studioId, new Date(NOW.getTime() + 5 * DAY))).measured).toEqual([]); // too early
    const later = new Date(NOW.getTime() + 30 * DAY);
    const { measured } = await measureLevers(t.db, t.studioId, later);
    // The credit allocation is plan only (nothing enforces it), so it is never measured.
    expect(measured.map((m) => m.id).sort()).toEqual(applied.filter((a) => a.lever !== 'credit_reallocation').map((a) => a.id).sort());
    const cadence = measured.find((m) => m.lever === 'cadence')!;
    expect(cadence.status).toBe('measured');
    expect(cadence.measuredImpactCents).toBeGreaterThan(0);
    expect(cadence.measuredAt).toEqual(later);
  });
});

describe('(IOS-5) optional formats in cadence targets', () => {
  it('scales the new default to the winner default exactly, keeps optional formats ≥ 1 and the core invariant', () => {
    expect(scaleTarget(DEFAULT_CADENCE, 17, 'default').formatMix).toEqual(WINNER_CADENCE.formatMix);
    for (const n of [7, 8, 13, 21]) {
      const s = scaleTarget({ ...DEFAULT_CADENCE, formatMix: { ...DEFAULT_CADENCE.formatMix, meme: 2 } }, n, 'lever');
      expect(validTarget(s), String(n)).toBe(true);
      for (const f of ['talking', 'activity_text', 'voiceover', 'static', 'carousel'] as const) expect(s.formatMix[f]).toBeGreaterThanOrEqual(1);
      expect(s.formatMix.photo_dump).toBeGreaterThanOrEqual(1);
      expect(s.formatMix.meme).toBeGreaterThanOrEqual(1);
    }
    const b = formatBounds(10, { on: ['photo_dump'] });
    expect(b.min).toMatchObject({ talking: 1, photo_dump: 1, meme: 0 });
    expect(b.max).toMatchObject({ talking: 5, photo_dump: 5, meme: 0 });
    expect(validTarget({ ...DEFAULT_CADENCE, formatMix: { ...DEFAULT_CADENCE.formatMix, bogus: 1 } as never, postsPerWeek: 11 })).toBe(false);
  });

  it('reads an override written before IOS-5 (core formats only) as it was, never adding the new default photo dump', async () => {
    t = await createTestStudio({ cadence: createCadencePolicy, now: () => NOW });
    const p = await makeTestPersona(t);
    await t.db.query(
      `INSERT INTO profit_cadence_override (studio_id, persona_id, effective_from, posts_per_week, format_mix, purpose_mix) VALUES ($1, $2, '2026-10-12', 10, $3::jsonb, $4::jsonb)`,
      [t.studioId, p.id, json({ talking: 3, activity_text: 3, voiceover: 2, static: 1, carousel: 1 }), json({ reach: 6, trust: 3, sell: 1 })],
    );
    const target = await t.services.cadence.target(p.id, NEXT_MONDAY);
    expect(target.formatMix).toEqual({ talking: 3, activity_text: 3, voiceover: 2, static: 1, carousel: 1 });
    expect(validTarget(target)).toBe(true);
  });
});
