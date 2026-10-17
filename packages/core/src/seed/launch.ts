import { troupeEnv } from '@troupe/env';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { findRepoRoot } from '@troupe/db';
import type { PostFormat, PostPurpose } from '../types';
import { cleanInline, col, firstUrl, mdToValue, type MdTable, type MdValue, parseTables, slugify, splitSections } from './markdown';

/**
 * The launch personas: the Persona Architect's real documents (bible.md, look-prompts.md, content-plan.md,
 * field-brain-seed.md per persona folder), parsed into what the seed and the `personas.import` job write.
 * The folders live in `packages/knowledge/seed/personas/<slug>/` (synced from the Ventures folder by
 * `pnpm knowledge personas sync`); `manifest.json` next to them pins the fields prose can't give reliably
 * (niche key, timezone, accent hue).
 */

export const LAUNCH_FILES = {
  bible: 'bible.md',
  lookPrompts: 'look-prompts.md',
  contentPlan: 'content-plan.md',
  fieldBrainSeed: 'field-brain-seed.md',
} as const;
export type LaunchDoc = keyof typeof LAUNCH_FILES;

/** Appendix A sections, in the order the profile shows them. Every launch bible gets all of them. */
export const BIBLE_SECTIONS = [
  'identity', 'character_lore', 'worldview', 'expertise_map', 'signature_frameworks', 'positions_on_debates',
  'news_beats', 'audience', 'voice', 'look', 'content_dna', 'engagement_style', 'products', 'community',
  'compliance', 'metrics',
] as const;

const SECTION_MATCHERS: Array<[RegExp, (typeof BIBLE_SECTIONS)[number]]> = [
  [/identity/i, 'identity'],
  [/lore/i, 'character_lore'],
  [/worldview|principles/i, 'worldview'],
  [/expertise/i, 'expertise_map'],
  [/framework/i, 'signature_frameworks'],
  [/debate/i, 'positions_on_debates'],
  [/news/i, 'news_beats'],
  [/audience/i, 'audience'],
  [/^voice/i, 'voice'],
  [/^look|wardrobe/i, 'look'],
  [/content dna/i, 'content_dna'],
  [/engagement/i, 'engagement_style'],
  [/product/i, 'products'],
  [/communit/i, 'community'],
  [/compliance/i, 'compliance'],
  [/kpi|metric|checkpoint/i, 'metrics'],
];

export type ProductRung = 'lead_magnet' | 'entry' | 'addon' | 'core_bundle' | 'upsell' | 'product_2_3' | 'marketplace' | 'membership' | 'course';

export interface LaunchProduct {
  slug: string;
  name: string;
  rung: ProductRung;
  priceCents: number;
  /** Free text from the heading, e.g. "live Thu 5 Nov". */
  note: string | null;
}

export interface LaunchSlot {
  /** Post number in the content plan. */
  n: number;
  /** Local date and time in the persona's timezone. */
  localDate: string;
  localTime: string;
  slotAt: Date;
  format: PostFormat;
  purpose: PostPurpose;
  pillar: string | null;
  title: string;
  hook: string | null;
  cta: string | null;
}

export interface SeedSource {
  /** S1, S2, … as the seed's node tables cite them. */
  ref: string | null;
  name: string;
  url: string | null;
  kind: 'journal' | 'institution' | 'publication' | 'expert' | 'dataset' | 'rss' | 'other';
  credibility: number;
  notes: string | null;
}

export interface SeedFeed {
  name: string;
  /** The URL the News Desk polls (subreddit pages become their .rss feed). */
  url: string;
  /** True when it is an RSS/Atom endpoint; false = a page to watch that the desk can't poll. */
  feed: boolean;
  why: string | null;
}

export interface SeedExpert {
  name: string;
  school: string;
  why: string | null;
}

export interface SeedNode {
  path: string;
  title: string;
  level: 'fundamental' | 'intermediate' | 'advanced' | 'debate' | 'myth' | 'frontier';
  module: string;
  synthesis: string;
  /** Extra seed facts (when the seed has a separate facts column). */
  facts: string | null;
  /** How this persona uses the node ("Rosa use", "Dot's angle"). */
  use: string | null;
  /** Source refs or names cited by the seed row. */
  sourceRefs: string[];
}

export interface FieldBrainSeed {
  title: string;
  sources: SeedSource[];
  feeds: SeedFeed[];
  experts: SeedExpert[];
  nodes: SeedNode[];
}

export interface LaunchPersona {
  slug: string;
  name: string;
  niche: string;
  subNiche: string | null;
  timezone: string;
  hue: number;
  /** YYYY-MM-DD (the persona's first post day). */
  launchDate: string | null;
  handles: Partial<Record<'tiktok' | 'instagram' | 'youtube', string>>;
  looks: string[];
  /** Appendix A sections (+ source_document), ready for persona_bible.content. */
  bible: Record<string, unknown>;
  /** The bible document's own version label, e.g. "v2". */
  bibleLabel: string | null;
  /** sha256 of all four documents: the importer adds a bible version only when this changes. */
  sourceHash: string;
  products: LaunchProduct[];
  slots: LaunchSlot[];
  seasonal: Array<{ date: string; moment: string; play: string }>;
  fieldBrain: FieldBrainSeed;
  dir: string;
}

export interface ManifestEntry {
  name?: string;
  niche?: string;
  subNiche?: string;
  timezone?: string;
  hue?: number;
  products?: LaunchProduct[];
}

// ───────────────────────────── Locating and loading ─────────────────────────────

/**
 * `packages/knowledge/seed/personas` (or TROUPE_PERSONAS_DIR). Resolved at call time from the repo root, so it works
 * the same under tsx, Vitest and a bundled Next server.
 */
export function defaultPersonasDir(): string {
  const configured = troupeEnv('PERSONAS_DIR');
  if (configured) return resolve(configured);
  return join(/*turbopackIgnore: true*/ findRepoRoot(), 'packages', 'knowledge', 'seed', 'personas');
}

// Paths here are only read at run time on the Mac (seed, importer, persona_doc tool); `turbopackIgnore` keeps the
// Next build from tracing the whole repo into the server bundle because of them.

/** Persona folders (those holding a bible.md), sorted by slug. */
export function launchPersonaSlugs(dir = defaultPersonasDir()): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^[a-z0-9][a-z0-9-]*$/.test(name))
    .filter((name) => {
      const p = join(/*turbopackIgnore: true*/ dir, name);
      return statSync(p).isDirectory() && existsSync(join(/*turbopackIgnore: true*/ p, LAUNCH_FILES.bible));
    })
    .sort();
}

export function readManifest(dir = defaultPersonasDir()): Record<string, ManifestEntry> {
  const file = join(/*turbopackIgnore: true*/ dir, 'manifest.json');
  if (!existsSync(file)) return {};
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { personas?: Record<string, ManifestEntry> };
  return raw.personas ?? {};
}

/** Reads one of a launch persona's documents ('' when the file is missing). */
export function readLaunchDoc(slug: string, doc: LaunchDoc, dir = defaultPersonasDir()): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error(`invalid persona slug: ${slug}`);
  const file = join(/*turbopackIgnore: true*/ dir, slug, LAUNCH_FILES[doc]);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

/** Every launch persona in `dir`. Empty when the folder is missing (the seed then keeps the sample personas). */
export function loadLaunchPersonas(dir = defaultPersonasDir()): LaunchPersona[] {
  const manifest = readManifest(dir);
  return launchPersonaSlugs(dir).map((slug) =>
    parseLaunchPersona(
      slug,
      {
        bible: readLaunchDoc(slug, 'bible', dir),
        lookPrompts: readLaunchDoc(slug, 'lookPrompts', dir),
        contentPlan: readLaunchDoc(slug, 'contentPlan', dir),
        fieldBrainSeed: readLaunchDoc(slug, 'fieldBrainSeed', dir),
      },
      manifest[slug] ?? {},
      join(/*turbopackIgnore: true*/ dir, slug),
    ),
  );
}

// ───────────────────────────── Parsing ─────────────────────────────

export function parseLaunchPersona(slug: string, docs: Record<LaunchDoc, string>, m: ManifestEntry = {}, dir = ''): LaunchPersona {
  const bibleDoc = parseBible(docs.bible);
  const headerNiche = parseNiche(bibleDoc.header);
  const niche = (m.niche ?? headerNiche.niche ?? 'general').toLowerCase();
  const timezone = m.timezone ?? guessTimezone(docs.contentPlan);
  const launchDate = parseLaunchDate(bibleDoc.header);
  const year = launchDate ? Number(launchDate.slice(0, 4)) : new Date().getUTCFullYear();
  const sourceHash = createHash('sha256')
    .update([docs.bible, docs.lookPrompts, docs.contentPlan, docs.fieldBrainSeed].join('\n\u0000\n'))
    .digest('hex');
  const name = m.name ?? bibleDoc.name ?? slug;
  const bible = {
    ...bibleDoc.sections,
    source_document: {
      file: `${slug}/${LAUNCH_FILES.bible}`,
      version: bibleDoc.label ?? 'v1',
      sha256: sourceHash.slice(0, 16),
      also: [LAUNCH_FILES.lookPrompts, LAUNCH_FILES.contentPlan, LAUNCH_FILES.fieldBrainSeed],
    },
  };
  return {
    slug,
    name,
    niche,
    subNiche: m.subNiche ?? headerNiche.subNiche,
    timezone,
    hue: m.hue ?? hueFor(slug),
    launchDate,
    handles: parseHandles(bibleDoc.raw.identity ?? ''),
    looks: parseLooks(bibleDoc.raw.look ?? ''),
    bible,
    bibleLabel: bibleDoc.label,
    sourceHash,
    products: m.products ?? parseProducts(bibleDoc.raw.products ?? ''),
    slots: parseContentPlan(docs.contentPlan, { year, timezone }),
    seasonal: parseSeasonal(bibleDoc.raw.products ?? ''),
    fieldBrain: parseFieldBrainSeed(docs.fieldBrainSeed),
    dir,
  };
}

interface ParsedBible {
  name: string | null;
  label: string | null;
  header: string;
  sections: Record<string, MdValue>;
  /** Raw Markdown per Appendix A key (wardrobe appended to look). */
  raw: Partial<Record<(typeof BIBLE_SECTIONS)[number], string>>;
}

export function parseBible(md: string): ParsedBible {
  const h1 = /^#\s+(.+?)\s*$/m.exec(md)?.[1] ?? '';
  const name = /^(.+?):\s*Persona Bible/i.exec(h1)?.[1]?.trim() ?? (h1 ? h1.split(':')[0]!.trim() : null);
  const label = /\bv(\d+(?:\.\d+)?)\b/i.exec(h1)?.[0] ?? null;
  const { intro, sections } = splitSections(md, 2);
  const header = intro.replace(/^#\s+.+$/m, '').trim();
  const raw: ParsedBible['raw'] = {};
  const extras: Record<string, MdValue> = {};
  for (const s of sections) {
    const title = s.title.replace(/^\d+(\.\d+)?\.?\s+/, '').trim();
    const key = SECTION_MATCHERS.find(([re]) => re.test(title))?.[1];
    if (!key) {
      extras[cleanInline(title)] = mdToValue(s.body);
      continue;
    }
    const body = /wardrobe/i.test(title) ? `### ${cleanInline(title)}\n\n${s.body}` : s.body;
    raw[key] = raw[key] ? `${raw[key]}\n\n${body}` : body;
  }
  const out: Record<string, MdValue> = {};
  for (const key of BIBLE_SECTIONS) {
    const v = raw[key] ? mdToValue(raw[key]!) : '';
    if (key === 'identity' && header) {
      const summary = mdToValue(header);
      out.identity = v && typeof v === 'object' && !Array.isArray(v) ? { summary, ...v } : { summary, details: v };
    } else {
      out[key] = v;
    }
  }
  if (Object.keys(extras).length) out.revision_notes = extras;
  return { name, label, header, sections: out, raw };
}

export function parseNiche(header: string): { niche: string | null; subNiche: string | null } {
  const line = /\*\*(?:Niche|Bucket):\*\*\s*([^\n·]+)/i.exec(header)?.[1];
  if (!line) return { niche: null, subNiche: null };
  const text = cleanInline(line).replace(/\.$/, '');
  const paren = /^([^(:]+?)\s*\(([^)]+)\)/.exec(text);
  if (paren) return { niche: paren[1]!.trim().toLowerCase(), subNiche: paren[2]!.trim() };
  const colon = /^([^:]+?):\s*(.+)$/.exec(text);
  if (colon) return { niche: colon[1]!.trim().toLowerCase(), subNiche: colon[2]!.trim() };
  return { niche: text.toLowerCase(), subNiche: null };
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n: number) => String(n).padStart(2, '0');

export function parseLaunchDate(header: string): string | null {
  const m = /\*\*Launch:\*\*\s*(?:[A-Za-z]{3}\s+)?(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/i.exec(header);
  if (!m) return null;
  const month = MONTHS[m[2]!.toLowerCase()];
  return month ? `${m[3]}-${pad(month)}-${pad(Number(m[1]))}` : null;
}

function guessTimezone(plan: string): string {
  const uk = (plan.match(/\(UK\)|\bUK\)|time \(UK|UK time/g) ?? []).length;
  const et = (plan.match(/\bET\b/g) ?? []).length;
  return uk > et ? 'Europe/London' : 'America/New_York';
}

function hueFor(slug: string): number {
  return parseInt(createHash('sha256').update(slug).digest('hex').slice(0, 4), 16) % 360;
}

export function parseHandles(identity: string): LaunchPersona['handles'] {
  const out: LaunchPersona['handles'] = {};
  for (const t of parseTables(identity)) {
    const platformCol = col(t.header, /platform/i);
    if (platformCol < 0) continue;
    const optionCol = col(t.header, /option\s*1|pick|preferred|handle/i);
    const c = optionCol >= 0 ? optionCol : platformCol + 1;
    for (const r of t.rows) {
      const platform = cleanInline(r[platformCol] ?? '').toLowerCase();
      const key = platform.startsWith('instagram') ? 'instagram' : platform.startsWith('tiktok') ? 'tiktok' : platform.startsWith('youtube') ? 'youtube' : null;
      if (!key || out[key]) continue;
      const handle = cleanInline(r[c] ?? '').split(/\s|\(/)[0]!.replace(/^@/, '').replace(/^\//, '');
      if (handle && /^[A-Za-z0-9._-]{2,40}$/.test(handle)) out[key] = handle;
    }
  }
  return out;
}

const titleCase = (s: string) => (s === s.toUpperCase() ? s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : s);

export function parseLooks(look: string): string[] {
  const wardrobe = splitSections(look, 3).sections.find((s) => /wardrobe/i.test(s.title))?.body ?? look;
  for (const t of parseTables(wardrobe)) {
    const c = col(t.header, /look|outfit|name/i);
    if (c < 0) continue;
    const names = t.rows
      .map((r) => cleanInline(r[c] ?? '').replace(/\s*\((?:default|[^)]*)\)\s*$/i, '').trim())
      .filter((s) => s && s.length <= 60);
    if (names.length) return names.slice(0, 6);
  }
  // Numbered outfits: "1. **SERVICE LILAC (signature; …)**".
  const listed = [...wardrobe.matchAll(/^\s*\d+[.)]\s+\*\*([^*(]+)/gm)].map((m) => titleCase(m[1]!.trim()));
  if (listed.length) return listed.slice(0, 6);
  return ['Main look', 'Second look', 'Third look'];
}

const RUNG_RULES: Array<[RegExp, ProductRung]> = [
  [/lead magnet|\bfree\b|rung 0/i, 'lead_magnet'],
  [/monthly|membership|community|subscription|rung 3|\/mo\b|a month/i, 'membership'],
  [/order bump|add-?on|bump/i, 'addon'],
  [/upsell/i, 'upsell'],
  [/course/i, 'course'],
  [/system|bundle|core|rung 2|flagship/i, 'core_bundle'],
  [/first product|entry|rung 1|product 1/i, 'entry'],
];

const SKIP_PRODUCT = /seasonal calendar|^calendar|qa rule|cross-sell|lane border|bundles, bumps|pipeline|deliver|refund|guarantee/i;

/** Parses the `### …` product headings of the bible's products section ("### First product ($17): **Name**"). */
export function parseProducts(products: string): LaunchProduct[] {
  const out: LaunchProduct[] = [];
  const seen = new Set<string>();
  for (const s of splitSections(products, 3).sections) {
    const heading = s.title;
    if (SKIP_PRODUCT.test(heading)) continue;
    const rung = RUNG_RULES.find(([re]) => re.test(heading))?.[1];
    if (!rung) continue;
    const add = (name: string, price: number, note: string | null) => {
      const clean = cleanInline(name).replace(/\s*\([^)]*\)\s*$/, '').replace(/[.:;,]+$/, '').trim();
      if (!clean || clean.length > 90) return;
      const slug = slugify(clean, 48);
      if (seen.has(slug)) return;
      seen.add(slug);
      out.push({ slug, name: clean, rung, priceCents: price, note });
    };
    if (rung === 'lead_magnet') {
      // Several free magnets can sit in one table (bold names in the first column).
      const table = parseTables(s.body).find((t) => /magnet|name|product/i.test(t.header[0] ?? ''));
      if (table) {
        for (const r of table.rows) add((/\*\*([^*]+)\*\*/.exec(r[0] ?? '')?.[1] ?? r[0] ?? ''), 0, null);
        if (table.rows.length) continue;
      }
    }
    const bold = /\*\*([^*]+)\*\*/.exec(heading)?.[1];
    const afterColon = heading.includes(':') ? heading.slice(heading.indexOf(':') + 1) : heading;
    let name = bold ?? afterColon;
    // A generic heading ("Rung 0: Lead magnet (free)") names the product in the first bold line of the body.
    if (/^\s*(lead magnet|first product|product|system|monthly drop)\b[^a-z]*$/i.test(cleanInline(name).replace(/\([^)]*\)/g, ''))) {
      const first = /^\*\*([^*]+)\*\*/m.exec(s.body)?.[1];
      if (first) name = first.replace(/^[^:"“]*:\s*/, '').replace(/["“”]/g, '');
    }
    const body = cleanInline(s.body);
    const price =
      /\$(\d+(?:\.\d{1,2})?)/.exec(heading) ??
      /\bprice\b[^$]{0,40}\$(\d+(?:\.\d{1,2})?)/i.exec(body) ??
      /\$(\d+(?:\.\d{1,2})?)/.exec(body.slice(0, 400));
    const priceCents = rung === 'lead_magnet' ? 0 : price ? Math.round(Number(price[1]) * 100) : 0;
    const note = /\(([^)]*\b(?:live|launch|from|opens?)\b[^)]*)\)/i.exec(heading)?.[1] ?? null;
    add(name, priceCents, note ? cleanInline(note) : null);
  }
  return out;
}

export function parseSeasonal(products: string): LaunchPersona['seasonal'] {
  for (const t of parseTables(products)) {
    const d = col(t.header, /^date|when/i);
    const mo = col(t.header, /moment/i);
    if (d < 0 || mo < 0) continue;
    const rest = t.header.map((_, i) => i).filter((i) => i !== d && i !== mo);
    return t.rows.slice(0, 40).map((r) => ({
      date: cleanInline(r[d] ?? ''),
      moment: cleanInline(r[mo] ?? ''),
      play: rest.map((i) => cleanInline(r[i] ?? '')).filter((x) => x && x !== '—' && x !== 'n/a').join(' · '),
    }));
  }
  return [];
}

// ───────────────────────────── Content plan → calendar slots ─────────────────────────────

const FORMAT_RULES: Array<[RegExp, PostFormat]> = [
  [/carousel|^c$/i, 'carousel'],
  [/static|^s$/i, 'static'],
  [/voice|^v$|^vo$/i, 'voiceover'],
  [/activity|^a$/i, 'activity_text'],
  [/talk|^t$/i, 'talking'],
];

export function parseFormat(cell: string): PostFormat | null {
  const c = cleanInline(cell).trim();
  return FORMAT_RULES.find(([re]) => re.test(c))?.[1] ?? null;
}

export function parsePurpose(cell: string): PostPurpose | null {
  const c = cleanInline(cell);
  if (/sell/i.test(c)) return 'sell';
  if (/trust/i.test(c)) return 'trust';
  if (/reach/i.test(c)) return 'reach';
  return null;
}

/** UTC instant of a wall-clock time in `timeZone`. */
export function zonedTimeToUtc(y: number, mo: number, d: number, h: number, mi: number, timeZone: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const offsetAt = (ms: number) => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
        .formatToParts(new Date(ms))
        .map((p) => [p.type, p.value]),
    );
    const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
    return asUtc - ms;
  };
  let ts = guess - offsetAt(guess);
  ts = guess - offsetAt(ts);
  return new Date(ts);
}

/** "Sun 1 Nov · 8:00 pm", "Thu 5 Nov 20:00 (15:00 ET)", "Sun 1 Nov · 12:30 ET" → date + 24 h time. */
export function parseSlotWhen(cell: string, year: number): { date: string; time: string | null } | null {
  const text = cleanInline(cell);
  const dm = /(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*/i.exec(text);
  if (!dm) return null;
  const month = MONTHS[dm[2]!.toLowerCase()]!;
  const date = `${year}-${pad(month)}-${pad(Number(dm[1]))}`;
  const after = text.slice(dm.index + dm[0].length);
  const tm = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(after);
  if (!tm || (!tm[2] && !tm[3])) return { date, time: null };
  let h = Number(tm[1]);
  const mi = Number(tm[2] ?? 0);
  const ap = tm[3]?.toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || mi > 59) return { date, time: null };
  return { date, time: `${pad(h)}:${pad(mi)}` };
}

const unquote = (s: string) => s.replace(/^["“'‘]+|["”'’]+$/g, '').trim();

export function parseContentPlan(md: string, opts: { year: number; timezone: string }): LaunchSlot[] {
  const slots: LaunchSlot[] = [];
  const seen = new Set<number>();
  const tables: MdTable[] = parseTables(md).filter((t) => col(t.header, /format/i) >= 0 && col(t.header, /purpose/i) >= 0 && col(t.header, /date|slot|when/i) >= 0);
  for (const t of tables) {
    const cNum = col(t.header, /^#$|^post|^no\.?$/i);
    const cDate = col(t.header, /date|slot|when/i);
    const cFormat = col(t.header, /format/i);
    const cPurpose = col(t.header, /purpose/i);
    const cSeries = col(t.header, /series/i);
    const cPillar = col(t.header, /pillar/i);
    const cHook = col(t.header, /hook/i);
    const cCta = col(t.header, /cta/i);
    for (const r of t.rows) {
      const n = Number(/\d+/.exec(cleanInline(r[cNum >= 0 ? cNum : 0] ?? ''))?.[0] ?? NaN);
      if (!Number.isFinite(n) || seen.has(n)) continue;
      const when = parseSlotWhen(r[cDate] ?? '', opts.year);
      const format = parseFormat(r[cFormat] ?? '');
      const purpose = parsePurpose(r[cPurpose] ?? '');
      if (!when || !format || !purpose) continue;
      seen.add(n);
      const hook = cHook >= 0 ? unquote(cleanInline(r[cHook] ?? '')) || null : null;
      const series = cSeries >= 0 ? cleanInline(r[cSeries] ?? '') : '';
      const inFormat = /\(([^)]*)\)/.exec(cleanInline(r[cFormat] ?? ''))?.[1]?.replace(/\b(?:pinned|launch|origin|pinned origin)\b/gi, '').trim();
      const pillar = series || (cPillar >= 0 ? `Pillar ${cleanInline(r[cPillar] ?? '')}` : '') || (inFormat && !/slides|\d+:\d+/.test(inFormat) ? inFormat : '') || null;
      const cta = cCta >= 0 ? (/[A-Z]{3,}/.exec(cleanInline(r[cCta] ?? ''))?.[0] ?? null) : null;
      const title = (hook ?? series ?? `Post ${n}`).slice(0, 160);
      slots.push({ n, localDate: when.date, localTime: when.time ?? '', slotAt: new Date(0), format, purpose, pillar, title, hook, cta });
    }
  }
  // Rows without a time: one post that day at 19:30, two at 12:30 and 19:30 (the plans' stated defaults).
  const byDay = new Map<string, LaunchSlot[]>();
  for (const s of slots) byDay.set(s.localDate, [...(byDay.get(s.localDate) ?? []), s]);
  for (const day of byDay.values()) {
    const untimed = day.filter((s) => !s.localTime);
    untimed.forEach((s, i) => (s.localTime = untimed.length > 1 && i === 0 ? '12:30' : '19:30'));
  }
  for (const s of slots) {
    const [y, mo, d] = s.localDate.split('-').map(Number) as [number, number, number];
    const [h, mi] = s.localTime.split(':').map(Number) as [number, number];
    s.slotAt = zonedTimeToUtc(y, mo, d, h, mi, opts.timezone);
  }
  return slots.sort((a, b) => a.n - b.n);
}

// ───────────────────────────── Field Brain seed ─────────────────────────────

export function credibilityScore(text: string): number {
  const t = cleanInline(text);
  const letter = /(?:^|[\s(*])([A-D])(?=$|[\s)/,–-]|\b)/.exec(t)?.[1];
  if (letter) return { A: 5, B: 4, C: 3, D: 2 }[letter as 'A' | 'B' | 'C' | 'D'];
  if (/highest/i.test(t)) return 5;
  if (/medium-high|medium high/i.test(t)) return 4;
  if (/high/i.test(t)) return 4;
  if (/medium/i.test(t)) return 3;
  if (/low/i.test(t)) return 2;
  return 3;
}

function sourceKind(type: string, name: string): SeedSource['kind'] {
  const t = `${type} ${name}`.toLowerCase();
  if (/peer|journal|review|doi|meta-analysis|study|academic/.test(t)) return 'journal';
  if (/government|official|agency|institute|university|nhs|regulator|ftc|cdc|usda|\bfsa\b|nonprofit|non-profit|professional body|committee|centre|center/.test(t)) return 'institution';
  if (/dataset|data\b|statistics|survey|census|ons\b|bls\b/.test(t)) return 'dataset';
  if (/rss|feed/.test(t)) return 'rss';
  return 'publication';
}

/** RSS/Atom endpoints the desk can poll; subreddit and YouTube channel pages map to their feeds. */
export function feedUrlFor(url: string): { url: string; feed: boolean } {
  const reddit = /^https?:\/\/(?:www\.|old\.)?reddit\.com\/r\/([A-Za-z0-9_]+)\/?$/.exec(url);
  if (reddit) return { url: `https://www.reddit.com/r/${reddit[1]}/.rss`, feed: true };
  const yt = /^https?:\/\/(?:www\.)?youtube\.com\/channel\/(UC[\w-]{10,})/.exec(url);
  if (yt) return { url: `https://www.youtube.com/feeds/videos.xml?channel_id=${yt[1]}`, feed: true };
  const feed = /news\.google\.com\/rss|\/rss(?:\.xml)?\/?(?:$|\?)|\.rss\b|\/feeds?(?:\/|$)|\.xml\b|\.atom\b|\/atom\b|feeds\/videos\.xml/i.test(url);
  return { url, feed };
}

function levelFor(module: string, title: string): SeedNode['level'] {
  if (/^myth\b|myth:/i.test(title)) return 'myth';
  if (/^debate\b|debate:/i.test(title)) return 'debate';
  if (/frontier/i.test(title)) return 'frontier';
  const m = module.toLowerCase();
  if (/fundamental|basics|how .* works/.test(m)) return 'fundamental';
  if (/myth/.test(m) && !/debate/.test(m)) return 'myth';
  if (/debate/.test(m)) return 'debate';
  if (/frontier|research/.test(m)) return 'frontier';
  if (/advanced/.test(m)) return 'advanced';
  return 'intermediate';
}

export function parseFieldBrainSeed(md: string): FieldBrainSeed {
  const title = cleanInline(/^#\s+(.+)$/m.exec(md)?.[1] ?? '').replace(/^Field Brain Seed:\s*/i, '');
  const { sections } = splitSections(md, 2);
  const nodes: SeedNode[] = [];
  const sources: SeedSource[] = [];
  const feeds: SeedFeed[] = [];
  const experts: SeedExpert[] = [];
  const paths = new Set<string>();

  for (const s of sections) {
    if (/curriculum/i.test(s.title)) {
      const { intro, sections: modules } = splitSections(s.body, 3);
      const blocks = modules.length ? modules : [{ title: '', body: intro }];
      for (const m of blocks) {
        const module = cleanInline(m.title).replace(/^(?:Module\s+)?[A-Z][.:)]\s*/, '').replace(/\s*\((?:nodes?|\d)[^)]*\)\s*$/i, '');
        for (const t of parseTables(m.body)) {
          const cNode = col(t.header, /node|topic/i);
          if (cNode < 0) continue;
          const cSyn = col(t.header, /synthesis|must answer|key facts|core|summary/i, [cNode]);
          const cUse = col(t.header, /\buse\b|angle/i, [cNode, cSyn]);
          const cSrc = col(t.header, /source|canon/i, [cNode, cSyn, cUse]);
          for (const r of t.rows) {
            const nodeTitle = cleanInline(r[cNode] ?? '');
            if (!nodeTitle) continue;
            const synthesis = cSyn >= 0 ? cleanInline(r[cSyn] ?? '') : '';
            const srcText = cSrc >= 0 ? cleanInline(r[cSrc] ?? '') : '';
            // "S1; S3" style refs, or a canon column of bare numbers ("5, 6").
            const numbered = /^\s*\d{1,2}(\s*[,;]\s*\d{1,2})*\s*$/.test(srcText) ? srcText.split(/[,;]/).map((x) => `S${x.trim()}`) : [];
            const refs = [...new Set([...(srcText.match(/\bS\d{1,2}\b/g) ?? []), ...(synthesis.match(/\bS\d{1,2}\b/g) ?? []), ...numbered])];
            const moduleSlug = slugify(module || 'core', 40);
            let path = `${moduleSlug}/${slugify(nodeTitle, 60)}`;
            for (let k = 2; paths.has(path); k++) path = `${moduleSlug}/${slugify(nodeTitle, 56)}-${k}`;
            paths.add(path);
            nodes.push({
              path,
              title: nodeTitle,
              level: levelFor(module, nodeTitle),
              module,
              synthesis,
              facts: srcText.length > 40 ? srcText : null,
              use: cUse >= 0 ? cleanInline(r[cUse] ?? '') || null : null,
              sourceRefs: refs.length ? refs : srcText ? srcText.split(/;\s*/).slice(0, 6) : [],
            });
          }
        }
      }
    } else if (/canon|sources? \(/i.test(s.title) && !/feed|news/i.test(s.title)) {
      for (const t of parseTables(s.body)) {
        const cName = col(t.header, /^source|^name|publication|^who/i);
        if (cName < 0) continue;
        const cUrl = col(t.header, /url|link|endpoint/i);
        const cType = col(t.header, /type|kind/i);
        const cCred = col(t.header, /credib/i);
        const cNotes = col(t.header, /notes|for|use|what/i, [cName, cUrl, cType, cCred]);
        for (const r of t.rows) {
          const name = cleanInline(r[cName] ?? '').slice(0, 200);
          if (!name) continue;
          const first = cleanInline(r[0] ?? '');
          const refNum = /^S?(\d{1,2})$/.exec(first)?.[1];
          const url = (cUrl >= 0 ? firstUrl(r[cUrl] ?? '') : null) ?? firstUrl(r.join(' '));
          sources.push({
            ref: refNum ? `S${refNum}` : null,
            name,
            url,
            kind: sourceKind(cType >= 0 ? r[cType] ?? '' : '', name),
            credibility: credibilityScore(cCred >= 0 ? r[cCred] ?? '' : cNotes >= 0 ? r[cNotes] ?? '' : ''),
            notes: [cType >= 0 ? cleanInline(r[cType] ?? '') : '', cNotes >= 0 ? cleanInline(r[cNotes] ?? '') : ''].filter(Boolean).join(' · ').slice(0, 600) || null,
          });
        }
      }
      parseExperts(s.body, experts);
    } else if (/feed|news source/i.test(s.title)) {
      for (const t of parseTables(s.body)) {
        const cName = col(t.header, /feed|source|name/i);
        const cWhy = col(t.header, /why|catch|watch|what/i, [cName]);
        for (const r of t.rows) {
          const name = cleanInline(r[cName >= 0 ? cName : 1] ?? '').slice(0, 160);
          const urls = [...new Set(r.join(' ').match(/https?:\/\/[^\s|)>\]`"'*]+/g) ?? [])].map((u) => u.replace(/[.,;:]+$/, ''));
          urls.forEach((u, i) => {
            const f = feedUrlFor(u);
            feeds.push({ name: i === 0 ? name : `${name} (${i + 1})`, url: f.url, feed: f.feed, why: cWhy >= 0 ? cleanInline(r[cWhy] ?? '') || null : null });
          });
        }
      }
    } else {
      parseExperts(s.body, experts);
    }
  }
  linkSourceRefs(nodes, sources);
  return { title, sources, feeds, experts, nodes };
}

const GENERIC = new Set(['the', 'british', 'american', 'national', 'us', 'uk', 'federal', 'journal', 'international', 'university', 'office', 'department', 'royal', 'new', 'global']);

/** Names a canon source goes by in the node tables: its acronym, or its first distinctive word(s). */
function sourceKeys(name: string): string[] {
  const keys = [...name.matchAll(/\(([A-Z][A-Za-z]{1,7})\)/g)].map((m) => m[1]!).filter((k) => /[A-Z]{2}/.test(k));
  const head = cleanInline(name).split(/[:,(]/)[0]!.replace(/\bet al\.?/i, '').trim();
  const words = head.split(/\s+/).filter((w) => /^[A-Z][\w&'.-]{2,}$|^[A-Z]{2,}$|^e[A-Z]\w+$/.test(w));
  if (words.length) keys.push(GENERIC.has(words[0]!.toLowerCase()) && words[1] ? `${words[0]} ${words[1]}` : words[0]!);
  return [...new Set(keys)];
}

/** Nodes whose seed row names a canon source in prose ("NHS Eatwell Guide", "Thaler & Benartzi") cite that source. */
function linkSourceRefs(nodes: SeedNode[], sources: readonly SeedSource[]): void {
  const keyed = sources.filter((s) => s.ref).map((s) => ({ ref: s.ref!, keys: sourceKeys(s.name) }));
  for (const n of nodes) {
    if (n.sourceRefs.some((r) => /^S\d+$/.test(r))) continue;
    const text = `${n.synthesis} ${n.facts ?? ''} ${n.sourceRefs.join(' ')}`;
    const refs = keyed
      .filter((s) => s.keys.some((k) => new RegExp(`(^|[^A-Za-z])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z])`).test(text)))
      .map((s) => s.ref)
      .slice(0, 4);
    if (refs.length) n.sourceRefs = [...refs, ...n.sourceRefs.filter((r) => !/^S\d+$/.test(r))];
  }
}

/** "**People and schools of thought**" bullets: "- Relationship science: Eli Finkel, Paul Eastwick, the Gottmans." */
function parseExperts(md: string, into: SeedExpert[]): void {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => /people and schools|expert map|schools of thought|who'?s who/i.test(l));
  if (start < 0) return;
  for (const line of lines.slice(start + 1)) {
    const li = /^\s*[-*]\s+(.+)$/.exec(line);
    if (!li) {
      if (line.trim() && !/^\s*$/.test(line) && into.length) break;
      continue;
    }
    const text = cleanInline(li[1]!);
    const [school, people] = text.includes(':') ? [text.slice(0, text.indexOf(':')), text.slice(text.indexOf(':') + 1)] : ['', text];
    const why = /\(([^)]+)\)/.exec(school)?.[1] ?? null;
    for (const name of people.replace(/\.$/, '').split(/,\s*|\s+and\s+/)) {
      const n = name.trim();
      if (n && n.length <= 80 && !into.some((e) => e.name === n)) into.push({ name: n, school: school.replace(/\([^)]*\)/, '').trim() || 'general', why });
    }
  }
}
