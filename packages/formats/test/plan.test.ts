import { CADENCE_BOUNDS, DEFAULT_CADENCE, type FormatBenchmark, type FormatPlan, STORIES_PER_DAY } from '@troupe/agents';
import { CORE_FORMATS } from '@troupe/core';
import { describe, expect, it } from 'vitest';
import { dailyKinds, defaultPlan, editPlan, FORMAT_COST_USD, FormatPlanError, monthlyCostUsd, planMixOf, recommendPlan, storiesPlan, validatePlan } from '../src';

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const count = (p: FormatPlan, f: string) => p.lines.find((l) => l.format === f)?.perWeek ?? 0;
const on = (p: FormatPlan, f: string) => !!p.lines.find((l) => l.format === f)?.enabled;
const stills = (p: FormatPlan) => sum(['static', 'carousel', 'photo_dump', 'text_note', 'meme'].map((f) => count(p, f)));

function invariants(p: FormatPlan) {
  for (const f of CORE_FORMATS) expect(count(p, f), f).toBeGreaterThanOrEqual(1);
  expect(sum(p.lines.map((l) => l.perWeek))).toBe(p.postsPerWeek);
  expect(p.postsPerWeek).toBeGreaterThanOrEqual(CADENCE_BOUNDS.min);
  expect(p.postsPerWeek).toBeLessThanOrEqual(CADENCE_BOUNDS.max);
  expect(p.stories.perDay).toBeGreaterThanOrEqual(STORIES_PER_DAY.min);
  expect(p.stories.perDay).toBeLessThanOrEqual(STORIES_PER_DAY.max);
  for (const l of p.lines) {
    expect(l.reason.length, l.format).toBeGreaterThan(5);
    expect(l.costPerWeekUsd).toBeCloseTo(l.perWeek * l.costPerPostUsd, 2);
    if (!l.enabled) expect(l.perWeek).toBe(0);
  }
  for (const m of p.stories.mix) expect(m.reason.length).toBeGreaterThan(3);
  expect(p.costPerWeekUsd).toBeCloseTo(sum(p.lines.map((l) => l.costPerWeekUsd)) + p.stories.costPerWeekUsd, 2);
}

const bench = (o: Partial<FormatBenchmark> = {}): FormatBenchmark => ({
  niche: 'dating',
  sample: { accounts: 9, posts: 140 },
  formatShare: { talking: 0.1, activity_text: 0.15, static: 0.1, carousel: 0.25, meme: 0.3, text_note: 0.1 },
  formatLift: { meme: 7 },
  postsPerWeek: 11,
  storiesPerDay: 5,
  confidence: 'medium',
  updatedAt: new Date('2026-10-12T00:00:00Z'),
  ...o,
});

describe('Format Plans (FR-4.3c)', () => {
  it('turns the studio default into a plan: 2/2/1/2/2/1, half stills, 4 Stories a day, with reason and cost per line', () => {
    const p = defaultPlan();
    invariants(p);
    expect(planMixOf(p)).toEqual(DEFAULT_CADENCE.formatMix);
    expect(stills(p)).toBe(5);
    expect(p.stories.perDay).toBe(4);
    expect(p.stories.mix.map((m) => [m.kind, m.perDay])).toEqual([['world', 1], ['storyline', 1], ['reshare', 1], ['engagement', 1], ['sell', 1]]);
    expect(p.lines.find((l) => l.format === 'talking')).toMatchObject({ perWeek: 2, costPerPostUsd: 3, costPerWeekUsd: 6 });
    expect(p.lines.find((l) => l.format === 'meme')).toMatchObject({ enabled: false, perWeek: 0 });
    expect(monthlyCostUsd(p)).toBeLessThan(50); // ~$47 for a testing persona (PRD FR-4.3)
  });

  it('weighs the archetype: voice-led characters talk more, aesthetic ones post more stills and dumps, education niches carousel and note', () => {
    const base = { ladder: [], budgetUsdPerMonth: 60, benchmark: null } as const;
    const voice = recommendPlan({ ...base, niche: 'dating', archetype: 'Agony aunt who reads your texts, no-nonsense hot takes' });
    const aesthetic = recommendPlan({ ...base, niche: 'home', archetype: 'Slow living cottage baker, vintage aesthetic' });
    const edu = recommendPlan({ ...base, niche: 'personal finance', archetype: 'retired accountant, budget checklists' });
    for (const p of [voice, aesthetic, edu]) invariants(p);
    expect(count(voice, 'talking')).toBeGreaterThan(count(aesthetic, 'talking'));
    expect(stills(aesthetic)).toBeGreaterThan(stills(voice));
    expect(count(aesthetic, 'photo_dump')).toBeGreaterThanOrEqual(2);
    expect(on(edu, 'text_note')).toBe(true);
    expect(count(edu, 'carousel')).toBeGreaterThanOrEqual(2);
    expect(voice.lines.find((l) => l.format === 'talking')!.reason).toMatch(/voice-led/);
    expect(voice.reason).toMatch(/no niche benchmark yet/);
    expect(voice.source).toBe('recommended');
  });

  it('uses the Growth Radar benchmark when there is one, and the default when it is empty', () => {
    const withBench = recommendPlan({ niche: 'dating', archetype: 'a dating coach', ladder: [], budgetUsdPerMonth: 60, benchmark: bench() });
    invariants(withBench);
    expect(on(withBench, 'meme')).toBe(true); // 30% of breakout posts, 7× lift
    expect(withBench.lines.find((l) => l.format === 'meme')!.reason).toMatch(/30% of breakout posts/);
    expect(withBench.postsPerWeek).toBe(11);
    expect(withBench.stories.perDay).toBe(5);
    expect(withBench.benchmark).toMatchObject({ niche: 'dating', confidence: 'medium' });
    // A thin sample is ignored: same plan as no benchmark.
    const thin = recommendPlan({ niche: 'dating', archetype: 'a dating coach', ladder: [], budgetUsdPerMonth: 60, benchmark: bench({ sample: { accounts: 1, posts: 3 } }) });
    const none = recommendPlan({ niche: 'dating', archetype: 'a dating coach', ladder: [], budgetUsdPerMonth: 60, benchmark: null });
    expect(planMixOf(thin)).toEqual(planMixOf(none));
  });

  it('reads the product ladder (carousels and the product in hand for selling) and stays inside the budget', () => {
    const ladder = [{ rung: 'lead_magnet', priceCents: 0 }, { rung: 'entry', priceCents: 1500 }, { rung: 'core', priceCents: 4700 }];
    const rich = recommendPlan({ niche: 'dating', archetype: 'Agony aunt, opinionated', ladder, budgetUsdPerMonth: 200, benchmark: null });
    invariants(rich);
    expect(on(rich, 'product_in_hand')).toBe(true);
    expect(count(rich, 'carousel')).toBeGreaterThanOrEqual(2);
    expect(rich.lines.find((l) => l.format === 'carousel')!.reason).toMatch(/2 paid products/);

    const tight = recommendPlan({ niche: 'dating', archetype: 'Agony aunt, opinionated', ladder, budgetUsdPerMonth: 35, benchmark: null });
    invariants(tight);
    expect(monthlyCostUsd(tight)).toBeLessThanOrEqual(35);
    expect(count(tight, 'talking')).toBeLessThan(count(rich, 'talking'));
    expect(tight.reason).toMatch(/of a \$35 media budget/);
    expect(tight.lines.find((l) => l.format === 'static' || l.format === 'text_note')!.reason).toMatch(/budget/);
    // A budget no plan fits says so (raising a cap is the Owner's call), and the core formats stay.
    const broke = recommendPlan({ niche: 'dating', archetype: 'Agony aunt, opinionated', ladder, budgetUsdPerMonth: 10, benchmark: null });
    invariants(broke);
    expect(broke.reason).toMatch(/over the \$10 media budget/);
    // Deterministic.
    expect(recommendPlan({ niche: 'dating', archetype: 'Agony aunt, opinionated', ladder, budgetUsdPerMonth: 35, benchmark: null })).toEqual(tight);
  });

  it('applies Owner edits within the rules and refuses breaking ones', () => {
    const p = defaultPlan();
    const e = editPlan(p, { counts: { static: 3, talking: 1 }, enabled: { meme: true }, storiesPerDay: 5, note: 'more stills' });
    invariants(e);
    expect(e.source).toBe('owner');
    expect(count(e, 'static')).toBe(3);
    expect(count(e, 'meme')).toBe(1);
    expect(e.postsPerWeek).toBe(11);
    expect(e.stories.perDay).toBe(5);
    expect(e.lines.find((l) => l.format === 'static')!.reason).toMatch(/^Owner: Static image post 2 → 3 \(more stills\)/);
    expect(e.reason).toMatch(/Owner edit/);
    expect(editPlan(e, { enabled: { meme: false } }).lines.find((l) => l.format === 'meme')).toMatchObject({ enabled: false, perWeek: 0 });

    expect(() => editPlan(p, { counts: { talking: 0 } })).toThrow(FormatPlanError);
    expect(() => editPlan(p, { enabled: { carousel: false } })).toThrow(/core format/);
    expect(() => editPlan(p, { counts: { activity_text: 0, static: 0, photo_dump: 0 } })).toThrow(FormatPlanError);
    expect(() => editPlan(p, { counts: { static: 14 } })).toThrow(/7–21/);
    expect(() => editPlan(p, { storyMix: { world: 0 } })).toThrow(/where I am today/);
    expect(() => validatePlan({ ...p, postsPerWeek: 12 })).toThrow(/add up/);
  });

  it('plans the daily Stories mix: world, storyline, reshare, engagement, and a sell frame on sell days only (3–5)', () => {
    const four = storiesPlan(4);
    expect(dailyKinds(four, false)).toEqual(['world', 'storyline', 'reshare', 'engagement']);
    expect(dailyKinds(four, true)).toEqual(['world', 'storyline', 'reshare', 'engagement', 'sell']);
    const five = storiesPlan(5);
    expect(dailyKinds(five, false)).toHaveLength(5);
    expect(dailyKinds(five, true)).toHaveLength(5);
    expect(dailyKinds(five, true).at(-1)).toBe('sell');
    expect(dailyKinds(storiesPlan(3), true)).toEqual(['world', 'storyline', 'engagement', 'sell']);
    expect(() => storiesPlan(4, { storyline: 3 })).toThrow(/3–5/);
    expect(four.costPerWeekUsd).toBeCloseTo((4 * 7 + 1) * 0.05, 2);
    expect(FORMAT_COST_USD.static).toBeLessThan(FORMAT_COST_USD.talking);
  });

  it('moves Stories per day from the current mix (the Owner\'s mix survives) and refuses a count that disagrees with the mix', () => {
    const owner = editPlan(defaultPlan(), { storyMix: { reshare: 0, engagement: 2 } });
    expect(owner.stories.perDay).toBe(4);
    const up = editPlan(owner, { storiesPerDay: 5 }, 'lever');
    const mix = Object.fromEntries(up.stories.mix.map((m) => [m.kind, m.perDay]));
    expect(mix).toMatchObject({ world: 1, storyline: 1, reshare: 1, engagement: 2 });
    const down = editPlan(owner, { storiesPerDay: 3 }, 'lever');
    // Down: the extra storyline, then the reshare, then a second engagement frame (the storyline thread stays).
    expect(Object.fromEntries(down.stories.mix.map((m) => [m.kind, m.perDay]))).toMatchObject({ world: 1, storyline: 1, reshare: 0, engagement: 1 });
    // From the default mixes it lands on the default mixes.
    for (const [from, to] of [[3, 4], [4, 5], [5, 4], [4, 3]] as const) {
      const moved = editPlan(editPlan(defaultPlan(), { storiesPerDay: from }), { storiesPerDay: to });
      expect(moved.stories.mix.map((m) => m.perDay)).toEqual(storiesPlan(to).mix.map((m) => m.perDay));
    }
    expect(() => editPlan(defaultPlan(), { storiesPerDay: 3, storyMix: { engagement: 1 } })).toThrow(/not the 3 a day/);
    expect(editPlan(defaultPlan(), { storiesPerDay: 5, storyMix: { storyline: 2 } }).stories.perDay).toBe(5);
  });

  it('keeps the paid-product carousel floor even when every format sits at 1 slot', () => {
    const ladder = [
      { rung: 'tripwire', priceCents: 900 },
      { rung: 'core', priceCents: 2900 },
    ];
    let checked = 0;
    for (const archetype of ['funny meme tech news', 'chaotic AI news comedian with money tips', 'relatable crypto market memes', 'funny tech news storyteller']) {
      for (let budget = 50; budget <= 500; budget += 25) {
        const p = recommendPlan({ niche: 'tech', archetype, ladder, budgetUsdPerMonth: budget, benchmark: null });
        invariants(p);
        expect(count(p, 'carousel'), `${archetype} @ $${budget}`).toBeGreaterThanOrEqual(2);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(40);
  });
});
