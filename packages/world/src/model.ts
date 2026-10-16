import { createHash } from 'node:crypto';
import type { CountryCode } from './geo';
import type { LocalEvent } from './holidays';

/** The World Bible and storyline shapes stream J owns (WorldDraft.bible / WorldDraft.storyline hold these). */

export type Gender = 'f' | 'm' | 'n';

export interface CastMember {
  readonly name: string;
  /** e.g. 'sister', 'neighbour', 'granddaughter', 'dog'. */
  readonly relation: string;
  readonly gender: Gender;
  readonly age: number | null;
  readonly traits: string;
  /** How they show up in the content. */
  readonly role: string;
}

export interface RecurringPlace {
  readonly name: string;
  readonly kind: 'home' | 'shop' | 'outdoors' | 'social' | 'work' | 'transport' | 'other';
  readonly description: string;
}

export interface WorldBible {
  readonly self: { readonly name: string; readonly age: number | null; readonly accent: string; readonly era: number | null; readonly background: string };
  readonly place: {
    readonly city: string;
    readonly region: string | null;
    readonly country: string;
    readonly countryCode: CountryCode;
    readonly timezone: string;
    readonly lat: number | null;
    readonly lon: number | null;
    readonly neighbourhood: string;
    readonly janC: number;
    readonly julC: number;
  };
  readonly home: { readonly dwelling: string; readonly layout: string; readonly details: readonly string[] };
  readonly recurringPlaces: readonly RecurringPlace[];
  readonly cast: readonly CastMember[];
  readonly routine: { readonly daily: readonly string[]; readonly weekly: readonly string[] };
  /** Typical weather and light per season (sunrise / sunset at the solstices). */
  readonly seasons: Readonly<Record<'winter' | 'spring' | 'summer' | 'autumn', string>>;
  readonly holidays: readonly string[];
  readonly localEvents: readonly LocalEvent[];
  readonly localLife: { readonly currency: string; readonly typicalPrices: readonly string[]; readonly shops: readonly string[]; readonly commute: string };
}

export type BeatKind = 'setup' | 'development' | 'gag' | 'callback' | 'cliffhanger' | 'payoff' | 'milestone';
export const BEAT_KINDS: readonly BeatKind[] = ['setup', 'development', 'gag', 'callback', 'cliffhanger', 'payoff', 'milestone'];

export interface StoryBeat {
  readonly id: string;
  /** Arc week, 1-based. */
  readonly week: number;
  readonly kind: BeatKind;
  readonly text: string;
}

export interface StoryChapter {
  readonly id: string;
  readonly title: string;
  readonly weeks: readonly [number, number];
  readonly tension: string;
  readonly payoff: string;
  readonly subplots: readonly string[];
  readonly beats: readonly StoryBeat[];
}

export interface Storyline {
  readonly season: number;
  readonly title: string;
  readonly premise: string;
  readonly weeks: number;
  readonly chapters: readonly StoryChapter[];
  readonly runningGags: readonly string[];
  readonly callbacks: readonly string[];
  readonly milestones: readonly string[];
}

export const ARC_WEEKS = 12;

export const hashInt = (s: string): number => parseInt(createHash('sha256').update(s).digest('hex').slice(0, 8), 16);
export function pickFrom<T>(list: readonly T[], seed: string): T {
  return list[hashInt(seed) % list.length]!;
}

// ─── Validation of edited / model-written shapes (lenient: keep what is valid, fall back for the rest) ───

const str = (v: unknown, max = 400): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const strs = (v: unknown, max = 12, len = 200): string[] => (Array.isArray(v) ? v.map((x) => str(x, len)).filter((x): x is string => !!x).slice(0, max) : []);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);

export const GENDER_OF: Readonly<Record<string, Gender>> = {
  sister: 'f', brother: 'm', mum: 'f', mom: 'f', mother: 'f', dad: 'm', father: 'm', husband: 'm', wife: 'f', son: 'm', daughter: 'f',
  grandson: 'm', granddaughter: 'f', nan: 'f', nana: 'f', gran: 'f', grandma: 'f', granny: 'f', grandmother: 'f', grandad: 'm', granddad: 'm', grandpa: 'm', grandfather: 'm',
  aunt: 'f', auntie: 'f', aunty: 'f', uncle: 'm', niece: 'f', nephew: 'm', cousin: 'n', neighbour: 'n', neighbor: 'n', friend: 'n', boss: 'n', partner: 'n',
  flatmate: 'n', roommate: 'n', coworker: 'n', colleague: 'n', dog: 'n', cat: 'n', 'best friend': 'n', girlfriend: 'f', boyfriend: 'm', 'son-in-law': 'm', 'daughter-in-law': 'f',
  'late husband': 'm', 'late wife': 'f', stepson: 'm', stepdaughter: 'f', godson: 'm', goddaughter: 'f', landlord: 'm', landlady: 'f',
};

export function parseCast(v: unknown, fallback: readonly CastMember[]): CastMember[] {
  if (!Array.isArray(v)) return [...fallback];
  const out: CastMember[] = [];
  for (const raw of v.slice(0, 12)) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const name = str(o.name, 60);
    const relation = str(o.relation, 40)?.toLowerCase();
    if (!name || !relation || !/^[A-Z][A-Za-z'-]+(?: [A-Z][A-Za-z'-]+)?$/.test(name)) continue;
    const g = o.gender === 'f' || o.gender === 'm' || o.gender === 'n' ? o.gender : (GENDER_OF[relation] ?? 'n');
    const age = num(o.age);
    out.push({ name, relation, gender: g, age: age !== null && age > 0 && age < 120 ? Math.round(age) : null, traits: str(o.traits, 200) ?? '', role: str(o.role, 200) ?? '' });
  }
  return out.length ? out : [...fallback];
}

export function parsePlaces(v: unknown, fallback: readonly RecurringPlace[]): RecurringPlace[] {
  if (!Array.isArray(v)) return [...fallback];
  const kinds: RecurringPlace['kind'][] = ['home', 'shop', 'outdoors', 'social', 'work', 'transport', 'other'];
  const out = v
    .slice(0, 12)
    .map((raw) => {
      const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      const name = str(o.name, 80);
      if (!name) return null;
      return { name, kind: kinds.includes(o.kind as RecurringPlace['kind']) ? (o.kind as RecurringPlace['kind']) : 'other', description: str(o.description, 240) ?? '' };
    })
    .filter((x): x is RecurringPlace => !!x);
  return out.length ? out : [...fallback];
}

/**
 * Merges an edit (Owner form, chat tool or model output) over a bible. The place's coordinates and timezone are
 * only replaced together with a known place (`placeOverride`), so grounding never runs on a half-edited location.
 */
export function mergeBible(base: WorldBible, patch: Record<string, unknown>): WorldBible {
  const p = patch;
  const home = (p.home && typeof p.home === 'object' ? p.home : {}) as Record<string, unknown>;
  const routine = (p.routine && typeof p.routine === 'object' ? p.routine : {}) as Record<string, unknown>;
  const life = (p.localLife && typeof p.localLife === 'object' ? p.localLife : {}) as Record<string, unknown>;
  const seasons = (p.seasons && typeof p.seasons === 'object' ? p.seasons : {}) as Record<string, unknown>;
  const self = (p.self && typeof p.self === 'object' ? p.self : {}) as Record<string, unknown>;
  const place = (p.place && typeof p.place === 'object' ? p.place : {}) as Record<string, unknown>;
  const events = Array.isArray(p.localEvents)
    ? p.localEvents
        .map((e) => (e && typeof e === 'object' ? (e as Record<string, unknown>) : {}))
        .map((e) => ({ name: str(e.name, 80), month: num(e.month), day: num(e.day) }))
        .filter((e): e is LocalEvent => !!e.name && !!e.month && !!e.day && e.month >= 1 && e.month <= 12 && e.day >= 1 && e.day <= 31)
    : base.localEvents;
  const age = self.age === null ? null : num(self.age);
  return {
    self: {
      name: str(self.name, 80) ?? base.self.name,
      age: self.age === undefined ? base.self.age : age !== null && age > 0 && age < 120 ? Math.round(age) : null,
      accent: str(self.accent, 80) ?? base.self.accent,
      era: base.self.era,
      background: str(self.background, 600) ?? base.self.background,
    },
    place: { ...base.place, neighbourhood: str(place.neighbourhood, 120) ?? base.place.neighbourhood },
    home: { dwelling: str(home.dwelling, 120) ?? base.home.dwelling, layout: str(home.layout, 600) ?? base.home.layout, details: home.details ? strs(home.details, 10) : base.home.details },
    recurringPlaces: p.recurringPlaces ? parsePlaces(p.recurringPlaces, base.recurringPlaces) : base.recurringPlaces,
    cast: p.cast ? parseCast(p.cast, base.cast) : base.cast,
    routine: { daily: routine.daily ? strs(routine.daily, 10) : base.routine.daily, weekly: routine.weekly ? strs(routine.weekly, 10) : base.routine.weekly },
    seasons: {
      winter: str(seasons.winter, 300) ?? base.seasons.winter,
      spring: str(seasons.spring, 300) ?? base.seasons.spring,
      summer: str(seasons.summer, 300) ?? base.seasons.summer,
      autumn: str(seasons.autumn, 300) ?? base.seasons.autumn,
    },
    holidays: p.holidays ? strs(p.holidays, 30, 80) : base.holidays,
    localEvents: events,
    localLife: {
      currency: base.localLife.currency,
      typicalPrices: life.typicalPrices ? strs(life.typicalPrices, 10) : base.localLife.typicalPrices,
      shops: life.shops ? strs(life.shops, 10) : base.localLife.shops,
      commute: str(life.commute, 240) ?? base.localLife.commute,
    },
  };
}

/** Reads a stored bible (jsonb) defensively. */
export function asBible(v: unknown): WorldBible | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Partial<WorldBible>;
  if (!o.place || typeof o.place !== 'object' || !o.self || !Array.isArray(o.cast)) return null;
  return o as WorldBible;
}

export function parseStoryline(v: unknown, fallback: Storyline): Storyline {
  if (!v || typeof v !== 'object') return fallback;
  const o = v as Record<string, unknown>;
  const chapters: StoryChapter[] = [];
  if (Array.isArray(o.chapters)) {
    o.chapters.slice(0, 8).forEach((raw, i) => {
      if (!raw || typeof raw !== 'object') return;
      const c = raw as Record<string, unknown>;
      const title = str(c.title, 120);
      if (!title) return;
      const w = Array.isArray(c.weeks) ? c.weeks.map(num) : [];
      const from = Math.max(1, Math.min(fallback.weeks, Math.round(w[0] ?? i * 3 + 1)));
      const to = Math.max(from, Math.min(fallback.weeks, Math.round(w[1] ?? from + 2)));
      const id = str(c.id, 40) ?? `ch${i + 1}`;
      const beats: StoryBeat[] = [];
      if (Array.isArray(c.beats)) {
        c.beats.slice(0, 12).forEach((b, j) => {
          const bo = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>;
          const text = str(bo.text, 300);
          if (!text) return;
          const week = Math.max(from, Math.min(to, Math.round(num(bo.week) ?? from + Math.floor(j / 2))));
          beats.push({ id: str(bo.id, 40) ?? `${id}-b${j + 1}`, week, kind: BEAT_KINDS.includes(bo.kind as BeatKind) ? (bo.kind as BeatKind) : 'development', text });
        });
      }
      chapters.push({ id, title, weeks: [from, to], tension: str(c.tension, 300) ?? '', payoff: str(c.payoff, 300) ?? '', subplots: strs(c.subplots, 4), beats });
    });
  }
  const beatsTotal = chapters.reduce((n, c) => n + c.beats.length, 0);
  if (chapters.length < 2 || beatsTotal < fallback.weeks) return fallback;
  return {
    season: fallback.season,
    title: str(o.title, 120) ?? fallback.title,
    premise: str(o.premise, 600) ?? fallback.premise,
    weeks: fallback.weeks,
    chapters,
    runningGags: o.runningGags ? strs(o.runningGags, 6) : fallback.runningGags,
    callbacks: o.callbacks ? strs(o.callbacks, 8) : fallback.callbacks,
    milestones: o.milestones ? strs(o.milestones, 8) : fallback.milestones,
  };
}

export function asStoryline(v: unknown): Storyline | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Partial<Storyline>;
  return Array.isArray(o.chapters) && typeof o.title === 'string' ? (o as Storyline) : null;
}
