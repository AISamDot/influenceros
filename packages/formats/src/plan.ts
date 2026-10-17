import {
  CADENCE_BOUNDS,
  DEFAULT_CADENCE,
  type FormatBenchmark,
  type FormatPlan,
  type FormatPlanLine,
  OUTLIER,
  STORIES_PER_DAY,
  STORY_FRAME_KINDS,
  type StoriesPlan,
  type StoryFrameKind,
} from '@troupe/agents';
import { CORE_FORMATS, isOptionalFormat, POST_FORMATS, type PostFormat } from '@troupe/core';
import { FORMAT_COST_USD, FORMAT_LABEL, FORMAT_WHY, round2, STORY_FRAME_COST_USD, STORY_KIND_WHY, usd, WEEKS_PER_MONTH } from './catalog';

/**
 * Format Plans (PRD FR-4.3c, FR-4.3d): pure functions. A plan is weekly feed posts per format (every core format ≥ 1,
 * optional formats on or off), Stories per day and their daily mix, with a reason and a cost per week on every line.
 * The Studio Manager's recommendation weighs the archetype, the niche benchmark (Growth Radar; a default when empty),
 * the product ladder and the budget.
 */

export class FormatPlanError extends Error {
  override readonly name = 'FormatPlanError';
}

/** A mix that may carry any format. */
export type Mix = Partial<Record<PostFormat, number>>;

/** Sell days per week the Stories cost assumes (the calendar books ≥ 1 sell post a week). */
const SELL_DAYS_PER_WEEK = 1;

/**
 * Splits `total` over the formats in proportion to `weights`, keeping each core format and each optional format in
 * `on` at ≥ 1 and no format above `max` (default: half the week). Largest remainder; parts sum exactly to `total`.
 */
export function apportionPlan(weights: Mix, on: readonly PostFormat[], total: number, max = Math.ceil(total / 2)): Record<string, number> {
  const keys = POST_FORMATS.filter((f) => !isOptionalFormat(f) || on.includes(f));
  const w = (f: PostFormat) => Math.max(0, weights[f] ?? 0);
  const min = Object.fromEntries(keys.map((f) => [f, 1])) as Record<string, number>;
  const byWeight = [...keys].sort((a, b) => Number(isOptionalFormat(b)) - Number(isOptionalFormat(a)) || w(a) - w(b));
  for (const f of byWeight) if (Object.values(min).reduce((a, b) => a + b, 0) > total) min[f] = 0;
  const wsum = keys.reduce((a, f) => a + w(f), 0) || 1;
  const ideal = Object.fromEntries(keys.map((f) => [f, (w(f) / wsum) * total])) as Record<string, number>;
  const out = Object.fromEntries(keys.map((f) => [f, Math.min(max, Math.max(min[f]!, Math.floor(ideal[f]!)))])) as Record<string, number>;
  const s = () => keys.reduce((a, f) => a + out[f]!, 0);
  for (let guard = 0; s() > total && guard < 100; guard++) {
    const k = keys.filter((f) => out[f]! > min[f]!).sort((a, b) => out[b]! - ideal[b]! - (out[a]! - ideal[a]!))[0];
    if (!k) break;
    out[k] -= 1;
  }
  for (let guard = 0; s() < total && guard < 100; guard++) {
    const k = keys.filter((f) => out[f]! < max).sort((a, b) => ideal[b]! - out[b]! - (ideal[a]! - out[a]!))[0];
    if (!k) break;
    out[k] += 1;
  }
  return out;
}

/** The default daily Stories mix for `perDay` frames on a regular day; the sell frame is added on sell days (max 5). */
export function defaultStoryMix(perDay: number): Record<StoryFrameKind, number> {
  const n = Math.min(STORIES_PER_DAY.max, Math.max(STORIES_PER_DAY.min, Math.round(perDay)));
  if (n === 3) return { world: 1, storyline: 1, reshare: 0, engagement: 1, sell: 1 };
  if (n === 4) return { world: 1, storyline: 1, reshare: 1, engagement: 1, sell: 1 };
  return { world: 1, storyline: 2, reshare: 1, engagement: 1, sell: 1 };
}

/**
 * Moves a daily Stories mix to `perDay` frames from where it is (the Owner's own mix survives the Stories lever):
 * a frame is added as a reshare (when there is none), else a storyline frame; removed from the second storyline frame,
 * then the reshare, then a second engagement frame. Matches the default mixes when starting from one.
 */
export function resizeStoryMix(current: Partial<Record<StoryFrameKind, number>>, perDayIn: number): Record<StoryFrameKind, number> {
  const target = Math.min(STORIES_PER_DAY.max, Math.max(STORIES_PER_DAY.min, Math.round(perDayIn)));
  const mix = Object.fromEntries(STORY_FRAME_KINDS.map((k) => [k, Math.max(0, Math.round(current[k] ?? 0))])) as Record<StoryFrameKind, number>;
  const total = () => STORY_FRAME_KINDS.filter((k) => k !== 'sell').reduce((a, k) => a + mix[k], 0);
  for (let guard = 0; total() < target && guard < 10; guard++) {
    if (mix.reshare === 0) mix.reshare = 1;
    else mix.storyline += 1;
  }
  for (let guard = 0; total() > target && guard < 10; guard++) {
    if (mix.storyline > 1) mix.storyline -= 1;
    else if (mix.reshare > 0) mix.reshare -= 1;
    else if (mix.engagement > 1) mix.engagement -= 1;
    else if (mix.world > 1) mix.world -= 1;
    else if (mix.storyline > 0) mix.storyline -= 1;
    else break;
  }
  return mix;
}

export function storiesPlan(perDayIn: number, mixIn?: Partial<Record<StoryFrameKind, number>>, reasons: Partial<Record<StoryFrameKind, string>> = {}): StoriesPlan {
  const base = defaultStoryMix(perDayIn);
  const mix = { ...base, ...(mixIn ?? {}) } as Record<StoryFrameKind, number>;
  for (const k of STORY_FRAME_KINDS) mix[k] = Math.max(0, Math.round(mix[k] ?? 0));
  mix.sell = Math.min(1, mix.sell);
  const perDay = STORY_FRAME_KINDS.filter((k) => k !== 'sell').reduce((a, k) => a + mix[k], 0);
  if (perDay < STORIES_PER_DAY.min || perDay > STORIES_PER_DAY.max) {
    throw new FormatPlanError(`Stories: ${perDay} frames a day; keep ${STORIES_PER_DAY.min}–${STORIES_PER_DAY.max} (the sell frame comes on top on sell days, max ${STORIES_PER_DAY.max})`);
  }
  if (mix.world < 1) throw new FormatPlanError('Stories: keep the daily "where I am today" frame');
  if (mix.engagement < 1) throw new FormatPlanError('Stories: keep at least one engagement (reply-with-a-keyword) frame a day');
  const framesPerWeek = perDay * 7 + mix.sell * SELL_DAYS_PER_WEEK;
  return {
    perDay,
    mix: STORY_FRAME_KINDS.map((kind) => ({
      kind,
      perDay: mix[kind],
      reason: reasons[kind] ?? (kind === 'sell' ? `${STORY_KIND_WHY.sell}` : mix[kind] ? STORY_KIND_WHY[kind] : `off at ${perDay} a day`),
    })),
    costPerWeekUsd: round2(framesPerWeek * STORY_FRAME_COST_USD),
  };
}

/** Builds plan lines for every format in the library (optional formats that are off have perWeek 0). */
export function planLines(mix: Mix, reasons: Partial<Record<PostFormat, string>> = {}): FormatPlanLine[] {
  return POST_FORMATS.map((format) => {
    const perWeek = Math.max(0, Math.round(mix[format] ?? 0));
    const enabled = !isOptionalFormat(format) || perWeek > 0;
    const cost = FORMAT_COST_USD[format];
    return {
      format,
      perWeek: enabled ? perWeek : 0,
      enabled,
      reason: reasons[format] ?? (enabled ? FORMAT_WHY[format] : `off: ${FORMAT_WHY[format]}`),
      costPerPostUsd: cost,
      costPerWeekUsd: round2((enabled ? perWeek : 0) * cost),
    };
  });
}

export const planMixOf = (plan: Pick<FormatPlan, 'lines'>): Mix => Object.fromEntries(plan.lines.filter((l) => l.enabled && (l.perWeek > 0 || !isOptionalFormat(l.format))).map((l) => [l.format, l.perWeek]));

export const feedCostPerWeek = (lines: readonly FormatPlanLine[]): number => round2(lines.reduce((a, l) => a + l.costPerWeekUsd, 0));
export const monthlyCostUsd = (plan: Pick<FormatPlan, 'costPerWeekUsd'>): number => round2(plan.costPerWeekUsd * WEEKS_PER_MONTH);

/** Throws FormatPlanError when the plan breaks a rule (core ≥ 1, 7–21 posts a week, lines sum, Stories 3–5 a day). */
export function validatePlan(plan: FormatPlan): FormatPlan {
  const total = plan.lines.reduce((a, l) => a + (l.enabled ? l.perWeek : 0), 0);
  if (!Number.isInteger(plan.postsPerWeek) || plan.postsPerWeek < CADENCE_BOUNDS.min || plan.postsPerWeek > CADENCE_BOUNDS.max) {
    throw new FormatPlanError(`${plan.postsPerWeek} feed posts a week: keep ${CADENCE_BOUNDS.min}–${CADENCE_BOUNDS.max}`);
  }
  if (total !== plan.postsPerWeek) throw new FormatPlanError(`the lines add up to ${total}, not ${plan.postsPerWeek}`);
  for (const f of CORE_FORMATS) {
    const l = plan.lines.find((x) => x.format === f);
    if (!l || !l.enabled || l.perWeek < 1) throw new FormatPlanError(`${FORMAT_LABEL[f]} is a core format: keep at least 1 a week`);
  }
  for (const l of plan.lines) {
    if (!(POST_FORMATS as readonly string[]).includes(l.format)) throw new FormatPlanError(`unknown format ${l.format}`);
    if (!Number.isInteger(l.perWeek) || l.perWeek < 0) throw new FormatPlanError(`${FORMAT_LABEL[l.format]}: a whole number of posts`);
    if (l.enabled && isOptionalFormat(l.format) && l.perWeek < 1) throw new FormatPlanError(`${FORMAT_LABEL[l.format]} is on with 0 posts: give it a count or switch it off`);
  }
  storiesPlan(plan.stories.perDay, Object.fromEntries(plan.stories.mix.map((m) => [m.kind, m.perDay])));
  return plan;
}

/** Assembles a plan from a mix (costs and totals computed). */
export function buildPlan(q: {
  mix: Mix;
  reasons?: Partial<Record<PostFormat, string>>;
  stories: StoriesPlan;
  source: FormatPlan['source'];
  reason: string;
  benchmark?: FormatPlan['benchmark'];
}): FormatPlan {
  const lines = planLines(q.mix, q.reasons);
  const postsPerWeek = lines.reduce((a, l) => a + l.perWeek, 0);
  return validatePlan({
    postsPerWeek,
    lines,
    stories: q.stories,
    source: q.source,
    reason: q.reason,
    costPerWeekUsd: round2(feedCostPerWeek(lines) + q.stories.costPerWeekUsd),
    benchmark: q.benchmark ?? null,
  });
}

/** The studio default as a plan (FR-4.3c: 2/2/1/2/2/1, 4 Stories a day + the sell frame on sell days). */
export function defaultPlan(): FormatPlan {
  return buildPlan({ mix: { ...DEFAULT_CADENCE.formatMix }, stories: storiesPlan(4), source: 'default', reason: 'Studio default (FR-4.3c): 10 feed posts, half of them stills; 4 Stories a day plus a sell frame on sell days.' });
}

// ───────────────────────────── The Studio Manager's recommendation ─────────────────────────────

const VOICE = /\b(talk|opinion|rant|advice|advis|agony|coach|mentor|teacher|grandma|grandad|granny|nan\b|aunt|uncle|dinner lady|storytell|comedian|therapist|lawyer|judge|reads? your|straight[- ]talk|no[- ]nonsense|hot takes?|confess|gossip|matchmaker|psychic|doctor|nurse)/i;
const AESTHETIC = /\b(aesthetic|lifestyle|fashion|style|stylist|travel|cottage|homemak|interior|garden|bak|cook|food|recipe|vintage|van ?life|slow living|wellness|beauty|outfit|decor|photograph|chef|kitchen|florist|thrift)/i;
const EDUCATION = /\b(financ|wealth|money|budget|tax|invest|career|study|productiv|nutrition|fitness|how[- ]to|guide|tips|framework|checklist|educat|teach|lesson|explain|history|science|language|retire|pension|debt)/i;
const NEWSY = /\b(news|tech|\bai\b|market|crypto|econom|policy|politic|current affairs|startup)/i;
const HUMOUR = /\b(funny|meme|comedy|comedian|relatable|chaotic|sarcas|satir|petty|unhinged)/i;

export interface RecommendInput {
  readonly niche: string;
  readonly archetype: string;
  readonly ladder: ReadonlyArray<{ readonly rung: string; readonly priceCents: number }>;
  /** Monthly media budget (USD) for the persona. */
  readonly budgetUsdPerMonth: number;
  readonly benchmark: FormatBenchmark | null;
}

/**
 * The Studio Manager's Format Plan for a new persona (Persona Generator step 6). Deterministic: the same inputs give
 * the same plan, every line says why, and the plan stays inside the persona's media budget.
 */
export function recommendPlan(q: RecommendInput): FormatPlan {
  const text = `${q.archetype} ${q.niche}`;
  const w: Record<string, number> = { ...DEFAULT_CADENCE.formatMix };
  const notes: Record<string, string[]> = {};
  const note = (f: PostFormat, s: string) => (notes[f] ??= []).push(s);
  const bump = (f: PostFormat, by: number, why: string) => {
    w[f] = Math.max(isOptionalFormat(f) && by > 0 ? 0 : 0.5, (w[f] ?? 0) + by);
    note(f, why);
  };
  const traits: string[] = [];

  if (VOICE.test(text)) {
    traits.push('voice-led');
    bump('talking', 1, 'voice-led character: more talking');
    bump('voiceover', 0.5, 'voice-led: storytime voiceovers');
    bump('photo_dump', -0.5, 'fewer dumps for a voice-led character');
  }
  if (AESTHETIC.test(text)) {
    traits.push('aesthetic / lifestyle');
    bump('static', 1, 'aesthetic or lifestyle character: more stills');
    bump('photo_dump', 1, 'lifestyle: camera-roll dumps');
    bump('carousel', 0.5, 'lifestyle: carousels');
    bump('talking', -1, 'lifestyle character: less talking');
  }
  if (EDUCATION.test(text)) {
    traits.push('list / education niche');
    bump('carousel', 1, 'list or education niche: carousels save');
    bump('text_note', 1, 'education niche: notes and quote cards');
  }
  if (NEWSY.test(text)) {
    traits.push('news-driven niche');
    bump('news_greenscreen', 1, 'news-driven niche: fresh reactions');
  }
  if (HUMOUR.test(text)) {
    traits.push('humour');
    bump('meme', 1, 'humour: relatable text posts');
    bump('activity_text', 0.5, 'humour: POV loops');
  }

  // Niche benchmark (Growth Radar): which formats break out for fast-growing accounts here.
  let postsPerWeek = DEFAULT_CADENCE.postsPerWeek;
  let storiesPerDay = 4;
  const b = q.benchmark;
  const usable = !!b && b.sample.posts >= 10;
  if (b && usable) {
    const total = Object.values(w).reduce((a, x) => a + x, 0);
    for (const f of POST_FORMATS) {
      const share = b.formatShare[f] ?? 0;
      if (!share && !(w[f] ?? 0)) continue;
      if (isOptionalFormat(f) && !(w[f] ?? 0) && share < 0.12) continue;
      const before = w[f] ?? 0;
      w[f] = 0.65 * before + 0.35 * share * total;
      if (share >= 0.05) note(f, `niche benchmark: ${Math.round(share * 100)}% of breakout posts`);
      const lift = b.formatLift[f];
      if (lift !== undefined && lift >= OUTLIER.outlier) bump(f, 0.5, `breaks out at ${lift.toFixed(0)}× the creator median`);
    }
    if (b.postsPerWeek) postsPerWeek = Math.min(12, Math.max(CADENCE_BOUNDS.min, Math.round(b.postsPerWeek)));
    if (b.storiesPerDay) storiesPerDay = Math.min(STORIES_PER_DAY.max, Math.max(STORIES_PER_DAY.min, Math.round(b.storiesPerDay)));
  }

  // Product ladder: carousels sell digital products; the product in hand takes sell slots.
  const paid = q.ladder.filter((r) => r.priceCents > 0);
  const free = q.ladder.find((r) => r.priceCents === 0);
  if (paid.length) {
    if ((w.carousel ?? 0) < 2) w.carousel = 2;
    note('carousel', `${paid.length} paid product${paid.length > 1 ? 's' : ''} on the ladder: carousels preview them`);
    w.product_in_hand = Math.max(w.product_in_hand ?? 0, 1);
    note('product_in_hand', `sell slots once the ${paid[0]!.rung} product is live`);
  }
  if (free) note('carousel', 'carries the free-guide CTA');

  const on = POST_FORMATS.filter((f) => isOptionalFormat(f) && (w[f] ?? 0) >= 0.5);
  let mix = apportionPlan(w, on, postsPerWeek);
  // Floors the ladder sets: with a paid product, at least 2 carousels a week (they sell digital products best).
  const floors: Partial<Record<PostFormat, number>> = paid.length ? { carousel: 2 } : {};
  for (const [f, floor] of Object.entries(floors) as Array<[PostFormat, number]>) {
    for (let guard = 0; (mix[f] ?? 0) < floor && guard < 10; guard++) {
      // The donor is the format most over its weight (ties: the pricier one), never one the archetype asked for.
      const over = (k: string) => (mix[k] ?? 0) / Math.max(0.25, w[k] ?? 0);
      let donor = Object.keys(mix).filter((k) => k !== f && (mix[k] ?? 0) > 1).sort((a, b2) => over(b2) - over(a) || FORMAT_COST_USD[b2 as PostFormat] - FORMAT_COST_USD[a as PostFormat])[0];
      if (!donor) {
        // Every line is at 1: switch off the lowest-weight optional format (never a core one, never the product in
        // hand the ladder just asked for) so the floor still fits the week.
        donor = Object.keys(mix)
          .filter((k) => k !== f && k !== 'product_in_hand' && isOptionalFormat(k as PostFormat) && (mix[k] ?? 0) === 1)
          .sort((a, b2) => (w[a] ?? 0) - (w[b2] ?? 0) || FORMAT_COST_USD[b2 as PostFormat] - FORMAT_COST_USD[a as PostFormat])[0];
        if (donor) note(donor as PostFormat, `off this week: its slot goes to the ${FORMAT_LABEL[f].toLowerCase()} floor`);
      }
      if (!donor) break;
      mix = { ...mix, [donor]: mix[donor]! - 1, [f]: (mix[f] ?? 0) + 1 };
      if (mix[donor] === 0 && isOptionalFormat(donor as PostFormat)) delete mix[donor];
    }
  }

  // Budget: swap the most expensive posts for stills until the month fits.
  const stories = storiesPlan(storiesPerDay, undefined, b?.storiesPerDay ? { world: `${STORY_KIND_WHY.world}; the niche posts ~${b.storiesPerDay} frames a day` } : {});
  const monthly = (m: Record<string, number>) => (Object.entries(m).reduce((a, [f, n]) => a + n * FORMAT_COST_USD[f as PostFormat], 0) + stories.costPerWeekUsd) * WEEKS_PER_MONTH;
  const swaps: string[] = [];
  for (let guard = 0; monthly(mix) > q.budgetUsdPerMonth && guard < 30; guard++) {
    const from = [...Object.keys(mix)]
      .filter((f) => (mix[f] ?? 0) > 1 || (isOptionalFormat(f) && (mix[f] ?? 0) > 0 && f !== 'photo_dump'))
      .sort((a, b2) => FORMAT_COST_USD[b2 as PostFormat] - FORMAT_COST_USD[a as PostFormat])[0] as PostFormat | undefined;
    const to: PostFormat = mix.text_note ? 'text_note' : 'static';
    if (!from || FORMAT_COST_USD[from] <= FORMAT_COST_USD[to]) break;
    mix = { ...mix, [from]: mix[from]! - 1, [to]: (mix[to] ?? 0) + 1 };
    if (mix[from] === 0) delete mix[from];
    swaps.push(`${FORMAT_LABEL[from]} → ${FORMAT_LABEL[to]}`);
    note(to, `budget: takes a ${FORMAT_LABEL[from].toLowerCase()} slot`);
  }
  if (swaps.length) note('talking', `budget cap ${usd(q.budgetUsdPerMonth)}/mo: ${swaps.length} expensive slot${swaps.length > 1 ? 's' : ''} moved to stills`);

  const reasons = Object.fromEntries(POST_FORMATS.map((f) => [f, [FORMAT_WHY[f], ...(notes[f] ?? [])].join('; ')])) as Record<PostFormat, string>;
  const stills = (mix.static ?? 0) + (mix.carousel ?? 0) + (mix.photo_dump ?? 0) + (mix.text_note ?? 0) + (mix.meme ?? 0);
  const plan0 = buildPlan({
    mix,
    reasons,
    stories,
    source: 'recommended',
    reason: '',
    benchmark: b ? { niche: b.niche, confidence: b.confidence, updatedAt: new Date(b.updatedAt).toISOString() } : null,
  });
  const reason = [
    `Studio Manager: ${plan0.postsPerWeek} feed posts a week, ${stills} of them stills or written posts`,
    traits.length ? `the concept reads ${traits.join(', ')}` : 'no strong archetype signal, so the studio default shape',
    usable ? `niche benchmark from the Growth Radar (${b!.confidence} confidence, ${b!.sample.accounts} accounts)` : 'no niche benchmark yet (the Growth Radar fills it), so the studio default weights',
    paid.length ? `${paid.length} paid product${paid.length > 1 ? 's' : ''} on the ladder` : 'no paid product yet',
    `${stories.perDay} Stories a day (+1 sell frame on sell days)`,
    monthlyCostUsd(plan0) <= q.budgetUsdPerMonth
      ? `~${usd(monthlyCostUsd(plan0))}/mo of a ${usd(q.budgetUsdPerMonth)} media budget`
      : `~${usd(monthlyCostUsd(plan0))}/mo: over the ${usd(q.budgetUsdPerMonth)} media budget even at the leanest mix (the Owner decides: raise the cap or cut posts)`,
  ].join('; ');
  return { ...plan0, reason: `${reason}.` };
}

// ───────────────────────────── Edits (Owner: persona page, generator, chat) ─────────────────────────────

export interface PlanPatch {
  /** New weekly counts per format (0 switches an optional format off). */
  readonly counts?: Partial<Record<PostFormat, number>>;
  /** Switch optional formats on (1 a week unless a count is given) or off. */
  readonly enabled?: Partial<Record<PostFormat, boolean>>;
  readonly storiesPerDay?: number;
  readonly storyMix?: Partial<Record<StoryFrameKind, number>>;
  readonly note?: string;
}

/** Applies an edit. The total follows the lines (7–21); every rule is checked; lines the edit touches say so. */
export function editPlan(plan: FormatPlan, patch: PlanPatch, source: 'owner' | 'lever' = 'owner'): FormatPlan {
  const mix: Record<string, number> = Object.fromEntries(plan.lines.map((l) => [l.format, l.enabled ? l.perWeek : 0]));
  const reasons: Record<string, string> = Object.fromEntries(plan.lines.map((l) => [l.format, l.reason]));
  const changed: string[] = [];
  for (const [f, on] of Object.entries(patch.enabled ?? {}) as Array<[PostFormat, boolean]>) {
    if (!isOptionalFormat(f)) {
      if (on === false) throw new FormatPlanError(`${FORMAT_LABEL[f]} is a core format and can't be switched off`);
      continue;
    }
    if (on && !mix[f]) mix[f] = 1;
    if (!on) mix[f] = 0;
    changed.push(`${FORMAT_LABEL[f]} ${on ? 'on' : 'off'}`);
  }
  for (const [f, n] of Object.entries(patch.counts ?? {}) as Array<[PostFormat, number]>) {
    if (!(POST_FORMATS as readonly string[]).includes(f)) throw new FormatPlanError(`unknown format ${f}`);
    const v = Math.round(Number(n));
    if (!Number.isFinite(v) || v < 0 || v > CADENCE_BOUNDS.max) throw new FormatPlanError(`${FORMAT_LABEL[f]}: 0–${CADENCE_BOUNDS.max} a week`);
    if ((mix[f] ?? 0) !== v) changed.push(`${FORMAT_LABEL[f]} ${mix[f] ?? 0} → ${v}`);
    mix[f] = v;
  }
  const label = source === 'owner' ? 'Owner' : 'Profit Engine';
  for (const c of changed) {
    const f = POST_FORMATS.find((x) => c.startsWith(FORMAT_LABEL[x]));
    if (f) reasons[f] = `${label}: ${c}${patch.note ? ` (${patch.note})` : ''}; ${FORMAT_WHY[f]}`;
  }
  let stories = plan.stories;
  if (patch.storiesPerDay !== undefined || patch.storyMix) {
    const current = Object.fromEntries(plan.stories.mix.map((m) => [m.kind, m.perDay])) as Record<StoryFrameKind, number>;
    const keep = Object.fromEntries(plan.stories.mix.map((m) => [m.kind, m.reason])) as Partial<Record<StoryFrameKind, string>>;
    if (patch.storyMix) {
      stories = storiesPlan(plan.stories.perDay, { ...current, ...patch.storyMix });
      if (patch.storiesPerDay !== undefined && Math.round(patch.storiesPerDay) !== stories.perDay) {
        throw new FormatPlanError(`Stories: the daily mix adds up to ${stories.perDay} frames, not the ${Math.round(patch.storiesPerDay)} a day asked for`);
      }
    } else {
      const mix = resizeStoryMix(current, patch.storiesPerDay!);
      const reasons = Object.fromEntries(STORY_FRAME_KINDS.filter((k) => mix[k] === current[k] && mix[k] > 0 && keep[k]).map((k) => [k, keep[k]!]));
      stories = storiesPlan(patch.storiesPerDay!, mix, reasons);
    }
    changed.push(`Stories ${plan.stories.perDay} → ${stories.perDay} a day`);
  }
  const next = buildPlan({
    mix: Object.fromEntries(Object.entries(mix).filter(([f, n]) => n > 0 || !isOptionalFormat(f))) as Mix,
    reasons: reasons as Partial<Record<PostFormat, string>>,
    stories,
    source,
    reason: changed.length ? `${label} edit: ${changed.join(', ')}${patch.note ? `. ${patch.note}` : ''}.` : plan.reason,
    benchmark: plan.benchmark,
  });
  return next;
}

/** Parses a FormatPlan from untyped JSON (draft state, the database) and validates it; null when absent. */
export function parsePlan(v: unknown): FormatPlan | null {
  if (!v || typeof v !== 'object') return null;
  const p = v as FormatPlan;
  if (!Array.isArray(p.lines) || !p.stories || !Array.isArray(p.stories.mix)) return null;
  return p;
}
