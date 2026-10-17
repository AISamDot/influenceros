import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  enqueueOnceFor,
  type FormatPlan,
  type Grounding,
  loadPersonaKit,
  type QcCheck,
  type SlotBeat,
  STORIES_PER_DAY,
  type StoriesPlan,
  type StoryFrameKind,
  type StudioServices,
} from '@ios/agents';
import { fenceUntrusted, loadPersonaContext, type PersonaContext, qcPass, qcScore, runGate, saveGateResult, saveQcReport, sellQueue } from '@ios/content';
import { type Actor, actorRef, assertCanPublish, audit, type Autonomy, BudgetExceededError, DeferJob, notify, type PersonaState, type Platform, PublishBlockedError, PUBLISHING_STATES } from '@ios/core';
import { json } from '@ios/db';
import { EXPORT, getProfile, gradeFromKit, hfSpend, mediaDeps, mediaModels, SAFE_ZONE, type TextBox } from '@ios/media';
import { isPublishRefused } from '@ios/providers';
import { STORY_FRAME_COST_USD } from './catalog';
import { defaultPlan } from './plan';
import { planInForce } from './store';
import { DAY_MS, isoDate, localDate, localDayRange, localTime, mondayOf, safeTimeZone, weekdayOf, WEEKDAYS, zonedAt } from './time';

/**
 * The Stories engine (PRD FR-4.3d): 3–5 native frames a day per persona, made for the day, never just repurposed.
 *   plan the day → one stories-producer run writes every frame's copy → per frame: compiled still prompt (K's compiler,
 *   J's grounding) → Higgsfield still (720p, governed) → text overlay at 1080×1920 → QC + world checks → Gate
 *   (story_frame) → the continuity ledger → publish at its time as Zernio kind 'story' where the platform supports it,
 *   after the kill-switch check, AI flag on → metrics (reach, replies, taps, exits) → highlights and the Format Plan.
 */

export const STORY_JOB = {
  plan: 'stories.plan_day',
  produce: 'stories.produce',
  publish: 'stories.publish',
  metrics: 'stories.metrics',
  highlights: 'highlights.refresh',
  tune: 'formats.tune_stories',
} as const;

/** Local posting times by frame position: morning world frame … evening sell frame. */
const SLOT_TIMES: ReadonlyArray<readonly [number, number]> = [
  [8, 15],
  [11, 30],
  [14, 45],
  [18, 0],
  [20, 30],
];

export interface StoryFrameRow {
  id: string;
  studio_id: string;
  persona_id: string;
  story_date: string;
  seq: number;
  kind: StoryFrameKind;
  status: 'planned' | 'rendered' | 'approved' | 'awaiting_approval' | 'blocked' | 'published' | 'skipped' | 'failed';
  planned_at: Date;
  text: string | null;
  scene: string | null;
  cta_keyword: string | null;
  product_id: string | null;
  reshare_post_id: string | null;
  beat: SlotBeat | null;
  grounding: Record<string, unknown> | null;
  prompt: Record<string, unknown> | null;
  still_url: string | null;
  media_url: string | null;
  media_key: string | null;
  width: number | null;
  height: number | null;
  credits: number | string | null;
  qc_report_id: string | null;
  gate_result_id: string | null;
  gate_verdict: 'green' | 'amber' | 'red' | null;
  block_reason: string | null;
  meta: Record<string, unknown>;
}

const dateStr = (v: string | Date): string => (typeof v === 'string' ? v.slice(0, 10) : isoDate(v));

/** The day's frame kinds in posting order. The sell frame comes on top on sell days; never more than 5 frames. */
export function dailyKinds(stories: StoriesPlan, sellDay: boolean): StoryFrameKind[] {
  const n = (k: StoryFrameKind) => stories.mix.find((m) => m.kind === k)?.perDay ?? 0;
  const out: StoryFrameKind[] = [];
  for (let i = 0; i < n('world'); i++) out.push('world');
  for (let i = 0; i < n('storyline'); i++) out.push('storyline');
  for (let i = 0; i < n('reshare'); i++) out.push('reshare');
  for (let i = 0; i < n('engagement'); i++) out.push('engagement');
  if (sellDay && n('sell') > 0) {
    if (out.length >= STORIES_PER_DAY.max) {
      const drop = out.lastIndexOf('storyline') > 0 && out.filter((k) => k === 'storyline').length > 1 ? out.lastIndexOf('storyline') : out.lastIndexOf('reshare');
      if (drop >= 0) out.splice(drop, 1);
      else out.pop();
    }
    out.push('sell');
  }
  return out.slice(0, STORIES_PER_DAY.max);
}

function timesFor(n: number): ReadonlyArray<readonly [number, number]> {
  if (n >= 5) return SLOT_TIMES;
  if (n === 4) return [SLOT_TIMES[0]!, SLOT_TIMES[1]!, SLOT_TIMES[3]!, SLOT_TIMES[4]!];
  return [SLOT_TIMES[0]!, SLOT_TIMES[2]!, SLOT_TIMES[4]!];
}

/** A sell day: the calendar has a sell post that local day; with no week planned, Tuesdays and Fridays. */
export async function isSellDay(services: Pick<StudioServices, 'db'>, personaId: string, date: string, timeZone: string): Promise<boolean> {
  const { from, to } = localDayRange(date, timeZone);
  const r = await services.db.one<{ sell: number; week: number }>(
    `SELECT count(*) FILTER (WHERE purpose = 'sell' AND slot_at >= $2 AND slot_at < $3)::int AS sell,
            count(*) FILTER (WHERE slot_at >= $4 AND slot_at < $5)::int AS week
       FROM calendar_slot WHERE persona_id = $1 AND status <> 'skipped'`,
    [personaId, from, to, new Date(from.getTime() - 3 * DAY_MS), new Date(to.getTime() + 3 * DAY_MS)],
  );
  if (r.sell > 0) return true;
  return r.week === 0 && [1, 4].includes(weekdayOf(date));
}

interface PersonaRowLite {
  id: string;
  studio_id: string;
  name: string;
  niche: string;
  state: PersonaState;
  timezone: string;
  autonomy: Autonomy;
}

const personaOf = (services: Pick<StudioServices, 'db'>, personaId: string) =>
  services.db.one<PersonaRowLite>('SELECT id, studio_id, name, niche, state, timezone, autonomy FROM persona WHERE id = $1', [personaId]);

export async function framesFor(services: Pick<StudioServices, 'db'>, personaId: string, date: string): Promise<StoryFrameRow[]> {
  return services.db.query<StoryFrameRow>(`SELECT * FROM story_frame WHERE persona_id = $1 AND story_date = $2::date ORDER BY seq`, [personaId, date]);
}

/** The persona's Stories plan in force (its Format Plan, else the studio default). */
export async function storiesPlanFor(services: Pick<StudioServices, 'db' | 'now'>, personaId: string): Promise<FormatPlan['stories']> {
  return ((await planInForce(services.db, personaId, services.now())) ?? defaultPlan()).stories;
}

// ───────────────────────────── Copy (stories-producer) ─────────────────────────────

interface FrameBrief {
  seq: number;
  kind: StoryFrameKind;
  at: Date;
  grounding: Grounding | null;
  beat: SlotBeat | null;
  reshare: { postId: string; title: string } | null;
  sell: { title: string; keyword: string; delivers: string; productId: string | null } | null;
  keyword: string;
  delivers: string;
  todayTitle: string | null;
}

interface FrameCopy {
  seq: number;
  text: string;
  scene: string;
}

const COPY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['frames'],
  properties: {
    frames: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['seq', 'text', 'scene'],
        properties: { seq: { type: 'integer' }, text: { type: 'string' }, scene: { type: 'string' } },
      },
    },
  },
} as const;

function parseCopy(v: unknown): { frames: FrameCopy[] } {
  const frames = (v as { frames?: unknown })?.frames;
  if (!Array.isArray(frames)) throw new Error('expected { frames: [...] }');
  return {
    frames: frames
      .filter((f) => f && typeof f === 'object' && Number.isInteger((f as FrameCopy).seq) && typeof (f as FrameCopy).text === 'string')
      .map((f) => ({ seq: (f as FrameCopy).seq, text: String((f as FrameCopy).text).trim(), scene: String((f as FrameCopy).scene ?? '').trim() })),
  };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Deterministic copy for fake mode (and the fallback when a model line is unusable). */
export function fakeCopy(ctx: Pick<PersonaContext, 'persona' | 'pillars'>, b: FrameBrief): FrameCopy {
  const name = ctx.persona.name.split(' ')[0] ?? ctx.persona.name;
  const g = b.grounding;
  const weekday = g?.weekday ?? WEEKDAYS[weekdayOf(isoDate(b.at))]!;
  const place = g?.place.city ?? 'home';
  const pillar = ctx.pillars[0]?.name ?? ctx.persona.niche;
  switch (b.kind) {
    case 'world': {
      const weather = g?.weather ? `${g.weather.summary.toLowerCase()}, ${Math.round(g.weather.tempC)}°C` : 'a quiet start';
      return { seq: b.seq, text: clip(`${weekday} in ${place}: ${weather}. Here's what today looks like.`, 140), scene: `${name} at ${place}, ${g?.timeOfDay ?? 'morning'} light${g?.weather ? `, ${g.weather.summary.toLowerCase()} outside` : ''}, phone selfie` };
    }
    case 'storyline':
      return b.beat
        ? { seq: b.seq, text: clip(`${b.beat.chapter}: ${b.beat.beat}`, 140), scene: `${name} mid-moment: ${clip(b.beat.beat, 120)}` }
        : { seq: b.seq, text: clip(`Behind the scenes today: ${b.todayTitle ?? `working on ${pillar.toLowerCase()}`}.`, 140), scene: `${name} working on today's ${pillar.toLowerCase()} post, candid, over-the-shoulder` };
    case 'reshare':
      return { seq: b.seq, text: clip(`New post is up: ${b.reshare?.title ?? pillar}. It's on my grid now.`, 140), scene: `${name} holding up a phone showing the new post, casual` };
    case 'engagement':
      return { seq: b.seq, text: clip(`Reply "${b.keyword}" and I'll send you ${b.delivers}.`, 140), scene: `${name} looking at the camera, eyebrows raised, relaxed` };
    case 'sell': {
      const s = b.sell;
      return { seq: b.seq, text: clip(`${s?.title ?? 'The free guide'}: reply "${s?.keyword ?? b.keyword}" and I'll DM you ${s?.delivers ?? b.delivers}.`, 140), scene: `${name} at a tidy desk with a notebook and a laptop, warm light` };
    }
  }
}

/** Plans one persona-local day: kinds from the plan, times in the persona's time zone, copy from the stories-producer. */
export async function planStoryDay(services: StudioServices, personaId: string, dateIn?: string): Promise<StoryFrameRow[]> {
  const p = await personaOf(services, personaId);
  const tz = safeTimeZone(p.timezone);
  const now = services.now();
  const date = dateIn ?? localDate(now, tz);
  const existing = await framesFor(services, personaId, date);
  if (existing.length) return existing;
  if (!PUBLISHING_STATES.includes(p.state)) return [];

  const plan = await storiesPlanFor(services, personaId);
  const sellDay = await isSellDay(services, personaId, date, tz);
  let kinds = dailyKinds(plan, sellDay);
  const times = timesFor(kinds.length);
  const ctx = await loadPersonaContext(services.db, personaId);
  const { from, to } = localDayRange(date, tz);

  // The feed post to reshare: the newest live post in the last 2 days, else today's next scheduled one.
  const post = await services.db.maybeOne<{ id: string; title: string | null; caption: string | null }>(
    `SELECT po.id, s.title, po.caption FROM post po LEFT JOIN calendar_slot s ON s.id = po.calendar_slot_id
      WHERE po.persona_id = $1 AND ((po.status = 'live' AND po.published_at >= $2) OR (po.status IN ('scheduled','publishing') AND po.scheduled_at >= $3 AND po.scheduled_at < $4))
      ORDER BY (po.status = 'live') DESC, COALESCE(po.published_at, po.scheduled_at) DESC LIMIT 1`,
    [personaId, new Date(from.getTime() - 2 * DAY_MS), from, to],
  );
  if (!post) kinds = kinds.map((k) => (k === 'reshare' ? 'storyline' : k));
  const today = await services.db.maybeOne<{ title: string }>(`SELECT title FROM calendar_slot WHERE persona_id = $1 AND slot_at >= $2 AND slot_at < $3 AND status <> 'skipped' ORDER BY slot_at LIMIT 1`, [personaId, from, to]);
  const sell = sellDay ? (await sellQueue(services.db, ctx, mondayOf(from)))[0] ?? null : null;
  const delivers = ctx.keywords.find((k) => k.keyword === ctx.leadKeyword)?.delivers ?? 'the free starter guide';

  const dayBeats = kinds.includes('storyline') ? await storyBeatsFor(services, personaId, date, from, to) : [];
  let storylineN = 0;
  const briefs: FrameBrief[] = [];
  for (const [i, kind] of kinds.entries()) {
    const [h, m] = times[i] ?? SLOT_TIMES[i]!;
    const at = zonedAt(date, h, m, tz);
    let grounding: Grounding | null = null;
    let beat: SlotBeat | null = null;
    if (kind === 'world') grounding = (await services.world.grounding(personaId, at).catch(() => null)) ?? stubGrounding(p, at);
    if (kind === 'storyline') beat = dayBeats[storylineN++] ?? null;
    briefs.push({
      seq: i + 1,
      kind,
      at,
      grounding,
      beat,
      reshare: kind === 'reshare' && post ? { postId: post.id, title: post.title ?? clip(post.caption ?? '', 60) } : null,
      sell: kind === 'sell' ? (sell ? { title: sell.title, keyword: sell.ctaKeyword, delivers: sell.delivers, productId: sell.productId } : { title: 'The free guide', keyword: ctx.leadKeyword, delivers, productId: null }) : null,
      keyword: ctx.leadKeyword,
      delivers,
      todayTitle: today?.title ?? null,
    });
  }

  const res = await services.runtime.run<{ frames: FrameCopy[] }>({
    agent: 'stories-producer',
    scope: { studioId: p.studio_id, personaId },
    label: `stories: ${briefs.length} frames for ${date}`,
    system: `You are the Stories producer. Write ${briefs.length} Instagram Story frames for today, in the persona's voice, made for today (not repurposed).
Each frame is one still with at most 140 characters of overlay text and a short scene for the still. English only. First-person stories and lore
are fine; never use a story as proof that a product works, never claim results or credentials, no links (the API has no link or poll stickers:
CTAs are "reply KEYWORD"). Keep the persona's facts consistent with the storyline and the place. Follow the studio rules.`,
    cached: ctx.cached,
    prompt: `Date: ${date} (${WEEKDAYS[weekdayOf(date)]}), ${p.name}, ${p.niche}. Lead keyword: ${ctx.leadKeyword} (delivers ${delivers}).
Frames:\n${briefs
      .map(
        (b) =>
          `- seq ${b.seq} (${b.kind}, ${localTime(b.at, tz)}): ${
            b.kind === 'world'
              ? `where I am today. ${b.grounding?.block ?? ''}`
              : b.kind === 'storyline'
                ? b.beat
                  ? `storyline beat: ${b.beat.chapter}: ${b.beat.beat}`
                  : `behind the scenes of today's post: ${b.todayTitle ?? 'the week'}`
                : b.kind === 'reshare'
                  ? `reshare the new feed post: ${fenceUntrusted('POST TITLE', b.reshare?.title ?? '', 200)}`
                  : b.kind === 'engagement'
                    ? `engagement: a question or "reply ${b.keyword}"`
                    : `sell: ${b.sell?.title}, CTA "reply ${b.sell?.keyword}"`
          }`,
      )
      .join('\n')}
Return {"frames": [{"seq": 1, "text": "...", "scene": "..."}]}.`,
    maxTokens: 1500,
    jsonSchema: COPY_SCHEMA,
    parse: parseCopy,
    fake: () => ({ frames: briefs.map((b) => fakeCopy(ctx, b)) }),
    costRef: { type: 'persona', id: personaId },
  });

  const rows: StoryFrameRow[] = [];
  await services.db.transaction(async (tx) => {
    await tx.query('SELECT id FROM persona WHERE id = $1 FOR UPDATE', [personaId]);
    const again = await tx.maybeOne(`SELECT 1 FROM story_frame WHERE persona_id = $1 AND story_date = $2::date LIMIT 1`, [personaId, date]);
    if (again) return;
    for (const b of briefs) {
      const got = res.output.frames.find((f) => f.seq === b.seq);
      const fb = fakeCopy(ctx, b);
      const keyword = b.kind === 'sell' ? (b.sell?.keyword ?? b.keyword) : b.kind === 'engagement' ? b.keyword : null;
      let text = clip((got?.text || fb.text).replace(/\bhttps?:\/\/\S+/gi, '').trim(), 140);
      if (keyword && !text.toUpperCase().includes(keyword.toUpperCase())) text = fb.text;
      rows.push(
        await tx.one<StoryFrameRow>(
          `INSERT INTO story_frame (studio_id, persona_id, story_date, seq, kind, planned_at, text, scene, cta_keyword, product_id, reshare_post_id, beat, grounding, meta)
           VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14::jsonb) RETURNING *`,
          [
            p.studio_id,
            personaId,
            date,
            b.seq,
            b.kind,
            b.at,
            text,
            clip(got?.scene || fb.scene, 400),
            keyword,
            b.sell?.productId ?? null,
            b.reshare?.postId ?? null,
            b.beat ? json(b.beat) : null,
            b.grounding ? json(b.grounding) : null,
            json({ sell_day: sellDay, copy: res.mode, run_id: res.runId }),
          ],
        ),
      );
    }
  });
  return rows.length ? rows : framesFor(services, personaId, date);
}

/**
 * Storyline beats for a day's storyline frames, read-only: the beats the week's calendar already carries (the
 * CadencePolicy week plan asks J's WorldService once per week and stores each slot's beat in meta.story). Today's
 * beat first, then the week's other beats rotated by weekday, so frames on different days tell different beats.
 * Never calls WorldService.beatsForWeek (that assigns beats and would move a feed slot's beat onto a story frame).
 */
export async function storyBeatsFor(services: Pick<StudioServices, 'db'>, personaId: string, date: string, from: Date, to: Date): Promise<SlotBeat[]> {
  const week = mondayOf(new Date(`${date}T12:00:00Z`));
  const rows = await services.db.query<{ slot_at: Date; story: SlotBeat }>(
    `SELECT slot_at, meta->'story' AS story FROM calendar_slot
      WHERE persona_id = $1 AND status <> 'skipped' AND meta ? 'story' AND jsonb_typeof(meta->'story') = 'object'
        AND slot_at >= $2 AND slot_at < $3 ORDER BY slot_at`,
    [personaId, new Date(Math.min(week.getTime(), from.getTime())), new Date(Math.max(week.getTime() + 7 * DAY_MS, to.getTime()))],
  );
  const ok = rows.filter((r) => r.story && typeof r.story.beat === 'string' && r.story.beat.trim());
  const today = ok.filter((r) => new Date(r.slot_at) >= from && new Date(r.slot_at) < to);
  const rest = ok.filter((r) => !today.includes(r));
  const shift = rest.length ? weekdayOf(date) % rest.length : 0;
  const ordered = [...today, ...rest.slice(shift), ...rest.slice(0, shift)].map((r) => r.story);
  return ordered.filter((b, i) => ordered.findIndex((x) => x.beatId === b.beatId) === i);
}

/** A stand-in grounding until stream J's WorldService has a World Bible for the persona. */
export function stubGrounding(p: Pick<PersonaRowLite, 'id' | 'timezone'>, at: Date): Grounding {
  const tz = safeTimeZone(p.timezone);
  const date = localDate(at, tz);
  const hhmm = localTime(at, tz);
  const h = Number(hhmm.slice(0, 2));
  const month = Number(date.slice(5, 7));
  const south = /^(Australia|Pacific\/Auckland|America\/(Argentina|Santiago|Sao_Paulo)|Africa\/Johannesburg)/.test(tz);
  const north = month <= 2 || month === 12 ? 'winter' : month <= 5 ? 'spring' : month <= 8 ? 'summer' : 'autumn';
  const flip = { winter: 'summer', summer: 'winter', spring: 'autumn', autumn: 'spring' } as const;
  const season = south ? flip[north] : north;
  const timeOfDay = h < 5 ? 'night' : h < 7 ? 'dawn' : h < 11 ? 'morning' : h < 14 ? 'midday' : h < 18 ? 'afternoon' : h < 22 ? 'evening' : 'night';
  const city = tz.includes('/') ? tz.split('/').pop()!.replace(/_/g, ' ') : 'home';
  const weekday = WEEKDAYS[weekdayOf(date)]!;
  return {
    personaId: p.id,
    timezone: tz,
    localDate: date,
    localTime: hhmm,
    weekday,
    season,
    timeOfDay,
    place: { city, region: null, country: '', lat: null, lon: null },
    weather: null,
    sunrise: null,
    sunset: null,
    holidays: [],
    block: `Grounding (stub, no World Bible yet): ${weekday} ${date}, ${hhmm} local (${timeOfDay}), ${season}, ${city}. Light and clothing fit the season and time of day.`,
  };
}

// ───────────────────────────── Produce: still + overlay → QC → Gate → ledger ─────────────────────────────

const URL_RE = /\bhttps?:\/\/|\bwww\./i;
const english = (s: string) => {
  const letters = s.replace(/[^\p{L}]/gu, '');
  return letters.length === 0 || letters.replace(/[^A-Za-z]/g, '').length / letters.length >= 0.9;
};

/** Frame QC (stage Q4 on subject 'story_frame'): copy rules, export size, the overlay reads back, world checks. */
export function storyChecks(f: Pick<StoryFrameRow, 'kind' | 'text' | 'cta_keyword'>, render: { width: number; height: number; ocr: string | null }): QcCheck[] {
  const text = f.text ?? '';
  const checks: QcCheck[] = [
    { check: 'story_text', pass: text.length >= 3 && text.length <= 160, severity: 'major', message: text.length ? `${text.length} characters of overlay (≤ 160)` : 'no overlay text' },
    { check: 'story_no_links', pass: !URL_RE.test(text), severity: 'major', message: 'No links on a story frame (the API has no link stickers; CTAs are reply keywords).' },
    { check: 'story_english', pass: english(text), severity: 'major', message: 'English only.' },
    { check: 'story_size', pass: render.width === EXPORT.video.width && render.height === EXPORT.video.height, severity: 'blocker', message: `${render.width}×${render.height} (export 1080×1920)` },
  ];
  if (f.kind === 'engagement' || f.kind === 'sell') {
    const kw = f.cta_keyword ?? '';
    checks.push({ check: 'story_keyword', pass: !!kw && text.toUpperCase().includes(kw.toUpperCase()), severity: 'major', message: kw ? `CTA keyword ${kw} on the frame` : 'no CTA keyword' });
  }
  if (render.ocr !== null) {
    const want = text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
    const got = new Set(render.ocr.toLowerCase().match(/[a-z0-9']+/g) ?? []);
    const share = want.length ? want.filter((w) => got.has(w)).length / want.length : 1;
    checks.push({ check: 'story_ocr', pass: share >= 0.8, severity: 'major', message: `${Math.round(share * 100)}% of the overlay reads back` });
  }
  return checks;
}

function overlayBox(text: string): TextBox {
  const w = EXPORT.video.width - SAFE_ZONE.left - SAFE_ZONE.right;
  const fontSize = text.length > 90 ? 52 : text.length > 50 ? 60 : 68;
  const lines = Math.ceil((text.length * fontSize * 0.55) / w) + 1;
  const h = Math.min(640, lines * Math.round(fontSize * 1.3));
  const y = EXPORT.video.height - SAFE_ZONE.bottom - h - 40;
  return { text, startS: 0, endS: 0, style: 'headline', fontSize, box: { x: SAFE_ZONE.left, y, w, h } };
}

/**
 * Makes one frame: still → overlay → QC → Gate → ledger, then queues its publish at the planned time. Idempotent:
 * a frame past 'planned' is left alone. Defers (no attempt spent) when the persona's media budget is spent.
 */
export async function produceStoryFrame(services: StudioServices, frameId: string): Promise<StoryFrameRow> {
  const f = await services.db.one<StoryFrameRow>('SELECT * FROM story_frame WHERE id = $1', [frameId]);
  if (f.status !== 'planned') return f;
  const p = await personaOf(services, f.persona_id);
  if (!PUBLISHING_STATES.includes(p.state)) {
    return services.db.one<StoryFrameRow>(`UPDATE story_frame SET status = 'skipped', block_reason = $2, updated_at = now() WHERE id = $1 RETURNING *`, [frameId, `persona is ${p.state}`]);
  }
  const at = new Date(f.planned_at);
  const grounding = (f.grounding as Grounding | null) ?? (await services.world.grounding(f.persona_id, at).catch(() => null)) ?? stubGrounding(p, at);
  const compiled = await services.prompts.image({
    personaId: f.persona_id,
    scene: f.scene ?? f.text ?? 'the persona today',
    camera: f.kind === 'world' || f.kind === 'engagement' ? 'selfie' : f.kind === 'storyline' ? 'over_shoulder' : 'handheld',
    grounding,
    location: f.kind === 'world' ? grounding.place.city : null,
    aspect: '9:16',
  });
  const profile = await getProfile(services, f.persona_id).catch(() => null);
  const model = mediaModels().still;
  const scope = { studioId: p.studio_id, personaId: f.persona_id, slotId: null, ref: { type: 'persona' as const, id: f.persona_id } };
  let still: { url: string; credits: number };
  if (f.still_url) {
    // A retry after a later step failed: the still is already paid for, so reuse it instead of buying another.
    still = { url: f.still_url, credits: Number(f.credits ?? 0) };
  } else {
    try {
      still = await hfSpend(services, scope, { operation: 'still', model }, () =>
        services.providers.imageVideo.generateStill({
          prompt: compiled.text,
          aspect: '9:16',
          model,
          resolution: '720p',
          ...(profile?.soulId ? { soulId: profile.soulId } : {}),
          ...(compiled.references.length ? { referenceImageUrls: compiled.references } : {}),
        }),
      );
    } catch (err) {
      if (err instanceof BudgetExceededError) throw new DeferJob(6 * 3_600_000, `media budget: ${err.message}`);
      throw err;
    }
    await services.db.query(`UPDATE story_frame SET still_url = $2, credits = $3, updated_at = now() WHERE id = $1 AND status = 'planned'`, [f.id, still.url, still.credits]);
  }

  const deps = mediaDeps(services);
  const dir = join(deps.workRoot, 'stories', f.id);
  await mkdir(dir, { recursive: true });
  const bg = join(dir, 'still.png');
  await deps.toolkit.fetch(still.url, bg, { kind: 'image' });
  const kit = await loadPersonaKit(services.db, f.persona_id);
  const text = f.text ?? '';
  const out = join(dir, 'frame.jpg');
  const info = await deps.toolkit.renderCard(
    { width: EXPORT.video.width, height: EXPORT.video.height, background: bg, colors: kit.colors, layout: 'static', title: text, grade: gradeFromKit(kit), sharpen: true, texts: [overlayBox(text)] },
    out,
  );
  const key = `stories/${f.persona_id}/${dateStr(f.story_date)}/${f.seq}-${f.id.slice(0, 8)}.jpg`;
  const stored = await services.providers.storage.putFile({ key, filePath: out, contentType: 'image/jpeg' });
  const ocr = await deps.ocr.read(out).then((r) => r.text).catch(() => null);

  // QC: frame checks + J's world checks (grounding fit, continuity, no-repeat).
  const world = await services.world.checkContent({ studioId: p.studio_id, personaId: f.persona_id, subject: { type: 'story_frame', id: f.id }, text, at, visualBrief: f.scene }).catch(() => [] as QcCheck[]);
  const checks = [...storyChecks(f, { width: info.width, height: info.height, ocr }), ...world];
  const pass = qcPass(checks);
  const qcId = await saveQcReport(services, { personaId: f.persona_id, subjectType: 'story_frame', subjectId: f.id, stage: 'Q4', pass, score: qcScore(checks), checks, extra: { kind: f.kind, media_key: key } });

  // Gate: legal/platform lines only (a story used as proof that a product works is the only story block).
  const gate = await runGate(services, {
    studioId: p.studio_id,
    personaId: f.persona_id,
    input: { kind: 'caption', text, purpose: f.kind === 'sell' ? 'sell' : 'reach' },
    costRef: { type: 'persona', id: f.persona_id },
    label: 'gate: story frame',
  });
  const gateChecks = [...gate.checks.filter((c) => c.rule !== 'ai_flag'), { rule: 'ai_flag', verdict: 'green' as const, message: 'Story frames always publish with the platform AI flag on.' }];
  const verdict = gate.verdict;
  const gateId = await saveGateResult(services, { personaId: f.persona_id, subjectType: 'story_frame', subjectId: f.id, stage: 'pre_publish', verdict, checks: gateChecks });

  const failed = checks.filter((c) => !c.pass && c.severity !== 'minor').map((c) => c.message);
  const status: StoryFrameRow['status'] = !pass || verdict === 'red' ? 'blocked' : verdict === 'amber' || p.autonomy === 'L0' ? 'awaiting_approval' : 'approved';
  const reason = !pass ? `QC: ${failed.join('; ')}` : verdict === 'red' ? `Gate: ${gateChecks.filter((c) => c.verdict === 'red').map((c) => c.message).join('; ')}` : verdict === 'amber' ? 'Gate amber: needs the Owner' : p.autonomy === 'L0' ? 'L0 persona: the Owner approves each frame' : null;
  const row = await services.db.one<StoryFrameRow>(
    `UPDATE story_frame SET status = $2, prompt = $3::jsonb, still_url = $4, media_url = $5, media_key = $6, width = $7, height = $8, credits = $9,
            qc_report_id = $10, gate_result_id = $11, gate_verdict = $12, block_reason = $13, grounding = COALESCE(grounding, $14::jsonb), updated_at = now(),
            meta = meta || $15::jsonb
      WHERE id = $1 RETURNING *`,
    [f.id, status, json({ text: compiled.text, camera: compiled.camera, blocks: compiled.blocks, references: compiled.references }), still.url, stored.url, key, info.width, info.height, still.credits, qcId, gateId, verdict, reason, json(grounding), json({ cost_usd: STORY_FRAME_COST_USD })],
  );
  if (status === 'approved') await approved(services, row);
  return row;
}

/** An approved frame: its facts go to the continuity ledger; once its time has come its publish is queued. */
async function approved(services: StudioServices, f: StoryFrameRow): Promise<void> {
  await services.world.recordApproved({ studioId: f.studio_id, personaId: f.persona_id, subject: { type: 'story_frame', id: f.id }, text: f.text ?? '', at: new Date(f.planned_at) });
  if (new Date(f.planned_at).getTime() <= services.now().getTime()) await enqueuePublish(services, f);
}

const enqueuePublish = (services: Pick<StudioServices, 'db'>, f: Pick<StoryFrameRow, 'id' | 'studio_id' | 'persona_id'>) =>
  enqueueOnceFor(services.db, { kind: STORY_JOB.publish, key: `story:${f.id}`, payload: { frameId: f.id }, studioId: f.studio_id, personaId: f.persona_id, priority: 60 }, { ever: true });

/** A story frame that missed its day by this much is skipped rather than posted late. */
export const STORY_LATE_MS = 18 * 3_600_000;

/**
 * Queues the publish of every approved frame whose time has come (the stories.publish_due schedule, every 5 min), and
 * skips frames that are too late to post. Nothing is queued ahead of time, so a re-planned or paused day leaves no
 * stale jobs behind.
 */
export async function queueDueStories(services: StudioServices, now: Date = services.now()): Promise<{ queued: number; skipped: number }> {
  // The reason says what actually happened: the last publish failure or hold when there was one.
  const late = await services.db.query<{ id: string }>(
    `UPDATE story_frame f SET status = 'skipped', updated_at = now(),
            block_reason = COALESCE(
              (SELECT 'not posted within its day: ' || string_agg(sp.platform || ': ' || COALESCE(sp.reason, sp.status), '; ')
                 FROM story_post sp WHERE sp.story_frame_id = f.id AND sp.status IN ('failed','blocked')),
              'missed its day (not posted late)')
      WHERE f.status IN ('approved','awaiting_approval','planned') AND f.planned_at < $1 RETURNING f.id`,
    [new Date(now.getTime() - STORY_LATE_MS)],
  );
  const due = await services.db.query<StoryFrameRow>(`SELECT * FROM story_frame WHERE status = 'approved' AND planned_at <= $1 ORDER BY planned_at LIMIT 200`, [now]);
  let queued = 0;
  for (const f of due) if (await enqueuePublish(services, f)) queued += 1;
  await reverifyStories(services, now).catch(() => undefined);
  return { queued, skipped: late.length };
}

/** The Owner releases a frame held for approval (Gate amber, or an L0 persona). A red or failed-QC frame stays blocked. */
export async function approveStoryFrame(services: StudioServices, frameId: string, actor: Actor): Promise<StoryFrameRow> {
  if (actor.type !== 'owner') throw new Error('only the Owner approves a held story frame');
  const f = await services.db.maybeOne<StoryFrameRow>(`UPDATE story_frame SET status = 'approved', block_reason = NULL, updated_at = now(), meta = meta || $2::jsonb WHERE id = $1 AND status = 'awaiting_approval' RETURNING *`, [
    frameId,
    json({ approved_by: actorRef(actor) }),
  ]);
  if (!f) throw new Error('that frame is not waiting for approval');
  await audit(services.db, { studioId: f.studio_id, personaId: f.persona_id, actor, action: 'stories.frame_approved', entityType: 'story_frame', entityId: f.id });
  await approved(services, f);
  return f;
}

// ───────────────────────────── Publish ─────────────────────────────

export interface StoryPublishResult {
  readonly frameId: string;
  readonly results: ReadonlyArray<{ platform: Platform; status: 'published' | 'processing' | 'unsupported' | 'blocked' | 'failed'; externalId?: string | null; reason?: string }>;
}

/** How long a story publish that a kill switch or a missing AI profile label holds waits before it is tried again. */
export const STORY_BLOCK_RETRY_MS = 3_600_000;

type StoryPostStatus = StoryPublishResult['results'][number]['status'];

/** A verify result for a story: live with the AI label → published; live without it or failed → failed; else processing. */
function storyVerdict(v: { status: 'live' | 'processing' | 'failed'; aiLabel: boolean }): { status: 'published' | 'processing' | 'failed'; reason: string | null } {
  if (v.status === 'live' && v.aiLabel) return { status: 'published', reason: null };
  if (v.status === 'live') return { status: 'failed', reason: 'went up without the platform AI label' };
  if (v.status === 'failed') return { status: 'failed', reason: 'the platform reports the story failed' };
  return { status: 'processing', reason: null };
}

async function notifyStoryFailed(services: Pick<StudioServices, 'db'>, f: Pick<StoryFrameRow, 'studio_id' | 'persona_id'>, platform: Platform, reason: string): Promise<void> {
  await notify(services.db, {
    studioId: f.studio_id,
    personaId: f.persona_id,
    kind: 'publish',
    severity: 'warn',
    title: `A ${platform} story failed verification`,
    body: `It ${reason}, so it is marked failed.`,
    link: '/pipeline',
  });
}

/**
 * Publishes an approved frame as kind 'story' to every platform whose story capability is on and where the persona has
 * an active account with its AI profile label on, after core's kill-switch check, AI flag on, idempotent per
 * (frame, platform). Each publish is verified like a feed post: a story the platform shows without the AI label is
 * marked failed and the Owner is told. A publish error is thrown back to the queue (retried with backoff; the per-platform
 * check skips platforms already done); a kill-switch or AI-label hold defers the job. Past STORY_LATE_MS nothing is
 * retried and an unposted frame is skipped with the last reason.
 */
export async function publishStoryFrame(services: StudioServices, frameId: string): Promise<StoryPublishResult> {
  const f = await services.db.one<StoryFrameRow>('SELECT * FROM story_frame WHERE id = $1', [frameId]);
  if (f.status !== 'approved' && f.status !== 'published') return { frameId, results: [] };
  const pub = services.providers.publish;
  const caps = pub.storyCapabilities ? await pub.storyCapabilities() : [];
  const results: Array<StoryPublishResult['results'][number]> = [];
  const accounts = await services.db.query<{ platform: Platform; handle: string; token_ref: string | null; ai_label_ok: boolean | null }>(
    `SELECT platform, handle, token_ref, ai_label_ok FROM account WHERE persona_id = $1 AND status = 'active' AND platform IN ('instagram','tiktok','youtube','pinterest') ORDER BY created_at`,
    [f.persona_id],
  );
  const record = async (platform: Platform, status: StoryPostStatus, externalId: string | null, reason: string | null) => {
    await services.db.query(
      `INSERT INTO story_post (story_frame_id, persona_id, platform, status, external_id, reason, published_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (story_frame_id, platform) DO UPDATE SET status = EXCLUDED.status, external_id = COALESCE(EXCLUDED.external_id, story_post.external_id), reason = EXCLUDED.reason, published_at = COALESCE(story_post.published_at, EXCLUDED.published_at)`,
      [f.id, f.persona_id, platform, status, externalId, reason, status === 'published' || status === 'processing' ? services.now() : null],
    );
    results.push({ platform, status, externalId, ...(reason ? { reason } : {}) });
  };
  // Publish errors worth retrying (a 5xx or a timeout); a story that verified without the AI label is final.
  const retryable: string[] = [];
  for (const a of accounts) {
    // 'failed' is final only when verification failed it (the story is up): retrying would re-post nothing new.
    const done = await services.db.maybeOne<{ status: string }>(
      `SELECT status FROM story_post WHERE story_frame_id = $1 AND platform = $2 AND (status IN ('published','processing','unsupported') OR (status = 'failed' AND external_id IS NOT NULL))`,
      [f.id, a.platform],
    );
    if (done) continue;
    if (!caps.some((c) => c.platform === a.platform && c.stories)) {
      await record(a.platform, 'unsupported', null, 'the publishing API has no Stories for this platform');
      continue;
    }
    try {
      await assertCanPublish(services.db, f.persona_id, a.platform);
    } catch (err) {
      if (err instanceof PublishBlockedError) {
        await record(a.platform, 'blocked', null, err.message);
        continue;
      }
      throw err;
    }
    if (a.ai_label_ok === false) {
      await record(a.platform, 'blocked', null, `the AI profile label is off on @${a.handle}: turn it on before anything posts there`);
      continue;
    }
    if (!f.media_url) {
      await record(a.platform, 'failed', null, 'no rendered frame');
      continue;
    }
    let r: Awaited<ReturnType<typeof pub.publish>>;
    try {
      const vendorRef = a.token_ref && !a.token_ref.startsWith('vault:') ? a.token_ref : null;
      r = await pub.publish({ accountRef: vendorRef ?? a.handle, platform: a.platform, mediaUrls: [f.media_url], caption: '', aiLabel: true, kind: 'story', idempotencyKey: `story:${f.id}:${a.platform}` });
    } catch (err) {
      const reason = err instanceof Error ? err.message.slice(0, 300) : String(err);
      // A permanent refusal (the publisher's own rules) is held like a block, never fast-retried.
      if (isPublishRefused(err)) {
        await record(a.platform, 'blocked', null, reason);
        continue;
      }
      await record(a.platform, 'failed', null, reason);
      retryable.push(`${a.platform}: ${reason}`);
      continue;
    }
    // Verify like a feed post: published only once the platform shows it with the AI label.
    let verdict: { status: 'published' | 'processing' | 'failed'; reason: string | null } = { status: 'processing', reason: null };
    try {
      verdict = storyVerdict(await pub.verify(r.externalId));
    } catch {
      // Up but unconfirmed: it stays 'processing' and reverifyStories() checks it again.
    }
    await record(a.platform, verdict.status, r.externalId, verdict.reason);
    if (verdict.status === 'failed') await notifyStoryFailed(services, f, a.platform, verdict.reason ?? 'failed');
  }
  const any = results.some((r) => r.status === 'published' || r.status === 'processing');
  if (any) await services.db.query(`UPDATE story_frame SET status = 'published', updated_at = now() WHERE id = $1`, [f.id]);
  else if (results.length && results.every((r) => r.status === 'unsupported' || r.status === 'blocked')) {
    await services.db.query(`UPDATE story_frame SET block_reason = $2, updated_at = now() WHERE id = $1`, [f.id, results.map((r) => `${r.platform}: ${r.reason}`).join('; ').slice(0, 500)]);
  } else if (!accounts.length) {
    await services.db.query(`UPDATE story_frame SET block_reason = 'no active account to post to', updated_at = now() WHERE id = $1`, [f.id]);
  }
  const late = services.now().getTime() - new Date(f.planned_at).getTime() > STORY_LATE_MS;
  const blocked = results.filter((r) => r.status === 'blocked');
  if (late) {
    if (!any && f.status === 'approved' && (retryable.length || blocked.length)) {
      const why = [...retryable, ...blocked.map((b) => `${b.platform}: ${b.reason}`)].join('; ');
      await services.db.query(`UPDATE story_frame SET status = 'skipped', block_reason = $2, updated_at = now() WHERE id = $1 AND status = 'approved'`, [f.id, `not posted within its day: ${why}`.slice(0, 500)]);
    }
    return { frameId, results };
  }
  if (retryable.length) throw new Error(`story publish failed (retrying): ${retryable.join('; ')}`.slice(0, 500));
  if (blocked.length) throw new DeferJob(STORY_BLOCK_RETRY_MS, `story publish held: ${blocked.map((b) => `${b.platform}: ${b.reason}`).join('; ')}`.slice(0, 500));
  return { frameId, results };
}

/**
 * Re-verifies stories left 'processing' (verify threw or the platform was still processing) while they are live
 * (24 h): live with the AI label → published; without it, or failed → failed and the Owner is told.
 */
export async function reverifyStories(services: StudioServices, now: Date = services.now(), limit = 25): Promise<{ published: number; failed: number }> {
  const rows = await services.db.query<{ id: string; platform: Platform; external_id: string; studio_id: string; persona_id: string }>(
    `SELECT sp.id, sp.platform, sp.external_id, f.studio_id, f.persona_id FROM story_post sp JOIN story_frame f ON f.id = sp.story_frame_id
      WHERE sp.status = 'processing' AND sp.external_id IS NOT NULL AND sp.published_at >= $1 ORDER BY sp.published_at LIMIT $2`,
    [new Date(now.getTime() - DAY_MS), limit],
  );
  const out = { published: 0, failed: 0 };
  for (const r of rows) {
    let v: ReturnType<typeof storyVerdict>;
    try {
      v = storyVerdict(await services.providers.publish.verify(r.external_id));
    } catch {
      continue;
    }
    if (v.status === 'processing') continue;
    const moved = await services.db.query(`UPDATE story_post SET status = $2, reason = $3 WHERE id = $1 AND status = 'processing' RETURNING id`, [r.id, v.status, v.reason]);
    if (!moved.length) continue;
    if (v.status === 'published') out.published += 1;
    else {
      out.failed += 1;
      await notifyStoryFailed(services, r, r.platform, v.reason ?? 'failed');
    }
  }
  return out;
}

// ───────────────────────────── Metrics ─────────────────────────────

/** Pulls story metrics for frames published in the last 2 days (a story lives 24 h). Idempotent per capture day. */
export async function ingestStoryMetrics(services: StudioServices, opts: { personaId?: string; now?: Date } = {}): Promise<{ captured: number; errors: number }> {
  const now = opts.now ?? services.now();
  const fetch = services.providers.publish.fetchStoryMetrics?.bind(services.providers.publish);
  if (!fetch) return { captured: 0, errors: 0 };
  const posts = await services.db.query<{ id: string; story_frame_id: string; persona_id: string; platform: Platform; external_id: string }>(
    `SELECT id, story_frame_id, persona_id, platform, external_id FROM story_post
      WHERE status IN ('published','processing') AND external_id IS NOT NULL AND published_at >= $1 AND ($2::uuid IS NULL OR persona_id = $2)
      ORDER BY published_at LIMIT 500`,
    [new Date(now.getTime() - 2 * DAY_MS), opts.personaId ?? null],
  );
  let captured = 0;
  let errors = 0;
  for (const p of posts) {
    try {
      const m = await fetch({ externalId: p.external_id, platform: p.platform });
      await services.db.query(
        `INSERT INTO story_metric (story_post_id, story_frame_id, persona_id, platform, captured_on, reach, replies, taps_forward, taps_back, exits)
         VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9, $10)
         ON CONFLICT (story_post_id, captured_on) DO UPDATE SET reach = EXCLUDED.reach, replies = EXCLUDED.replies, taps_forward = EXCLUDED.taps_forward,
           taps_back = EXCLUDED.taps_back, exits = EXCLUDED.exits, created_at = now()`,
        [p.id, p.story_frame_id, p.persona_id, p.platform, isoDate(now), m.reach, m.replies, m.tapsForward, m.tapsBack, m.exits],
      );
      captured += 1;
    } catch {
      errors += 1;
    }
  }
  return { captured, errors };
}

export interface StoryKindStats {
  kind: StoryFrameKind;
  frames: number;
  reach: number;
  replies: number;
  tapsForward: number;
  exits: number;
  /** Replies per 100 reached. */
  replyRate: number;
  /** Exits + taps forward per reached viewer (lower is better). */
  dropRate: number;
}

/** Story results per frame kind over the last `days` (latest capture per post). */
export async function storyStats(services: Pick<StudioServices, 'db'>, personaId: string, now: Date, days = 14): Promise<StoryKindStats[]> {
  const rows = await services.db.query<{ kind: StoryFrameKind; frames: number; reach: number; replies: number; tf: number; exits: number }>(
    `WITH latest AS (
       SELECT DISTINCT ON (m.story_post_id) m.* FROM story_metric m WHERE m.persona_id = $1 AND m.captured_on >= $2::date ORDER BY m.story_post_id, m.captured_on DESC)
     SELECT f.kind, count(DISTINCT f.id)::int AS frames, COALESCE(sum(l.reach), 0)::int AS reach, COALESCE(sum(l.replies), 0)::int AS replies,
            COALESCE(sum(l.taps_forward), 0)::int AS tf, COALESCE(sum(l.exits), 0)::int AS exits
       FROM latest l JOIN story_frame f ON f.id = l.story_frame_id GROUP BY f.kind`,
    [personaId, isoDate(new Date(now.getTime() - days * DAY_MS))],
  );
  return rows.map((r) => ({
    kind: r.kind,
    frames: r.frames,
    reach: r.reach,
    replies: r.replies,
    tapsForward: r.tf,
    exits: r.exits,
    replyRate: r.reach ? Math.round((r.replies / r.reach) * 10000) / 100 : 0,
    dropRate: r.reach ? Math.round(((r.exits + r.tf) / r.reach) * 1000) / 1000 : 0,
  }));
}

