import { type FormatBenchmark, nullRadar, type RadarService, WINNER_CADENCE } from '@troupe/agents';
import { createTestStudio, makeTestPersona, type TestStudio } from '@troupe/agents/testing';
import { attachSampleBible, planWeek } from '@troupe/content';
import { CORE_FORMATS, OWNER, STUDIO_MANAGER } from '@troupe/core';
import { json } from '@troupe/db';
import { chooseOption, createDraft, GENERATOR_TOOLS, launchDraft, setDraftExtension } from '@troupe/generator';
import { createCadencePolicy, formatBounds, leverInputs, planFormatMix, runLevers, validTarget } from '@troupe/profit';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Generator walks and full Story days are heavy under the parallel suite (PGlite per test).
vi.setConfig({ testTimeout: 120_000 });
import { createFormatPlanService, defaultPlan, editPlan, latestPlanVersion, planInForce, planMixOf, savePlan, tools } from '../src';

const NOW = new Date('2026-10-16T09:00:00Z'); // a Friday
const NEXT_MONDAY = new Date('2026-10-19T00:00:00Z');
const sumOf = (o: Record<string, number | undefined>) => Object.values(o).reduce<number>((a, b) => a + (b ?? 0), 0);
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

let t: TestStudio | null = null;
afterEach(async () => {
  await t?.db.close();
  t = null;
});

const benchmark: FormatBenchmark = {
  niche: 'x',
  sample: { accounts: 8, posts: 120 },
  formatShare: { carousel: 0.3, meme: 0.25, static: 0.15, talking: 0.15, activity_text: 0.15 },
  formatLift: { meme: 6 },
  postsPerWeek: 10,
  storiesPerDay: 5,
  confidence: 'high',
  updatedAt: new Date('2026-10-12T00:00:00Z'),
};
const radarWith = (b: FormatBenchmark | null): RadarService => ({ ...nullRadar(), formatBenchmarks: async ({ niche }) => (b ? { ...b, niche } : null) });

describe('FormatPlanService in the Persona Generator (step 6 → launch)', () => {
  it('recommends in step 6 from the Radar benchmark, takes the Owner edit as a new draft version, and adopts it at launch', async () => {
    t = await createTestStudio({ tools: GENERATOR_TOOLS, now: () => NOW, formatPlans: createFormatPlanService, radar: () => radarWith(benchmark), cadence: createCadencePolicy });
    const ctx = { actor: OWNER };
    let d = await createDraft(t.services, { studioId: t.studioId, actor: OWNER });
    for (const step of [1, 2, 3, 4, 5]) d = await chooseOption(t.services, d.id, step, 'A', ctx);
    const plan = d.state.formatPlan!;
    expect(plan).toBeTruthy();
    expect(plan.source).toBe('recommended');
    expect(plan.benchmark).toMatchObject({ confidence: 'high' });
    expect(plan.lines.find((l) => l.format === 'meme')?.enabled).toBe(true); // the niche benchmark switched it on
    expect(plan.stories.perDay).toBe(5);
    for (const l of plan.lines) expect(l.reason).toBeTruthy();

    // The Owner edits the plan in the generator: one more static, Stories 4 a day.
    const edited = editPlan(plan, { counts: { static: (plan.lines.find((l) => l.format === 'static')!.perWeek ?? 0) + 1 }, storiesPerDay: 4 });
    const before = d.version;
    d = await setDraftExtension(t.services, d.id, 'formatPlan', edited, { actor: OWNER, expectVersion: d.version, change: 'format plan: +1 static' });
    expect(d.version).toBe(before + 1);
    expect(d.state.formatPlan?.source).toBe('owner');
    d = await chooseOption(t.services, d.id, 6, 'A', ctx);

    const r = await launchDraft(t.services, d.id, { actor: OWNER });
    const v = await latestPlanVersion(t.db, r.persona.id);
    expect(v).toMatchObject({ version: 1, source: 'owner', createdBy: 'owner:hossam' });
    expect(planMixOf(v!.plan)).toEqual(planMixOf(edited));
    const inForce = await t.services.formatPlans.planFor(r.persona.id);
    expect(inForce?.stories.perDay).toBe(4);
    expect((await t.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'formats.plan_adopted'`)).n).toBe(1);
  });

  it('falls back to the default weights when the Radar has no benchmark yet', async () => {
    t = await createTestStudio({ now: () => NOW, formatPlans: createFormatPlanService });
    const p = await t.services.formatPlans.recommend({ studioId: t.studioId, niche: 'dating', archetype: 'quiet florist', ladder: [] });
    expect(p?.benchmark).toBeNull();
    expect(p?.reason).toMatch(/no niche benchmark yet/);
    // The budget comes from the persona default caps at the Profit Engine's credit price (1200 × 4.4¢ ≈ $53).
    expect(p?.reason).toMatch(/of a \$53 media budget/);
  });
});

describe('CadencePolicy and the format lever read the Format Plan', () => {
  it('plans the week from the plan (optional formats included), and the newest of plan and lever override wins', async () => {
    t = await createTestStudio({ now: () => NOW, formatPlans: createFormatPlanService, cadence: createCadencePolicy });
    const p = await makeTestPersona(t);
    await attachSampleBible(t.db, p.id);
    const plan = editPlan(defaultPlan(), { counts: { talking: 1, static: 3, text_note: 2, meme: 1, photo_dump: 0 } });
    await t.db.transaction((tx) => t!.services.formatPlans.adoptPlan(tx, { personaId: p.id, studioId: t!.studioId, plan, actor: OWNER }));
    const target = await t.services.cadence.target(p.id, NEXT_MONDAY);
    expect(target).toMatchObject({ postsPerWeek: 12, source: 'owner' });
    expect(target.formatMix).toEqual({ talking: 1, activity_text: 2, voiceover: 1, static: 3, carousel: 2, text_note: 2, meme: 1 });
    expect(validTarget(target)).toBe(true);
    expect((await planWeek(t.services, p.id, NEXT_MONDAY)).created).toBe(12);
    const tally = await t.db.query<{ format: string; n: number }>(`SELECT format, count(*)::int AS n FROM calendar_slot WHERE persona_id = $1 GROUP BY format ORDER BY format`, [p.id]);
    expect(Object.fromEntries(tally.map((r) => [r.format, r.n]))).toEqual(target.formatMix);

    // A later lever override wins over the plan; a later Owner edit wins over the override.
    await t.db.query(
      `INSERT INTO profit_cadence_override (studio_id, persona_id, effective_from, posts_per_week, format_mix, purpose_mix, source, reason, created_at) VALUES ($1, $2, $3, 12, $4::jsonb, $5::jsonb, 'lever', 'moved one to static', $6)`,
      [t.studioId, p.id, '2026-10-19', json({ ...target.formatMix, activity_text: 1, static: 4 }), json({ reach: 7, trust: 4, sell: 1 }), new Date(NOW.getTime() + 1000)],
    );
    expect((await t.services.cadence.target(p.id, NEXT_MONDAY)).formatMix.static).toBe(4);
    const shown = await planInForce(t.db, p.id, NOW);
    expect(shown).toMatchObject({ source: 'lever', leverReason: 'moved one to static' });
    expect(shown!.lines.find((l) => l.format === 'static')!.reason).toMatch(/^Profit Engine: 3 → 4 a week/);
    await savePlan(t.db, { studioId: t.studioId, personaId: p.id, plan: editPlan(plan, { counts: { static: 2 } }), actor: OWNER, now: new Date(NOW.getTime() + 5000) });
    const after = await t.services.cadence.target(p.id, NEXT_MONDAY);
    expect(after.formatMix.static).toBe(2);
    expect(after.postsPerWeek).toBe(11);
    expect(validTarget(after)).toBe(true); // the override's purpose mix no longer fits 11: default proportions
  });

  it('scales a recommended plan for a winner to the winner cadence, but keeps an Owner-set plan as given', async () => {
    t = await createTestStudio({ now: () => NOW, formatPlans: createFormatPlanService, cadence: createCadencePolicy });
    const w = await makeTestPersona(t, { state: 'SCALING' });
    const rec = { ...defaultPlan(), source: 'recommended' as const };
    await savePlan(t.db, { studioId: t.studioId, personaId: w.id, plan: rec, actor: STUDIO_MANAGER, now: NOW });
    const target = await t.services.cadence.target(w.id, NEXT_MONDAY);
    expect(target.postsPerWeek).toBe(WINNER_CADENCE.postsPerWeek);
    expect(target.formatMix).toEqual(WINNER_CADENCE.formatMix);
    const owner = await makeTestPersona(t, { state: 'SCALING' });
    await savePlan(t.db, { studioId: t.studioId, personaId: owner.id, plan: editPlan(defaultPlan(), { counts: { static: 3 } }), actor: OWNER, now: NOW });
    expect((await t.services.cadence.target(owner.id, NEXT_MONDAY)).postsPerWeek).toBe(11);
  });

  it('a winner keeps its scaled feed cadence through a Stories lever move and an Owner edit (the plan in force is what the calendar books)', async () => {
    t = await createTestStudio({ now: () => NOW, formatPlans: createFormatPlanService, cadence: createCadencePolicy });
    const w = await makeTestPersona(t, { state: 'SCALING' });
    await savePlan(t.db, { studioId: t.studioId, personaId: w.id, plan: { ...defaultPlan(), source: 'recommended' }, actor: STUDIO_MANAGER, now: daysAgo(20) });
    expect((await t.services.cadence.target(w.id, NEXT_MONDAY)).postsPerWeek).toBe(WINNER_CADENCE.postsPerWeek);
    // The persona page shows what the calendar plans.
    const shown = await planInForce(t.db, w.id, NOW);
    expect(shown!.postsPerWeek).toBe(WINNER_CADENCE.postsPerWeek);
    expect(planMixOf(shown!)).toEqual(Object.fromEntries(Object.entries(WINNER_CADENCE.formatMix).filter(([, n]) => n > 0)));
    expect((await planInForce(t.db, w.id, NOW, { scaleForWinner: false }))!.postsPerWeek).toBe(10);

    // Two weeks of Stories where viewers stay and reply: the lever adds a frame a day, the feed is untouched.
    const { id: studioId } = await t.db.one<{ id: string }>('SELECT studio_id AS id FROM persona WHERE id = $1', [w.id]);
    for (let i = 0; i < 15; i++) {
      const date = new Date(NOW.getTime() - (1 + Math.floor(i / 5)) * 86_400_000);
      const f = await t.db.one<{ id: string }>(
        `INSERT INTO story_frame (studio_id, persona_id, story_date, seq, kind, status, planned_at) VALUES ($1, $2, $3::date, $4, 'world', 'published', $5) RETURNING id`,
        [studioId, w.id, date.toISOString().slice(0, 10), (i % 5) + 1, date],
      );
      const sp = await t.db.one<{ id: string }>(`INSERT INTO story_post (story_frame_id, persona_id, platform, status, external_id, published_at) VALUES ($1, $2, 'instagram', 'published', $3, $4) RETURNING id`, [f.id, w.id, `s${i}`, date]);
      await t.db.query(
        `INSERT INTO story_metric (story_post_id, story_frame_id, persona_id, platform, captured_on, reach, replies, taps_forward, taps_back, exits) VALUES ($1, $2, $3, 'instagram', $4::date, 500, 10, 40, 5, 20)`,
        [sp.id, f.id, w.id, date.toISOString().slice(0, 10)],
      );
    }
    const { tuneStories } = await import('../src');
    expect(await tuneStories(t.services, w.id)).toMatchObject({ from: 4, to: 5 });
    const after = await t.services.cadence.target(w.id, NEXT_MONDAY);
    expect(after.postsPerWeek).toBe(WINNER_CADENCE.postsPerWeek);
    expect(after.formatMix).toEqual(WINNER_CADENCE.formatMix);
    expect((await planInForce(t.db, w.id, NOW))!.stories.perDay).toBe(5);

    // An Owner edit starts from the plan in force (17), so switching one format on never cuts the feed to 11.
    const inForce = (await planInForce(t.db, w.id, NOW))!;
    await savePlan(t.db, { studioId: t.studioId, personaId: w.id, plan: editPlan(inForce, { enabled: { meme: true } }), actor: OWNER, now: new Date(NOW.getTime() + 1000) });
    expect((await t.services.cadence.target(w.id, NEXT_MONDAY)).postsPerWeek).toBe(WINNER_CADENCE.postsPerWeek + 1);
  });

  it('re-tunes the plan weekly from per-format results, within bounds: never switches a format on, keeps every on format ≥ 1', async () => {
    t = await createTestStudio({ now: () => NOW, formatPlans: createFormatPlanService, cadence: createCadencePolicy });
    const p = await makeTestPersona(t, { name: 'Tuned' });
    const plan = editPlan(defaultPlan(), { enabled: { text_note: true } }); // 11 a week, text notes on (1)
    await savePlan(t.db, { studioId: t.studioId, personaId: p.id, plan, actor: OWNER, now: daysAgo(30) });
    // Carousels sell and get saved; text notes do nothing.
    for (let i = 0; i < 4; i++) {
      const car = await addPost(t, p.id, 'carousel', daysAgo(3 + i * 4), { views: 3000, saves: 120, shares: 40, follows: 30, link_clicks: 25 });
      await t.db.query(`INSERT INTO orders (persona_id, source_post_id, amount_cents, fee_cents, status, ordered_at) VALUES ($1, $2, 4000, 200, 'paid', $3)`, [p.id, car, daysAgo(2 + i * 4)]);
      await addPost(t, p.id, 'text_note', daysAgo(4 + i * 4), { views: 200, saves: 1, shares: 0, follows: 0, link_clicks: 0 });
      await addPost(t, p.id, 'activity_text', daysAgo(5 + i * 4), { views: 600, saves: 3, shares: 1, follows: 1, link_clicks: 0 });
    }
    const inp = await leverInputs(t.db, t.studioId, NOW);
    const fmt = await planFormatMix(inp, p.id, { ignoreCooldown: true });
    expect(fmt).not.toBeNull();
    const before = fmt!.before.formatMix as Record<string, number>;
    const after = fmt!.after.formatMix as Record<string, number>;
    expect(after.carousel).toBe(before.carousel! + 1);
    expect(sumOf(after)).toBe(11);
    // text_note scores worst but is on in the plan at 1: it keeps it, so the slot comes from activity_text; meme stays off.
    expect(after.text_note).toBe(1);
    expect(after.activity_text).toBe(before.activity_text! - 1);
    expect(after.meme).toBeUndefined();
    for (const f of CORE_FORMATS) expect(after[f]).toBeGreaterThanOrEqual(1);
    expect(fmt!.rationale).toMatch(/Carousel/);
    expect((fmt!.baseline as { best: { format: string } }).best.format).toBe('carousel');

    const bounds = formatBounds(11, { on: ['text_note'], base: planMixOf(plan) });
    expect(bounds.max.meme).toBe(0);
    expect(bounds.min.text_note).toBe(1);
    expect(bounds.max.carousel).toBe(planMixOf(plan).carousel! + 3);

    // Applied, it is the plan in force from next Monday and shows as a Profit Engine move.
    await runLevers(t.db, t.studioId, NOW);
    const shown = await planInForce(t.db, p.id, NOW);
    expect(shown?.source).toBe('lever');
    expect(shown!.lines.find((l) => l.format === 'carousel')!.perWeek).toBeGreaterThan(planMixOf(plan).carousel!);
    const target = await t.services.cadence.target(p.id, NEXT_MONDAY);
    expect(validTarget(target)).toBe(true);
  });
});

describe('formats.* tools', () => {
  it('lets the Persona Manager edit its own plan in chat, and refuses an untrusted run without the Owner asking', async () => {
    t = await createTestStudio({ tools, now: () => NOW, formatPlans: createFormatPlanService });
    const p = await makeTestPersona(t);
    const pm = { services: t.services, studioId: t.studioId, personaId: p.id, caller: 'persona-manager' as const, actor: { type: 'agent' as const, id: 'persona-manager' } };
    const out = (await t.services.tools.invoke(pm, 'formats.plan_edit', { persona_id: p.id, counts: { static: 3 }, enabled: { meme: true }, note: 'Owner asked for more stills' })) as { version: number; posts_per_week: number };
    expect(out).toMatchObject({ version: 1, posts_per_week: 12 });
    const got = (await t.services.tools.invoke(pm, 'formats.plan_get', { persona_id: p.id })) as { plan: { postsPerWeek: number } };
    expect(got.plan.postsPerWeek).toBe(12);
    await expect(t.services.tools.invoke(pm, 'formats.plan_edit', { persona_id: p.id, counts: { talking: 0 } })).rejects.toThrow(/core format/);

    // A run over scraped / third-party text can't edit the plan unless the Owner's own message asks for it.
    await expect(t.services.tools.invoke({ ...pm, trust: { untrusted: true, ownerText: null } }, 'formats.plan_edit', { persona_id: p.id, counts: { static: 4 } })).rejects.toThrow();
    const ok = await t.services.tools.invoke({ ...pm, trust: { untrusted: true, ownerText: 'Please change the format plan to 4 static posts' } }, 'formats.plan_edit', { persona_id: p.id, counts: { static: 4 } });
    expect(ok).toMatchObject({ version: 2 });

    // Another persona's manager can't touch it; the Owner-only approve tool refuses agents.
    const other = await makeTestPersona(t);
    await expect(t.services.tools.invoke({ ...pm, personaId: other.id }, 'formats.plan_edit', { persona_id: p.id, counts: { static: 2 } })).rejects.toThrow();
    await expect(t.services.tools.invoke(pm, 'stories.approve', { persona_id: p.id, frame_id: '00000000-0000-4000-8000-000000000000' })).rejects.toThrow();
    // The Studio Manager can apply a recommendation to a persona launched before Format Plans.
    const sm = { services: t.services, studioId: t.studioId, personaId: null, caller: 'studio-manager' as const, actor: STUDIO_MANAGER };
    const rec = (await t.services.tools.invoke(sm, 'formats.recommend', { persona_id: other.id, apply: true })) as { applied: boolean; version: number };
    expect(rec).toMatchObject({ applied: true, version: 1 });
  });
});

async function addPost(tt: TestStudio, personaId: string, format: string, at: Date, m: { views: number; saves: number; shares: number; follows: number; link_clicks: number }): Promise<string> {
  const slot = await tt.db.one<{ id: string }>(`INSERT INTO calendar_slot (persona_id, slot_at, format, purpose, title, status) VALUES ($1, $2, $3, 'reach', $4, 'live') RETURNING id`, [personaId, at, format, `${format} post`]);
  const post = await tt.db.one<{ id: string }>(
    `INSERT INTO post (persona_id, calendar_slot_id, platform, format, caption, status, scheduled_at, published_at) VALUES ($1, $2, 'instagram', $3, 'c', 'live', $4, $4) RETURNING id`,
    [personaId, slot.id, format, at],
  );
  await tt.db.query('UPDATE calendar_slot SET post_id = $2 WHERE id = $1', [slot.id, post.id]);
  await tt.db.query(
    `INSERT INTO metric_snapshot (persona_id, post_id, platform, captured_on, views, saves, shares, follows, link_clicks) VALUES ($1, $2, 'instagram', $3, $4, $5, $6, $7, $8)`,
    [personaId, post.id, at.toISOString().slice(0, 10), m.views, m.saves, m.shares, m.follows, m.link_clicks],
  );
  return post.id;
}
