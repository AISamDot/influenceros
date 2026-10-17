import { CADENCE_BOUNDS, type CadenceTarget, DEFAULT_CADENCE, type SlotBeat, type StudioServices, WINNER_CADENCE, WINNER_STATES } from '@troupe/agents';
import { CORE_FORMATS, isOptionalFormat, type PersonaState, POST_FORMATS, type PostFormat, type PostPurpose, PUBLISHING_STATES, thumbnailUri } from '@troupe/core';
import { json } from '@troupe/db';
import { loadPersonaContext, type PersonaContext } from './persona';
import { sellQueue, type SellItem } from './monetization';
import { asRecord, asString, DAY_MS, hashInt, isoDate, lowerFirst, mondayUtc, safeTimeZone, similarity, upperFirst, zonedToUtc } from './util';

/**
 * Weekly calendar per persona (FR-4.1, FR-4.3, FR-4.3a): the cadence target's format and purpose mix spread over
 * posting windows in the persona's time zone, a CTA keyword on every slot, sell slots booked in Monetization Agent
 * order, fresh News Desk reaction ideas first, and titles from the calendar-planner agent for the rest.
 * Winners (SCALING / BRAND) scale to 2–3 posts a day.
 */

/** The core formats: every weekly mix covers each of them at least once (the core-format invariant). */
export const FORMATS: readonly PostFormat[] = CORE_FORMATS;
export const PURPOSES: readonly PostPurpose[] = ['reach', 'trust', 'sell'];

export { WINNER_CADENCE, WINNER_STATES };

/**
 * The target the calendar plans to. A lever or Owner target from the CadencePolicy is taken as given; the plain
 * default is raised to the winner cadence for SCALING / BRAND personas. (The Profit Engine's policy already returns
 * WINNER_CADENCE for winners, so this only matters with the default policy.)
 */
export function effectiveCadence(target: CadenceTarget, state: PersonaState): CadenceTarget {
  if (target.source === 'default' && target.postsPerWeek === DEFAULT_CADENCE.postsPerWeek && WINNER_STATES.includes(state)) return WINNER_CADENCE;
  return target;
}

/** Spreads `total` over keys in proportion to `weights` (largest remainder), so the parts sum exactly to total. */
function apportion<K extends string>(weights: Readonly<Record<K, number>>, keys: readonly K[], total: number): Record<K, number> {
  const sum = keys.reduce((a, k) => a + Math.max(0, weights[k] ?? 0), 0) || 1;
  const raw = keys.map((k) => ({ k, v: (Math.max(0, weights[k] ?? 0) / sum) * total }));
  const out = Object.fromEntries(raw.map((r) => [r.k, Math.floor(r.v)])) as Record<K, number>;
  let left = total - raw.reduce((a, r) => a + Math.floor(r.v), 0);
  for (const r of [...raw].sort((a, b) => b.v - Math.floor(b.v) - (a.v - Math.floor(a.v)))) {
    if (left <= 0) break;
    out[r.k] += 1;
    left -= 1;
  }
  return out;
}

/**
 * (IOS-5, stream L) The formats a mix plans: every core format, plus each optional format the persona's Format Plan
 * has on (count > 0), in POST_FORMATS order.
 */
export function mixFormats(mix: Readonly<Partial<Record<PostFormat, number>>>): PostFormat[] {
  return POST_FORMATS.filter((f) => !isOptionalFormat(f) || (mix[f] ?? 0) > 0);
}

/**
 * Spreads `total` posts over the mix's formats in proportion to its counts, keeping the core-format invariant (each core
 * format ≥ 1) and at least one post for every optional format that is on. When the week is too small for every format
 * that is on, the lightest optional formats drop out first. Parts always sum to `total`.
 */
export function apportionFormats(mix: Readonly<Partial<Record<PostFormat, number>>>, total: number): Record<string, number> {
  const keys = mixFormats(mix);
  const w = (f: PostFormat) => Math.max(0, mix[f] ?? 0);
  const min = Object.fromEntries(keys.map((f) => [f, 1])) as Record<string, number>;
  // Too small a week: drop optional minimums (lightest first), then core ones (only for weeks under 5 posts).
  const byWeight = [...keys].sort((a, b) => Number(isOptionalFormat(b)) - Number(isOptionalFormat(a)) || w(a) - w(b));
  for (const f of byWeight) if (Object.values(min).reduce((a, b) => a + b, 0) > total) min[f] = 0;
  const wsum = keys.reduce((a, f) => a + w(f), 0);
  const ideal = Object.fromEntries(keys.map((f) => [f, wsum > 0 ? (w(f) / wsum) * total : total / keys.length])) as Record<string, number>;
  const out = Object.fromEntries(keys.map((f) => [f, Math.max(min[f]!, Math.floor(ideal[f]!))])) as Record<string, number>;
  const sumOut = () => keys.reduce((a, f) => a + out[f]!, 0);
  while (sumOut() > total) {
    const k = keys.filter((f) => out[f]! > min[f]!).sort((a, b) => out[b]! - ideal[b]! - (out[a]! - ideal[a]!))[0];
    if (!k) break;
    out[k] -= 1;
  }
  while (sumOut() < total) {
    const k = [...keys].sort((a, b) => ideal[b]! - out[b]! - (ideal[a]! - out[a]!))[0]!;
    out[k] += 1;
  }
  for (const f of keys) if (out[f] === 0 && isOptionalFormat(f)) delete out[f];
  return out;
}

/** Clamps to CADENCE_BOUNDS (or `cap`, e.g. the windows left this week) and makes both mixes sum to postsPerWeek. */
export function normaliseCadence(t: CadenceTarget, cap: number = CADENCE_BOUNDS.max): CadenceTarget {
  const n = Math.max(0, Math.min(cap, Math.max(CADENCE_BOUNDS.min, Math.round(t.postsPerWeek)), CADENCE_BOUNDS.max));
  // (IOS-5) Core formats plus the optional formats the persona's Format Plan has on.
  const formatMix = apportionFormats(t.formatMix, n) as CadenceTarget['formatMix'];
  const purposeMix = apportion(t.purposeMix, PURPOSES, n);
  // Every post has a CTA, and every week sells at least once.
  if (n > 0 && purposeMix.sell === 0) {
    purposeMix.sell = 1;
    if (purposeMix.reach > purposeMix.trust) purposeMix.reach -= 1;
    else purposeMix.trust -= 1;
  }
  return { ...t, postsPerWeek: n, formatMix, purposeMix };
}

/**
 * Which format a purpose takes first (IOS-5: the optional formats slot in where they work best): sell → walkthroughs and
 * the product in hand, trust → teaching formats (carousels, notes, facecam explainers), reach → scroll-stoppers (loops,
 * memes, dumps, reactions).
 */
export const PREFER: Readonly<Record<PostPurpose, readonly PostFormat[]>> = {
  sell: ['product_in_hand', 'talking', 'carousel', 'facecam_screen', 'voiceover', 'static', 'text_note', 'activity_text', 'photo_dump', 'reply_comment', 'news_greenscreen', 'meme', 'trend_reenactment'],
  trust: ['carousel', 'voiceover', 'facecam_screen', 'text_note', 'reply_comment', 'talking', 'static', 'photo_dump', 'news_greenscreen', 'activity_text', 'meme', 'product_in_hand', 'trend_reenactment'],
  reach: ['activity_text', 'meme', 'photo_dump', 'trend_reenactment', 'news_greenscreen', 'reply_comment', 'talking', 'static', 'text_note', 'voiceover', 'carousel', 'facecam_screen', 'product_in_hand'],
};

/** Pairs each post's format with a purpose: sell → walkthrough-friendly formats, trust → teach, reach → scroll-stoppers. */
export function assignMix(t: CadenceTarget): Array<{ format: PostFormat; purpose: PostPurpose }> {
  const left = { ...t.formatMix } as Record<PostFormat, number>;
  const out: Array<{ format: PostFormat; purpose: PostPurpose }> = [];
  for (const purpose of ['sell', 'trust', 'reach'] as const) {
    for (let i = 0; i < t.purposeMix[purpose]; i++) {
      const format = PREFER[purpose].find((f) => (left[f] ?? 0) > 0) ?? POST_FORMATS.find((f) => (left[f] ?? 0) > 0);
      if (!format) break;
      left[format] -= 1;
      out.push({ format, purpose });
    }
  }
  return out;
}

export type PostingWindow = 'morning' | 'midday' | 'evening';
/** Local posting windows (persona time zone). Each slot gets a stable jitter so personas never post in lockstep. */
export const WINDOWS: Readonly<Record<PostingWindow, { h: number; m: number }>> = {
  morning: { h: 7, m: 30 },
  midday: { h: 12, m: 15 },
  evening: { h: 19, m: 0 },
};
/** Days that get the extra posts first: Tue, Thu, Wed, Mon, Fri, Sun, Sat (0 = Monday). */
const DAY_PREF = [1, 3, 2, 0, 4, 6, 5];
const WINDOW_SETS: Record<number, PostingWindow[]> = { 1: ['evening'], 2: ['midday', 'evening'], 3: ['morning', 'midday', 'evening'] };

export interface PostingTime {
  readonly at: Date;
  readonly window: PostingWindow;
  /** 0 = Monday. */
  readonly day: number;
}

/**
 * `n` posting times in the week starting `weekStart` (Monday 00:00 UTC), one per day first and then a second and
 * third on the strongest days (max 3 a day). Times are local to `timeZone`; windows less than 2 h away are skipped.
 */
export function postingTimes(weekStart: Date, n: number, timeZone: string, opts: { now?: Date; seed?: string } = {}): PostingTime[] {
  const tz = safeTimeZone(timeZone);
  const minAt = (opts.now ?? new Date(0)).getTime() + 2 * 3_600_000;
  const at = (day: number, w: PostingWindow) => {
    const d = new Date(weekStart.getTime() + day * DAY_MS);
    const jitter = hashInt(`${opts.seed ?? ''}:${isoDate(d)}:${w}`) % 36;
    return zonedToUtc(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), WINDOWS[w].h, WINDOWS[w].m + jitter, tz);
  };
  const available = Array.from({ length: 7 }, (_, day) => (['evening', 'midday', 'morning'] as const).filter((w) => at(day, w).getTime() >= minAt));
  const counts = new Array<number>(7).fill(0);
  let left = n;
  for (let round = 0; round < 3 && left > 0; round++) {
    for (const d of DAY_PREF) {
      if (left > 0 && counts[d]! < available[d]!.length) {
        counts[d]! += 1;
        left -= 1;
      }
    }
  }
  const out: PostingTime[] = [];
  for (let day = 0; day < 7; day++) {
    const c = counts[day]!;
    if (!c) continue;
    const avail = available[day]!;
    const wanted = WINDOW_SETS[c]!.filter((w) => avail.includes(w));
    const windows = [...wanted, ...avail.filter((w) => !wanted.includes(w))].slice(0, c);
    for (const w of windows) out.push({ at: at(day, w), window: w, day });
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** Orders the mix over the times: sells on evenings spread across the week, then no two same formats back to back. */
export function scheduleMix<T extends { format: PostFormat; purpose: PostPurpose }>(items: readonly T[], times: readonly PostingTime[]): Array<T & PostingTime> {
  const n = Math.min(items.length, times.length);
  const slots: Array<(T & PostingTime) | null> = new Array(n).fill(null);
  const sells = items.filter((i) => i.purpose === 'sell').slice(0, n);
  const rest = items.filter((i) => i.purpose !== 'sell');
  const evenings = times.slice(0, n).map((t, i) => ({ t, i })).filter((x) => x.t.window === 'evening');
  const pool = evenings.length >= sells.length ? evenings : times.slice(0, n).map((t, i) => ({ t, i }));
  sells.forEach((s, j) => {
    let k = Math.min(pool.length - 1, Math.floor(((j + 1) * pool.length) / (sells.length + 1)));
    while (slots[pool[k]!.i]) k = (k + 1) % pool.length;
    slots[pool[k]!.i] = { ...s, ...pool[k]!.t };
  });
  const queue = [...rest];
  for (let i = 0; i < n; i++) {
    if (slots[i]) continue;
    const prev = slots[i - 1]?.format;
    const idx = Math.max(0, queue.findIndex((q) => q.format !== prev));
    const [item] = queue.splice(idx, 1);
    if (item) slots[i] = { ...item, ...times[i]! };
  }
  return slots.filter((s): s is T & PostingTime => s !== null);
}

// ─── Titles: News Desk reaction ideas, new ideas in the persona's queue, then the calendar-planner agent ───

interface SlotPlan {
  format: PostFormat;
  purpose: PostPurpose;
  at: Date;
  window: PostingWindow;
  pillar: string | null;
  title: string | null;
  ideaId: string | null;
  ctaKeyword: string;
  ctaDelivers: string;
  productId: string | null;
  sell?: SellItem;
  /** (IOS-5) The storyline beat stream J's WorldService assigned to this slot. */
  story?: SlotBeat;
}

const PILLAR_FOR_SELL = 'Products';

export function choosePillars(ctx: Pick<PersonaContext, 'pillars'>, slots: ReadonlyArray<{ format: PostFormat; purpose: PostPurpose }>): Array<string | null> {
  const used = new Map<string, number>();
  return slots.map((s) => {
    if (s.purpose === 'sell') return PILLAR_FOR_SELL;
    const fits = ctx.pillars.filter((p) => !p.formats.length || p.formats.includes(s.format));
    const pool = fits.length ? fits : ctx.pillars;
    if (!pool.length) return null;
    const best = [...pool].sort((a, b) => (used.get(a.name) ?? 0) - (used.get(b.name) ?? 0))[0]!;
    used.set(best.name, (used.get(best.name) ?? 0) + 1);
    return best.name;
  });
}

/** Deterministic titles for fake mode: pillar examples, frameworks and series, never repeating recent titles. */
export function fakeTitles(ctx: PersonaContext, slots: ReadonlyArray<{ format: PostFormat; purpose: PostPurpose; pillar: string | null }>, recent: readonly string[]): string[] {
  const taken = [...recent];
  const fresh = (t: string) => !taken.some((r) => similarity(r, t) >= 0.75);
  return slots.map((s, i) => {
    const pillar = ctx.pillars.find((p) => p.name === s.pillar);
    const examples = pillar?.examples.length ? pillar.examples : [`${s.pillar ?? ctx.persona.niche} in 30 seconds`];
    const fw = ctx.frameworks.map((f) => f.name);
    const base = examples[i % examples.length]!;
    const candidates = [
      ...examples.map((e) =>
        s.format === 'activity_text'
          ? `POV: ${lowerFirst(e)}`
          : s.format === 'voiceover'
            ? `Storytime: ${lowerFirst(e)}`
            : s.format === 'carousel'
              ? `${upperFirst(e)}: the checklist`
              : s.format === 'photo_dump'
                ? `Photo dump: ${lowerFirst(e)}`
                : s.format === 'text_note'
                  ? `A note on ${lowerFirst(e)}`
                  : s.format === 'meme'
                    ? `Me vs ${lowerFirst(e)}`
                    : s.purpose === 'trust'
                      ? `How to: ${lowerFirst(e)}`
                      : upperFirst(e),
      ),
      ...fw.map((f) => `${f}, explained in 30 seconds`),
      ...examples.map((e) => `${upperFirst(e)} (the honest version)`),
      `${upperFirst(base)}: what nobody mentions`,
      `${upperFirst(base)}: three quick wins`,
    ];
    const pickT = candidates.find(fresh) ?? `${upperFirst(base)} #${i + 1}`;
    taken.push(pickT);
    return pickT;
  });
}

const TITLES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ideas'],
  properties: {
    ideas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['slot', 'title', 'pillar'],
        properties: { slot: { type: 'integer' }, title: { type: 'string' }, pillar: { type: 'string' } },
      },
    },
  },
} as const;

function parseTitles(v: unknown): { ideas: Array<{ slot: number; title: string; pillar: string }> } {
  const ideas = (v as { ideas?: unknown })?.ideas;
  if (!Array.isArray(ideas)) throw new Error('expected { ideas: [...] }');
  return {
    ideas: ideas
      .map((x) => asRecord(x))
      .filter((x) => Number.isInteger(x.slot) && asString(x.title).trim())
      .map((x) => ({ slot: Number(x.slot), title: asString(x.title).trim().slice(0, 140), pillar: asString(x.pillar).trim() })),
  };
}

/**
 * Books sell slots in queue order: each item takes the free sell slot nearest its date (launch beats), undated items
 * take the earliest free one. With more slots than items the last item (the lead magnet) repeats.
 */
export function bookSellSlots<S extends { at: Date }>(slots: readonly S[], queue: readonly SellItem[]): Array<[S, SellItem]> {
  const free = [...slots];
  const out: Array<[S, SellItem]> = [];
  for (const item of queue) {
    if (!free.length) break;
    let k = 0;
    if (item.date) {
      const target = new Date(`${item.date}T12:00:00Z`).getTime();
      k = free.reduce((best, s, i) => (Math.abs(s.at.getTime() - target) < Math.abs(free[best]!.at.getTime() - target) ? i : best), 0);
    }
    out.push([free.splice(k, 1)[0]!, item]);
  }
  const last = queue.at(-1);
  if (last) for (const s of free) out.push([s, last]);
  return out;
}

/**
 * Week membership for calendar slots, with params $2 = week_start (date), $3/$4 = the week's UTC range. week_start
 * decides: a west-of-UTC persona's Sunday evening is Monday in UTC but still belongs to its own week. The UTC range is
 * only a fallback for legacy rows without week_start.
 */
export const WEEK_MEMBER_SQL = '(week_start = $2::date OR (week_start IS NULL AND slot_at >= $3 AND slot_at < $4))';

export interface PlanWeekResult {
  readonly created: number;
  readonly existing: number;
  readonly slotIds: string[];
  readonly target: CadenceTarget | null;
  readonly skipped?: string;
}

/**
 * Plans one persona's week (idempotent: a week that already has slots is left alone). `weekStart` is any instant
 * in the week; slots are stored in UTC with `week_start`, posting window, CTA keyword and (sell) product.
 */
export async function planWeek(services: StudioServices, personaId: string, weekStartIn: Date, opts: { now?: Date } = {}): Promise<PlanWeekResult> {
  const { db } = services;
  const now = opts.now ?? services.now();
  const weekStart = mondayUtc(weekStartIn);
  const weekEnd = new Date(weekStart.getTime() + 7 * DAY_MS);
  const ctx = await loadPersonaContext(db, personaId);
  if (!PUBLISHING_STATES.includes(ctx.persona.state)) return { created: 0, existing: 0, slotIds: [], target: null, skipped: `persona is ${ctx.persona.state}` };
  const countExisting = async () =>
    (
      await db.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM calendar_slot WHERE persona_id = $1 AND status <> 'skipped' AND ${WEEK_MEMBER_SQL}`,
        [personaId, isoDate(weekStart), weekStart, weekEnd],
      )
    ).n;
  const existing = await countExisting();
  if (existing > 0) return { created: 0, existing, slotIds: [], target: null, skipped: 'week already planned' };

  const policy = await services.cadence.target(personaId, weekStart);
  const wanted = normaliseCadence(effectiveCadence(policy, ctx.persona.state));
  const times = postingTimes(weekStart, wanted.postsPerWeek, ctx.persona.timezone, { now, seed: personaId });
  if (!times.length) return { created: 0, existing: 0, slotIds: [], target: wanted, skipped: 'no posting windows left this week' };
  const target = times.length < wanted.postsPerWeek ? normaliseCadence({ ...wanted, postsPerWeek: times.length }, times.length) : wanted;
  const placed = scheduleMix(assignMix(target), times);
  const pillars = choosePillars(ctx, placed);

  // Sell slots: Monetization Agent order. Launch beats keep their own date when it falls in the week.
  const queue = await sellQueue(db, ctx, weekStart);
  const leadDelivers = ctx.keywords.find((k) => k.keyword === ctx.leadKeyword)?.delivers ?? 'the free starter guide';
  const plans: SlotPlan[] = placed.map((p, i) => ({
    format: p.format,
    purpose: p.purpose,
    at: p.at,
    window: p.window,
    pillar: pillars[i] ?? null,
    title: null,
    ideaId: null,
    ctaKeyword: ctx.leadKeyword,
    ctaDelivers: leadDelivers,
    productId: null,
  }));
  for (const [slot, item] of bookSellSlots(plans.filter((p) => p.purpose === 'sell'), queue)) {
    Object.assign(slot, { title: item.title, ctaKeyword: item.ctaKeyword, ctaDelivers: item.delivers, productId: item.productId, sell: item });
  }

  // (IOS-5) Storyline beats for the week (stream J's WorldService; [] until the persona has a storyline).
  const beats = await services.world.beatsForWeek({ personaId, weekStart, slots: plans.map((p, index) => ({ index, at: p.at, format: p.format, purpose: p.purpose })) });
  for (const b of beats) if (plans[b.slotIndex]) plans[b.slotIndex]!.story = b;

  // Fresh ideas first (News Desk reactions expire in 24–72 h, so they take the earliest reach/trust slots).
  const ideas = await db.query<{ id: string; title: string; pillar: string | null; format: PostFormat | null; source: Record<string, unknown> | null }>(
    `SELECT id, title, pillar, format, source FROM idea WHERE persona_id = $1 AND status = 'new'
      AND (source->>'expires_at' IS NULL OR (source->>'expires_at')::timestamptz > $2)
      ORDER BY (source->>'type' = 'news') DESC NULLS LAST, created_at LIMIT 20`,
    [personaId, weekStart],
  );
  for (const idea of ideas) {
    const expires = asString(idea.source?.expires_at);
    const slot = plans.find((p) => !p.title && p.purpose !== 'sell' && (!expires || p.at.getTime() <= new Date(expires).getTime()) && (!idea.format || idea.format === p.format))
      ?? plans.find((p) => !p.title && p.purpose !== 'sell' && (!expires || p.at.getTime() <= new Date(expires).getTime()));
    if (!slot) continue;
    slot.title = idea.title;
    slot.ideaId = idea.id;
    if (idea.pillar) slot.pillar = idea.pillar;
  }

  // The calendar-planner writes titles for the rest (one call per week).
  const open = plans.map((p, i) => ({ ...p, i })).filter((p) => !p.title);
  if (open.length) {
    const recent = (
      await db.query<{ title: string }>(`SELECT title FROM idea WHERE persona_id = $1 ORDER BY created_at DESC LIMIT 60`, [personaId])
    ).map((r) => r.title);
    const briefing = await services.knowledge.latestBriefing(personaId);
    const res = await services.runtime.run<{ ideas: Array<{ slot: number; title: string; pillar: string }> }>({
      agent: 'calendar-planner',
      scope: { studioId: ctx.persona.studio_id, personaId },
      label: `calendar: ${open.length} ideas for week ${isoDate(weekStart)}`,
      system: `You are the calendar planner. Give each open slot one short-form video idea title (under 70 characters) in the persona's pillars
and voice. Reach posts stop the scroll (relatable, hooks, trends); trust posts teach (how-tos, frameworks, mini-lessons). English only.
Never repeat a recent title. Follow the studio rules.`,
      cached: ctx.cached,
      prompt: `Week of ${isoDate(weekStart)}. Pillars: ${ctx.pillars.map((p) => `${p.name} (e.g. ${p.examples.slice(0, 2).join('; ')})`).join(' | ')}
Open slots:\n${open.map((p) => `- slot ${p.i}: ${p.format}, ${p.purpose}, pillar ${p.pillar ?? 'any'}${p.story ? `, storyline beat: ${p.story.beat}` : ''}`).join('\n')}
Recent titles (don't repeat):\n${recent.slice(0, 30).map((t) => `- ${t}`).join('\n')}${
        briefing?.items.length ? `\nToday's news briefing: ${briefing.items.slice(0, 3).map((b) => b.title).join('; ')}` : ''
      }`,
      maxTokens: 3000,
      jsonSchema: TITLES_SCHEMA,
      parse: parseTitles,
      fake: () => ({ ideas: fakeTitles(ctx, open, recent).map((title, k) => ({ slot: open[k]!.i, title, pillar: open[k]!.pillar ?? '' })) }),
      costRef: { type: 'persona', id: personaId },
    });
    const fallback = fakeTitles(ctx, open, recent);
    for (const [k, p] of open.entries()) {
      const got = res.output.ideas.find((x) => x.slot === p.i);
      plans[p.i]!.title = got?.title || fallback[k]!;
      if (got?.pillar && ctx.pillars.some((x) => x.name === got.pillar)) plans[p.i]!.pillar = got.pillar;
    }
  }

  const slotIds = await db.transaction(async (tx) => {
    await tx.query('SELECT id FROM persona WHERE id = $1 FOR UPDATE', [personaId]);
    const again = await tx.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM calendar_slot WHERE persona_id = $1 AND status <> 'skipped' AND ${WEEK_MEMBER_SQL}`,
      [personaId, isoDate(weekStart), weekStart, weekEnd],
    );
    if (again.n > 0) return [] as string[];
    const ids: string[] = [];
    for (const [k, p] of plans.entries()) {
      const title = p.title ?? `${ctx.persona.niche} tip`;
      const ideaId =
        p.ideaId ??
        (
          await tx.one<{ id: string }>(
            `INSERT INTO idea (persona_id, title, pillar, format, purpose, source, status, cta_keyword, product_id)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'booked', $7, $8) RETURNING id`,
            [personaId, title, p.pillar, p.format, p.purpose, json({ type: p.sell ? `monetization:${p.sell.kind}` : 'calendar', week: isoDate(weekStart), ...(p.sell?.beat ? { beat: p.sell.beat } : {}) }), p.ctaKeyword, p.productId],
          )
        ).id;
      if (p.ideaId) await tx.query(`UPDATE idea SET status = 'booked', cta_keyword = $2 WHERE id = $1`, [p.ideaId, p.ctaKeyword]);
      const row = await tx.one<{ id: string }>(
        `INSERT INTO calendar_slot (persona_id, slot_at, format, purpose, pillar, title, status, idea_id, thumbnail_url, week_start, posting_window,
                                    cta_keyword, product_id, stage_changed_at, meta)
         VALUES ($1, $2, $3, $4, $5, $6, 'planned', $7, $8, $9::date, $10, $11, $12, $13, $14::jsonb) RETURNING id`,
        [
          personaId,
          p.at,
          p.format,
          p.purpose,
          p.pillar,
          title,
          ideaId,
          thumbnailUri(title, ctx.hue, p.format, k),
          isoDate(weekStart),
          p.window,
          p.ctaKeyword,
          p.productId,
          now,
          json({ cta_delivers: p.ctaDelivers, cadence_source: target.source, ...(target.reason ? { cadence_reason: target.reason } : {}), ...(p.sell ? { sell_kind: p.sell.kind, beat: p.sell.beat ?? null } : {}), ...(p.story ? { story: p.story } : {}) }),
        ],
      );
      ids.push(row.id);
    }
    return ids;
  });
  return { created: slotIds.length, existing: 0, slotIds, target };
}

// ─── Fast reactions into a week that is already planned (PRD §3.10.3, FR-23.2: publish within 24–72 h) ───

/** A swapped slot needs this long to re-run hook-lab, script, Q1, Gate and media before it posts. */
export const REACTION_LEAD_MS = 6 * 3_600_000;
/** Stages a slot can still be re-titled in (nothing has gone to media yet). */
const SWAPPABLE = ['planned', 'scripted', 'q1'];

export interface BookedReaction {
  readonly personaId: string;
  readonly ideaId: string;
  readonly slotId: string;
  readonly slotAt: Date;
}

/**
 * planWeek only books News Desk reaction ideas into a week it is planning, and reaction ideas expire 48 h after the
 * briefing, so in steady state they never reach a week that is already planned. This swaps the freshest unexpired
 * reaction idea (one per persona per run) into the best reach/trust slot that posts before the idea expires: an
 * unscripted slot first, else the earliest one not yet past Q1 (it goes back to 'planned' and is re-scripted). The
 * slot's calendar idea goes back to the queue. At most one reaction a day per persona. Cheap: no model calls.
 */
export async function bookReactionIdeas(services: StudioServices, opts: { now?: Date; personaId?: string } = {}): Promise<BookedReaction[]> {
  const { db } = services;
  const now = opts.now ?? services.now();
  const earliest = new Date(now.getTime() + REACTION_LEAD_MS);
  const ideas = await db.query<{ id: string; persona_id: string; title: string; pillar: string | null; format: PostFormat | null; expires_at: Date }>(
    `SELECT i.id, i.persona_id, i.title, i.pillar, i.format, (i.source->>'expires_at')::timestamptz AS expires_at
       FROM idea i JOIN persona p ON p.id = i.persona_id
      WHERE i.status = 'new' AND i.source->>'type' = 'news' AND i.source->>'expires_at' IS NOT NULL
        AND (i.source->>'expires_at')::timestamptz > $1 AND p.state = ANY($2::text[]) AND ($3::uuid IS NULL OR i.persona_id = $3)
      ORDER BY i.persona_id, i.created_at DESC`,
    [earliest, [...PUBLISHING_STATES], opts.personaId ?? null],
  );
  const out: BookedReaction[] = [];
  const done = new Set<string>();
  for (const idea of ideas) {
    if (done.has(idea.persona_id)) continue;
    const booked = await db.transaction(async (tx) => {
      await tx.query('SELECT id FROM persona WHERE id = $1 FOR UPDATE', [idea.persona_id]);
      const fresh = await tx.maybeOne(`SELECT 1 FROM idea WHERE id = $1 AND status = 'new'`, [idea.id]);
      if (!fresh) return null;
      const slot = await tx.maybeOne<{ id: string; slot_at: Date; idea_id: string | null }>(
        `SELECT s.id, s.slot_at, s.idea_id FROM calendar_slot s LEFT JOIN idea old ON old.id = s.idea_id
          WHERE s.persona_id = $1 AND s.status = ANY($2::text[]) AND s.purpose IN ('reach','trust') AND s.product_id IS NULL
            AND s.slot_at >= $3 AND s.slot_at <= $4 AND COALESCE(old.source->>'type', '') <> 'news'
            AND NOT EXISTS (SELECT 1 FROM job j WHERE j.kind = 'pipeline.slot' AND j.payload->>'slotId' = s.id::text AND j.status = 'running')
            AND NOT EXISTS (SELECT 1 FROM calendar_slot o JOIN idea oi ON oi.id = o.idea_id
                             WHERE o.persona_id = s.persona_id AND o.id <> s.id AND o.status <> 'skipped' AND oi.source->>'type' = 'news'
                               AND o.slot_at::date = s.slot_at::date)
          ORDER BY (s.status = 'planned') DESC, (s.format = $5) DESC, s.slot_at
          LIMIT 1`,
        [idea.persona_id, SWAPPABLE, earliest, idea.expires_at, idea.format ?? 'talking'],
      );
      if (!slot) return null;
      if (slot.idea_id) await tx.query(`UPDATE idea SET status = 'new' WHERE id = $1 AND status IN ('booked','scripted') AND COALESCE(source->>'type', '') <> 'slot'`, [slot.idea_id]);
      await tx.query(`UPDATE idea SET status = 'booked' WHERE id = $1`, [idea.id]);
      await tx.query(
        `UPDATE calendar_slot SET title = $2, idea_id = $3, pillar = COALESCE($4, pillar), status = 'planned', block_reason = NULL, stage_changed_at = $5,
                meta = meta || $6::jsonb WHERE id = $1`,
        [slot.id, idea.title, idea.id, idea.pillar, now, json({ reaction: true, replaced_idea_id: slot.idea_id })],
      );
      return { personaId: idea.persona_id, ideaId: idea.id, slotId: slot.id, slotAt: new Date(slot.slot_at) };
    });
    if (booked) {
      out.push(booked);
      done.add(idea.persona_id);
    }
  }
  return out;
}
