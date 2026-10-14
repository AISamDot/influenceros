import type { Briefing, StudioServices } from '@ios/agents';
import { addMessage, findThread } from '@ios/core';
import { json } from '@ios/db';
import type { FeedItem } from '@ios/providers';
import { embedNews } from './embed';
import { toBriefing } from './service';
import { skillBlock } from './skills';
import { ACTIVE_PERSONA_SQL, clamp, cosine, deferOnBudget, enqueueOnce, hostOf, localDate, trimText } from './util';

/**
 * The News Desk (PRD §3.10 item 3, FR-23.2): a daily scan per niche (canon RSS, Google News RSS searches,
 * subreddit RSS, YouTube channel RSS), dedupe, score, then a morning briefing per persona (what happened, why it
 * matters to this audience, the persona's take within its stance rules) and a fast-reaction idea queue (24–72 h).
 */

export const NEWS_JOBS = { scan: 'news.scan', briefing: 'news.briefing' } as const;

/** Items older than this are ignored by a scan. */
export const MAX_ITEM_AGE_DAYS = 7;
/** A briefing draws on items found in the last 36 hours. */
export const BRIEFING_WINDOW_HOURS = 36;
export const BRIEFING_MIN_SCORE = 30;
export const BRIEFING_ITEMS = 5;
export const REACTION_TTL_HOURS = 48;

// ───────────────────────────── Dedupe and scoring (pure) ─────────────────────────────

const TRACKING = /^(utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|cmpid|ocid|igshid|smid|s)$/i;

/** Lowercase host without www, no fragment, no tracking parameters, no trailing slash. */
export function canonicalUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = '';
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    u.searchParams.sort();
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '');
    return u.toString();
  } catch {
    return raw.trim();
  }
}

const STOP = new Set(
  'the a an and or but of to in on for with at by from as is are was were be been it its this that these those how what why who when your you our their his her after over into about new says say said will can could just than more most up out not no'.split(' '),
);

/** Normalised word set of a headline (drops a trailing " - Publisher" that Google News appends). */
export function titleKey(title: string): string {
  const t = title.replace(/\s+[-–—|]\s+[^-–—|]{2,60}$/, '').toLowerCase();
  const words = (t.match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w));
  return [...new Set(words)].sort().join(' ');
}

export function jaccard(a: string, b: string): number {
  const A = new Set(a.split(' ').filter(Boolean));
  const B = new Set(b.split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/** Same story: identical keys, or ≥ 60% word overlap when both headlines carry at least 4 content words. */
export function sameStory(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const na = a.split(' ').length;
  const nb = b.split(' ').length;
  return na >= 4 && nb >= 4 && jaccard(a, b) >= 0.6;
}

export type NewsKind = 'news' | 'reddit' | 'youtube';

export function newsKind(url: string): NewsKind {
  const h = hostOf(url) ?? '';
  if (/(^|\.)reddit\.com$|(^|\.)redd\.it$/.test(h)) return 'reddit';
  if (/(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(h)) return 'youtube';
  return 'news';
}

/**
 * 0–100: recency (≤ 35), source credibility (≤ 25; Reddit and YouTube are audience signal, not evidence),
 * relevance to the niche (≤ 30, cosine to the niche profile) and coverage across sources (≤ 10).
 */
export function scoreItem(x: { publishedAt: Date | null; now: Date; credibility: number | null; relevance: number; coverage: number; kind: NewsKind }): number {
  const hours = x.publishedAt ? (x.now.getTime() - x.publishedAt.getTime()) / 3_600_000 : null;
  const recency = hours === null ? 18 : hours <= 6 ? 35 : hours <= 24 ? 30 : hours <= 48 ? 20 : hours <= 72 ? 12 : hours <= 168 ? 5 : 0;
  const cred = x.kind === 'reddit' ? 8 : x.kind === 'youtube' ? 10 : clamp(x.credibility ?? 3, 1, 5) * 5;
  const rel = clamp((x.relevance - 0.1) / 0.5, 0, 1) * 30;
  const cov = clamp((x.coverage - 1) * 5, 0, 10);
  return Math.round(clamp(recency + cred + rel + cov, 0, 100));
}

// ───────────────────────────── Feeds ─────────────────────────────

export interface FeedSource {
  id: string;
  name: string;
  url: string;
  credibility: number | null;
  origin: string | null;
}

export function googleNewsFeed(query: string): string {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
}

/** The niche's RSS sources; a niche with none gets a Google News search feed built from its personas' sub-niches. */
export async function feedsForNiche(services: StudioServices, studioId: string, niche: string): Promise<FeedSource[]> {
  const { db } = services;
  const q = () =>
    db.query<FeedSource>(
      `SELECT id, name, url, credibility, meta->>'origin' AS origin FROM knowledge_source
        WHERE studio_id = $1 AND lower(niche) = lower($2) AND kind = 'rss' AND url IS NOT NULL
          AND COALESCE(meta->>'feed', 'true') <> 'false' AND fetch_failures < 10
        ORDER BY credibility DESC NULLS LAST, name`,
      [studioId, niche],
    );
  const feeds = await q();
  if (feeds.length) return feeds;
  const subs = await db.query<{ sub_niche: string | null }>(
    `SELECT DISTINCT sub_niche FROM persona WHERE studio_id = $1 AND lower(niche) = lower($2) AND ${ACTIVE_PERSONA_SQL}`,
    [studioId, niche],
  );
  const phrases = subs.flatMap((s) => (s.sub_niche ?? '').split(/,|;| and /)).map((s) => s.trim()).filter((s) => s.length > 2).slice(0, 3);
  const query = phrases.length ? phrases.map((p) => `"${p}"`).join(' OR ') : niche;
  await db.query(
    `INSERT INTO knowledge_source (studio_id, niche, name, url, kind, canon, credibility, meta)
     VALUES ($1, $2, $3, $4, 'rss', false, 3, $5::jsonb) ON CONFLICT (studio_id, niche, name) DO NOTHING`,
    [studioId, niche, `Feed: Google News (${niche})`, googleNewsFeed(query), json({ origin: 'default', feed: true })],
  );
  return q();
}

/** Lets the live feed provider fetch the hosts the studio itself registered (seed and Owner feeds). */
function allowStudioHosts(services: StudioServices, feeds: readonly FeedSource[]): void {
  const p = services.providers.feeds as { allowHosts?: (hosts: readonly string[]) => void };
  if (typeof p.allowHosts !== 'function') return;
  const hosts = feeds.filter((f) => f.origin === 'seed' || f.origin === 'owner' || f.origin === 'default').map((f) => hostOf(f.url)).filter((h): h is string => !!h);
  p.allowHosts(hosts);
}

async function pool<T, R>(items: readonly T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

// ───────────────────────────── Scan ─────────────────────────────

export interface ScanSummary {
  niche: string;
  feeds: number;
  failedFeeds: number;
  fetched: number;
  inserted: number;
  duplicates: number;
  scored: number;
  briefingsQueued: number;
}

interface StoredItem {
  id: string;
  title_key: string | null;
  coverage: number;
  created_at: Date;
}

export async function scanNiche(
  services: StudioServices,
  opts: { studioId: string; niche: string; perFeed?: number; queueBriefings?: boolean },
): Promise<ScanSummary> {
  const { db, providers } = services;
  const now = services.now();
  const niche = opts.niche.trim().toLowerCase();
  const feeds = await feedsForNiche(services, opts.studioId, niche);
  allowStudioHosts(services, feeds);
  let failedFeeds = 0;
  const batches = await pool(feeds, 4, async (f) => {
    try {
      const items = await providers.feeds.fetchFeed({ url: f.url, limit: opts.perFeed ?? 25 });
      await db.query(`UPDATE knowledge_source SET last_fetched_at = $2, fetch_failures = 0, last_error = NULL WHERE id = $1`, [f.id, now]);
      return items.map((item) => ({ item, feed: f }));
    } catch (err) {
      failedFeeds += 1;
      await db.query(`UPDATE knowledge_source SET fetch_failures = fetch_failures + 1, last_error = $2 WHERE id = $1`, [
        f.id,
        trimText(err instanceof Error ? err.message : String(err), 300),
      ]);
      return [] as Array<{ item: FeedItem; feed: FeedSource }>;
    }
  });
  const fetched = batches.flat();
  const minDate = new Date(now.getTime() - MAX_ITEM_AGE_DAYS * 86_400_000);

  // Recent stories in this niche, for near-duplicate detection across feeds and days.
  const recent = await db.query<StoredItem>(
    `SELECT id, title_key, coverage, created_at FROM news_item
      WHERE studio_id = $1 AND lower(niche) = $2 AND duplicate_of IS NULL AND created_at >= $3
      ORDER BY created_at`,
    [opts.studioId, niche, new Date(now.getTime() - 72 * 3_600_000)],
  );
  const inserted: string[] = [];
  const covered = new Set<string>();
  let duplicates = 0;
  for (const { item, feed } of fetched) {
    if (!item.title?.trim() || !item.url) continue;
    if (item.publishedAt && item.publishedAt < minDate) continue;
    const url = canonicalUrl(item.url);
    if (!/^https?:\/\//.test(url)) continue;
    const key = titleKey(item.title);
    const original = recent.find((r) => r.title_key && sameStory(r.title_key, key));
    const row = await db.maybeOne<{ id: string }>(
      `INSERT INTO news_item (studio_id, niche, source_id, title, url, published_at, summary, raw, kind, title_key, duplicate_of, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12)
       ON CONFLICT (studio_id, niche, url) DO NOTHING RETURNING id`,
      [
        opts.studioId,
        niche,
        feed.id,
        trimText(item.title, 300),
        url,
        item.publishedAt,
        item.summary ? trimText(item.summary.replace(/<[^>]+>/g, ' '), 1200) : null,
        json({ source: item.source || feed.name.replace(/^Feed:\s*/, ''), feed_url: feed.url }),
        newsKind(url),
        key,
        original?.id ?? null,
        now,
      ],
    );
    if (!row) continue;
    if (original) {
      duplicates += 1;
      original.coverage += 1;
      covered.add(original.id);
      await db.query('UPDATE news_item SET coverage = coverage + 1 WHERE id = $1', [original.id]);
    } else {
      inserted.push(row.id);
      recent.push({ id: row.id, title_key: key, coverage: 1, created_at: now });
    }
  }

  try {
    await embedNews(services, inserted);
  } catch (err) {
    // The embedder can be unavailable (model download offline): score without relevance now; the
    // knowledge.embed_pending schedule embeds these rows later.
    console.warn(`[news] embedding ${inserted.length} items failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Also re-score anything a previous, interrupted scan left unscored.
  const unscored = await db.query<{ id: string }>(
    `SELECT id FROM news_item WHERE studio_id = $1 AND lower(niche) = $2 AND duplicate_of IS NULL AND score IS NULL AND created_at >= $3`,
    [opts.studioId, niche, new Date(now.getTime() - 72 * 3_600_000)],
  );
  const toScore = [...new Set([...inserted, ...covered, ...unscored.map((r) => r.id)])];
  const scored = await scoreItems(services, opts.studioId, niche, toScore);

  let briefingsQueued = 0;
  if (opts.queueBriefings !== false) {
    const personas = await db.query<{ id: string; timezone: string }>(
      `SELECT id, timezone FROM persona WHERE studio_id = $1 AND lower(niche) = $2 AND state <> 'PROPOSED' AND ${ACTIVE_PERSONA_SQL}`,
      [opts.studioId, niche],
    );
    for (const p of personas) {
      const date = localDate(now, p.timezone);
      const job = await enqueueOnce(db, { kind: NEWS_JOBS.briefing, key: `briefing:${p.id}:${date}`, payload: { personaId: p.id, date }, studioId: opts.studioId, personaId: p.id, priority: 90 });
      if (job) briefingsQueued += 1;
    }
  }
  return { niche, feeds: feeds.length, failedFeeds, fetched: fetched.length, inserted: inserted.length, duplicates, scored, briefingsQueued };
}

/** The niche profile: the niche, its personas' sub-niches and news beats. Items are scored by closeness to it. */
async function nicheProfile(services: StudioServices, studioId: string, niche: string): Promise<number[] | null> {
  const rows = await services.db.query<{ sub_niche: string | null; beats: unknown }>(
    `SELECT p.sub_niche, b.content->'news_beats' AS beats FROM persona p
       LEFT JOIN persona_bible b ON b.persona_id = p.id AND b.version = p.current_bible_version
      WHERE p.studio_id = $1 AND lower(p.niche) = $2 AND ${ACTIVE_PERSONA_SQL.replace('state', 'p.state')}`,
    [studioId, niche],
  );
  const text = trimText([niche, ...rows.map((r) => r.sub_niche ?? ''), ...rows.map((r) => (r.beats ? JSON.stringify(r.beats) : ''))].join('. '), 2000);
  try {
    const [v] = await services.providers.embeddings.embed([text]);
    return v ?? null;
  } catch {
    return null;
  }
}

async function scoreItems(services: StudioServices, studioId: string, niche: string, ids: readonly string[]): Promise<number> {
  if (!ids.length) return 0;
  const profile = await nicheProfile(services, studioId, niche);
  const rows = await services.db.query<{ id: string; published_at: Date | null; coverage: number; kind: NewsKind; credibility: number | null; embedding: string | null }>(
    `SELECT n.id, n.published_at, n.coverage, n.kind, s.credibility, n.embedding::text AS embedding
       FROM news_item n LEFT JOIN knowledge_source s ON s.id = n.source_id WHERE n.id = ANY($1::uuid[])`,
    [ids],
  );
  const now = services.now();
  for (const r of rows) {
    const vec = r.embedding ? (JSON.parse(r.embedding) as number[]) : null;
    const relevance = profile && vec ? cosine(profile, vec) : 0.2;
    const score = scoreItem({ publishedAt: r.published_at ? new Date(r.published_at) : null, now, credibility: r.credibility, relevance, coverage: r.coverage, kind: r.kind });
    await services.db.query('UPDATE news_item SET score = $2, scored_at = $3 WHERE id = $1', [r.id, score, now]);
  }
  return rows.length;
}

// ───────────────────────────── Morning briefing ─────────────────────────────

export interface BriefingDraft {
  items: Array<{ news_item_id: string; why_it_matters: string; take: string }>;
  reaction_ideas: Array<{ news_item_id: string; title: string; angle: string; hook: string }>;
}

export const BRIEFING_DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items', 'reaction_ideas'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['news_item_id', 'why_it_matters', 'take'],
        properties: { news_item_id: { type: 'string' }, why_it_matters: { type: 'string' }, take: { type: 'string' } },
      },
    },
    reaction_ideas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['news_item_id', 'title', 'angle', 'hook'],
        properties: { news_item_id: { type: 'string' }, title: { type: 'string' }, angle: { type: 'string' }, hook: { type: 'string' } },
      },
    },
  },
} as const;

/** Validates a draft and keeps only entries about the candidate items (the model can't invent a story). */
export function parseBriefingDraft(value: unknown, allowedIds: readonly string[]): BriefingDraft {
  const v = value as Partial<BriefingDraft> | null;
  if (!v || !Array.isArray(v.items) || !Array.isArray(v.reaction_ideas)) throw new Error('briefing draft: expected { items, reaction_ideas }');
  const ok = new Set(allowedIds);
  const str = (x: unknown, max: number) => trimText(typeof x === 'string' ? x : '', max);
  return {
    items: v.items
      .filter((i) => i && ok.has(String(i.news_item_id)))
      .map((i) => ({ news_item_id: String(i.news_item_id), why_it_matters: str(i.why_it_matters, 400), take: str(i.take, 400) }))
      .filter((i) => i.why_it_matters && i.take),
    reaction_ideas: v.reaction_ideas
      .filter((i) => i && ok.has(String(i.news_item_id)))
      .map((i) => ({ news_item_id: String(i.news_item_id), title: str(i.title, 160), angle: str(i.angle, 400), hook: str(i.hook, 200) }))
      .filter((i) => i.title && i.angle)
      .slice(0, 3),
  };
}

const NEWS_DESK_SYSTEM = [
  'You are the News Desk for one openly-AI influencer persona. From today\'s scored stories, write the morning',
  'briefing for the persona\'s manager: for each story, why it matters to this audience (one or two sentences) and',
  'the persona\'s take in its own voice (at most 40 words), within the stance rules and "never comment on" list in',
  'the bible extract. Then suggest at most three fast-reaction post ideas (publish within 24-72 hours) for the',
  'stories that genuinely deserve one. Rules: opinions and general education only; no individual medical, legal or',
  'financial advice; no specific securities or crypto calls; no disease-cure claims; no guaranteed results; never',
  'present the persona\'s fictional lore as fact; skip a story rather than stretch the stance rules. English only.',
  'Use only the news_item_id values you are given.',
].join(' ');

interface Candidate {
  id: string;
  title: string;
  url: string;
  summary: string | null;
  score: number;
  source: string | null;
  kind: NewsKind;
}

export function fakeBriefingDraft(persona: { name: string; niche: string }, items: readonly Candidate[]): BriefingDraft {
  const first = persona.name.split(/\s+/)[0] ?? persona.name;
  return {
    items: items.map((c) => ({
      news_item_id: c.id,
      why_it_matters: `Fresh in ${persona.niche} (${c.source ?? 'news'}); likely in the audience's feeds this week, so it's worth knowing before the comments ask.`,
      take: `${first}'s take: say what this means in plain words, give one clear opinion, and point to the comment keyword. Opinion and general education only.`,
    })),
    reaction_ideas: items
      .filter((c) => c.score >= 50 && c.kind === 'news')
      .slice(0, 2)
      .map((c) => ({
        news_item_id: c.id,
        title: `Reacting to: ${trimText(c.title, 110)}`,
        angle: `A talking reaction within 48 hours: what happened, why it matters to the audience, and ${first}'s take.`,
        hook: `Everyone's sharing this today. Here's the part that matters to you.`,
      })),
  };
}

export interface BriefingResult {
  briefing: Briefing;
  created: boolean;
  runId: string | null;
  messageId: string | null;
}

export async function buildBriefing(
  services: StudioServices,
  opts: { personaId: string; date?: string; force?: boolean },
): Promise<BriefingResult | null> {
  const { db } = services;
  const p = await db.maybeOne<{ id: string; studio_id: string; name: string; slug: string; niche: string; timezone: string; current_bible_version: number | null }>(
    'SELECT id, studio_id, name, slug, niche, timezone, current_bible_version FROM persona WHERE id = $1',
    [opts.personaId],
  );
  if (!p) return null;
  const now = services.now();
  const date = opts.date ?? localDate(now, p.timezone);
  if (!opts.force) {
    const existing = await db.maybeOne<{ persona_id: string; date: string; items: never[]; reaction_ideas: never[] }>(
      `SELECT persona_id, to_char(briefing_date, 'YYYY-MM-DD') AS date, items, reaction_ideas FROM news_briefing WHERE persona_id = $1 AND briefing_date = $2`,
      [p.id, date],
    );
    if (existing) return { briefing: toBriefing(existing), created: false, runId: null, messageId: null };
  }

  const candidates = await db.query<Candidate>(
    `SELECT n.id, n.title, n.url, n.summary, n.score, n.raw->>'source' AS source, n.kind
       FROM news_item n
      WHERE n.studio_id = $1 AND lower(n.niche) = lower($2) AND n.duplicate_of IS NULL AND n.score >= $3 AND n.created_at >= $4
        AND NOT EXISTS (
          SELECT 1 FROM news_briefing b, jsonb_array_elements(b.items) e
           WHERE b.persona_id = $5 AND b.briefing_date >= ($6::date - 3) AND b.briefing_date < $6::date
             AND e->>'news_item_id' = n.id::text)
      ORDER BY n.score DESC, n.published_at DESC NULLS LAST LIMIT $7`,
    [p.studio_id, p.niche, BRIEFING_MIN_SCORE, new Date(now.getTime() - BRIEFING_WINDOW_HOURS * 3_600_000), p.id, date, BRIEFING_ITEMS],
  );

  let draft: BriefingDraft = { items: [], reaction_ideas: [] };
  let runId: string | null = null;
  let mode: 'live' | 'fake' = services.runtime.mode;
  if (candidates.length) {
    const bible = await db.maybeOne<{ beats: unknown; compliance: unknown }>(
      `SELECT content->'news_beats' AS beats, content->'compliance' AS compliance FROM persona_bible WHERE persona_id = $1 AND version = $2`,
      [p.id, p.current_bible_version ?? 0],
    );
    const result = await services.runtime
      .run<BriefingDraft>({
        agent: 'news-desk',
        scope: { studioId: p.studio_id, personaId: p.id },
        label: `morning briefing ${date}`,
        system: NEWS_DESK_SYSTEM,
        cached: [
          skillBlock('field-brain'),
          { key: `bible-news:${p.id}:v${p.current_bible_version ?? 0}`, text: trimText(JSON.stringify({ persona: p.name, niche: p.niche, news_beats: bible?.beats ?? null, compliance: bible?.compliance ?? null }), 24_000) },
        ],
        skills: ['field-brain'],
        prompt: JSON.stringify({ date, stories: candidates.map((c) => ({ news_item_id: c.id, title: c.title, source: c.source, summary: trimText(c.summary, 500), score: c.score })) }),
        maxTokens: 3000,
        parse: (v) => parseBriefingDraft(v, candidates.map((c) => c.id)),
        jsonSchema: BRIEFING_DRAFT_SCHEMA,
        fake: () => fakeBriefingDraft(p, candidates),
        costRef: { type: 'news', id: p.studio_id },
      })
      .catch((err) => deferOnBudget(err, `briefing ${p.slug}`));
    draft = result.output;
    runId = result.runId;
    mode = result.mode;
  }

  const byId = new Map(candidates.map((c) => [c.id, c]));
  const items = draft.items.map((d) => {
    const c = byId.get(d.news_item_id)!;
    return { news_item_id: c.id, title: c.title, url: c.url, why_it_matters: d.why_it_matters, take: d.take, score: c.score };
  });
  const expires = new Date(now.getTime() + REACTION_TTL_HOURS * 3_600_000).toISOString();
  const reactions = draft.reaction_ideas.map((r) => ({ ...r, expires_at: expires }));
  const meta = { run_id: runId, mode, candidates: candidates.length };
  await db.query(
    `INSERT INTO news_briefing (persona_id, niche, briefing_date, items, reaction_ideas, meta)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb)
     ON CONFLICT (persona_id, briefing_date) DO UPDATE SET items = EXCLUDED.items, reaction_ideas = EXCLUDED.reaction_ideas, meta = EXCLUDED.meta`,
    [p.id, p.niche, date, json(items), json(reactions), json(meta)],
  );

  // The fast-reaction queue: ideas the calendar can pick up (source.type = 'news').
  for (const r of reactions) {
    const exists = await db.maybeOne(`SELECT 1 FROM idea WHERE persona_id = $1 AND source->>'type' = 'news' AND source->>'news_item_id' = $2`, [p.id, r.news_item_id]);
    if (exists) continue;
    await db.query(
      `INSERT INTO idea (persona_id, title, pillar, format, purpose, hook_options, source, status)
       VALUES ($1, $2, 'News reaction', 'talking', 'reach', $3::jsonb, $4::jsonb, 'new')`,
      [p.id, r.title, json(r.hook ? [r.hook] : []), json({ type: 'news', news_item_id: r.news_item_id, briefing_date: date, expires_at: r.expires_at, angle: r.angle })],
    );
  }

  let messageId: string | null = null;
  if (items.length) {
    const thread = await findThread(db, p.studio_id, 'persona', p.id);
    const msg = await addMessage(db, {
      threadId: thread.id,
      role: 'agent',
      author: 'agent:news-desk',
      personaId: p.id,
      body: briefingText(date, items, reactions),
      meta: { kind: 'briefing', runId, fake: mode === 'fake', briefingDate: date },
    });
    messageId = msg.id;
    await db.query(`UPDATE news_briefing SET meta = meta || $3::jsonb WHERE persona_id = $1 AND briefing_date = $2`, [p.id, date, json({ message_id: messageId })]);
  }
  const briefing = toBriefing({ persona_id: p.id, date, items, reaction_ideas: reactions });
  return { briefing, created: true, runId, messageId };
}

export function briefingText(
  date: string,
  items: ReadonlyArray<{ title: string; url: string; why_it_matters: string; take: string; score: number }>,
  reactions: ReadonlyArray<{ title: string; angle: string }>,
): string {
  const lines = [`Morning briefing · ${date} · ${items.length} ${items.length === 1 ? 'story' : 'stories'}`];
  items.forEach((i, n) => lines.push(`${n + 1}. ${i.title} (score ${i.score})\nWhy it matters: ${i.why_it_matters}\nTake: ${i.take}\n${i.url}`));
  if (reactions.length) lines.push(`Fast reactions (aim to post within ${REACTION_TTL_HOURS} h):\n${reactions.map((r) => `• ${r.title}: ${r.angle}`).join('\n')}`);
  return lines.join('\n\n');
}

/** Open fast-reaction ideas for a persona (not expired, not yet scripted or dropped). */
export async function reactionQueue(services: Pick<StudioServices, 'db' | 'now'>, personaId: string) {
  return services.db.query<{ id: string; title: string; hook_options: string[]; source: Record<string, unknown>; created_at: Date }>(
    `SELECT id, title, hook_options, source, created_at FROM idea
      WHERE persona_id = $1 AND status = 'new' AND source->>'type' = 'news' AND (source->>'expires_at')::timestamptz > $2
      ORDER BY created_at DESC LIMIT 20`,
    [personaId, services.now()],
  );
}
