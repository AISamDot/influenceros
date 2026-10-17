import { type FormatBenchmark, type MonetisationPattern, OUTLIER, type OpportunityEvidence } from '@troupe/agents';
import { addSignal } from '@troupe/content';
import type { PostFormat } from '@troupe/core';
import { type Db, json } from '@troupe/db';
import { HOOK_LABEL, type HookType } from './classify';
import { clusterTrends, type Trend, type TrendDimension } from './cluster';
import { nicheKey } from './config';
import { median } from './scoring';
import { isoDate, weekStartOf } from './scrape';

/**
 * What the Radar learns, per niche: trends (clustered across accelerating accounts), format and cadence benchmarks
 * (for stream L's Format Plan), monetisation patterns (for the Monetization Agent) and opportunity evidence (for
 * Persona Generator step 1). Every label here is ours or a short sanitised tag / sound name, never a caption.
 */

const DAY = 86_400_000;
const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const round = (x: number, dp = 3) => Math.round(x * 10 ** dp) / 10 ** dp;

/** A scraped tag or sound name made safe to show: letters, digits and light punctuation, 48 chars. */
export function safeLabel(s: string): string {
  return s
    .replace(/[^\p{L}\p{N} ·&'"()\-+_.#/×]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48);
}

export const FORMAT_LABEL: Readonly<Record<PostFormat, string>> = {
  talking: 'talking to camera',
  activity_text: 'activity + text overlay',
  voiceover: 'voiceover',
  static: 'static image',
  carousel: 'carousel',
  product_in_hand: 'product in hand',
  trend_reenactment: 'trend re-enactment',
  photo_dump: 'photo dump',
  text_note: 'text note',
  facecam_screen: 'facecam over screen',
  reply_comment: 'reply to a comment',
  news_greenscreen: 'news greenscreen',
  meme: 'meme',
};

export function trendLabel(dimension: TrendDimension, key: string, label: string): string {
  if (dimension === 'hook') return `${HOOK_LABEL[key as HookType] ?? safeLabel(label)} hook`;
  if (dimension === 'format') return FORMAT_LABEL[key as PostFormat] ?? safeLabel(label);
  if (dimension === 'topic') return `#${safeLabel(key).replace(/^#/, '')}`;
  return `sound "${safeLabel(label)}"`;
}

// ───────────────────────────── Trends ─────────────────────────────

/** Clusters the niche's last 14 days from accelerating accounts and stores this week's trends (replacing the week's rows). */
export async function detectTrends(db: Db, studioId: string, niche: string, now: Date): Promise<Trend[]> {
  const key = nicheKey(niche);
  const rows = await db.query<{ id: string; account_id: string; handle: string; posted_at: Date | null; outlier_score: string | null; hook_type: string | null; format: string | null; topic: string | null; sound: string | null; accelerating: boolean }>(
    `SELECT p.id, p.account_id, p.handle, p.posted_at, p.outlier_score, p.hook_type, p.format, p.topic, p.sound, a.accelerating
       FROM radar_post p JOIN tracked_account a ON a.id = p.account_id
      WHERE p.studio_id = $1 AND p.niche = $2 AND p.posted_at > $3`,
    [studioId, key, new Date(now.getTime() - OUTLIER.recencyDays * DAY)],
  );
  const trends = clusterTrends(
    rows.map((r) => ({
      id: r.id,
      accountId: r.account_id,
      handle: r.handle,
      postedAt: r.posted_at ? new Date(r.posted_at) : null,
      outlier: n(r.outlier_score),
      hook: r.hook_type === 'other' ? null : r.hook_type,
      format: r.format,
      topic: r.topic,
      sound: r.sound,
    })),
    new Set(rows.filter((r) => r.accelerating).map((r) => r.account_id)),
    now,
  );
  const week = isoDate(weekStartOf(now));
  await db.transaction(async (tx) => {
    await tx.query('DELETE FROM radar_trend WHERE studio_id = $1 AND niche = $2 AND week_start = $3', [studioId, key, week]);
    for (const t of trends.slice(0, 25)) {
      await tx.query(
        `INSERT INTO radar_trend (studio_id, niche, week_start, dimension, key, label, adopters, adoption_velocity, avg_outlier, score, accounts, posts, first_seen, last_seen)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13, $14)`,
        [studioId, key, week, t.dimension, t.key, trendLabel(t.dimension, t.key, t.label), t.adopters, t.adoptionVelocity, t.avgOutlier, t.score, json(t.accounts), json(t.posts), t.firstSeen, t.lastSeen],
      );
    }
  });
  return trends;
}

export interface TrendRow {
  id: string;
  niche: string;
  week_start: string;
  dimension: TrendDimension;
  key: string;
  label: string;
  adopters: number;
  adoption_velocity: number;
  avg_outlier: number;
  score: number;
  accounts: string[];
}

export async function latestTrends(db: Db, studioId: string, opts: { niche?: string; limit?: number } = {}): Promise<TrendRow[]> {
  const rows = await db.query<TrendRow>(
    `SELECT t.id, t.niche, t.week_start::text AS week_start, t.dimension, t.key, t.label, t.adopters, t.adoption_velocity::float8 AS adoption_velocity,
            t.avg_outlier::float8 AS avg_outlier, t.score::float8 AS score, t.accounts
       FROM radar_trend t
      WHERE t.studio_id = $1 AND ($2::text IS NULL OR t.niche = $2)
        AND t.week_start = (SELECT max(week_start) FROM radar_trend x WHERE x.studio_id = t.studio_id AND x.niche = t.niche)
      ORDER BY t.score DESC LIMIT $3`,
    [studioId, opts.niche ? nicheKey(opts.niche) : null, opts.limit ?? 20],
  );
  return rows;
}

// ───────────────────────────── Benchmarks (stream L reads these) ─────────────────────────────

/**
 * Niche format and cadence benchmarks (FR-4.3c): the share of the niche's outlier posts per format, the median
 * outlier score per format, the accelerating accounts' median feed posts a week. Stories per day aren't observable
 * through public scrapers, so `storiesPerDay` stays null (L uses its default). Window: the last 30 days. null when
 * the Radar has no scored posts for the niche.
 */
export async function formatBenchmarks(db: Db, studioId: string, niche: string, now: Date): Promise<FormatBenchmark | null> {
  const key = nicheKey(niche);
  const rows = await db.query<{ format: PostFormat; outlier_score: string; account_id: string | null; accelerating: boolean | null }>(
    `SELECT p.format, p.outlier_score, p.account_id, a.accelerating FROM radar_post p LEFT JOIN tracked_account a ON a.id = p.account_id
      WHERE p.studio_id = $1 AND p.niche = $2 AND p.format IS NOT NULL AND p.outlier_score IS NOT NULL AND p.posted_at > $3`,
    [studioId, key, new Date(now.getTime() - 30 * DAY)],
  );
  if (!rows.length) return null;
  const outliers = rows.filter((r) => Number(r.outlier_score) >= OUTLIER.outlier);
  // Too few outliers yet: fall back to the rising posts (≥ 2×), then to everything scored.
  const sample = outliers.length >= 5 ? outliers : rows.filter((r) => Number(r.outlier_score) >= 2).length >= 5 ? rows.filter((r) => Number(r.outlier_score) >= 2) : rows;
  const share: Partial<Record<PostFormat, number>> = {};
  for (const r of sample) share[r.format] = (share[r.format] ?? 0) + 1;
  for (const f of Object.keys(share) as PostFormat[]) share[f] = round(share[f]! / sample.length);
  const lift: Partial<Record<PostFormat, number>> = {};
  const byFormat = new Map<PostFormat, number[]>();
  for (const r of rows) byFormat.set(r.format, [...(byFormat.get(r.format) ?? []), Number(r.outlier_score)]);
  for (const [f, xs] of byFormat) lift[f] = round(median(xs)!, 2);
  const cad = await db.query<{ cadence: string | null }>(
    `SELECT DISTINCT ON (r.account_id) r.cadence_per_week AS cadence FROM radar_review r JOIN tracked_account a ON a.id = r.account_id
      WHERE r.studio_id = $1 AND a.niche = $2 AND a.accelerating ORDER BY r.account_id, r.week_start DESC`,
    [studioId, key],
  );
  const cadences = cad.map((c) => n(c.cadence)).filter((x): x is number => x !== null);
  const accounts = new Set(rows.map((r) => r.account_id).filter(Boolean)).size;
  const confidence: FormatBenchmark['confidence'] = outliers.length >= 30 && accounts >= 8 ? 'high' : outliers.length >= 10 && accounts >= 4 ? 'medium' : 'low';
  const updated = await db.one<{ at: Date | null }>(`SELECT max(updated_at) AS at FROM radar_post WHERE studio_id = $1 AND niche = $2`, [studioId, key]);
  return {
    niche: key,
    sample: { accounts, posts: rows.length },
    formatShare: share,
    formatLift: lift,
    postsPerWeek: cadences.length ? round(median(cadences)!, 1) : null,
    storiesPerDay: null,
    confidence,
    updatedAt: updated.at ? new Date(updated.at) : now,
  };
}

// ───────────────────────────── Monetisation patterns (Monetization Agent) ─────────────────────────────

export async function monetisationPatterns(db: Db, studioId: string, niche: string): Promise<MonetisationPattern[]> {
  const key = nicheKey(niche);
  const reviews = await db.query<{ monetisation: Array<{ kind: MonetisationPattern['kind']; note: string }> }>(
    `SELECT DISTINCT ON (r.account_id) r.monetisation FROM radar_review r JOIN tracked_account a ON a.id = r.account_id
      WHERE r.studio_id = $1 AND a.niche = $2 ORDER BY r.account_id, r.week_start DESC`,
    [studioId, key],
  );
  if (!reviews.length) return [];
  const counts = new Map<MonetisationPattern['kind'], { n: number; notes: Set<string> }>();
  for (const r of reviews) {
    const seen = new Set<string>();
    for (const m of Array.isArray(r.monetisation) ? r.monetisation : []) {
      if (!m?.kind || seen.has(m.kind)) continue;
      seen.add(m.kind);
      const c = counts.get(m.kind) ?? { n: 0, notes: new Set<string>() };
      c.n += 1;
      if (m.note) c.notes.add(safeLabel(m.note).slice(0, 120));
      counts.set(m.kind, c);
    }
  }
  return [...counts.entries()]
    .map(([kind, c]) => ({ niche: key, kind, share: round(c.n / reviews.length), notes: [...c.notes].slice(0, 3) }))
    .sort((a, b) => b.share - a.share);
}

const KIND_TEXT: Record<MonetisationPattern['kind'], string> = {
  bio_link: 'use a link-in-bio hub',
  digital_product: 'sell a digital product (guide, template, planner or course)',
  membership: 'run a paid membership or community',
  fanvue: 'run a Fanvue subscription page',
  brand_deal: 'do disclosed brand deals',
  affiliate: 'use affiliate links',
  other: 'monetise another way',
};

/** Monetisation patterns → `demand_signal` rows (source 'radar') for each active persona in the niche. Deduplicated per week and kind. */
export async function pushDemandSignals(db: Db, studioId: string, niche: string, now: Date): Promise<number> {
  const key = nicheKey(niche);
  const patterns = await monetisationPatterns(db, studioId, key);
  if (!patterns.length) return 0;
  const personas = await db.query<{ id: string }>(
    `SELECT id FROM persona WHERE studio_id = $1 AND lower(regexp_replace(trim(niche), '\\s+', ' ', 'g')) = $2 AND state NOT IN ('KILLED','RETIRED','PROPOSED')`,
    [studioId, key],
  );
  const week = isoDate(weekStartOf(now));
  let added = 0;
  for (const p of personas) {
    for (const m of patterns.filter((x) => x.share >= 0.2)) {
      const id = await addSignal(db, {
        personaId: p.id,
        source: 'radar',
        text: `Growth Radar: ${Math.round(m.share * 100)}% of the fast-growing ${key} accounts we reviewed ${KIND_TEXT[m.kind]}.`,
        topic: `monetisation: ${m.kind.replace(/_/g, ' ')}`,
        weight: round(1 + 2 * m.share, 2),
        ref: { kind: m.kind, share: m.share, niche: key, week },
        sourceRef: `radar:${week}:${key}:${m.kind}`,
      });
      if (id) added += 1;
    }
  }
  return added;
}

// ───────────────────────────── Opportunity evidence (Persona Generator step 1) ─────────────────────────────

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export async function opportunityEvidence(db: Db, studioId: string, now: Date, q: { niches?: readonly string[]; limit?: number } = {}): Promise<OpportunityEvidence[]> {
  const wanted = q.niches?.length ? [...new Set(q.niches.map(nicheKey))] : (await db.query<{ niche: string }>(`SELECT DISTINCT niche FROM tracked_account WHERE studio_id = $1`, [studioId])).map((r) => r.niche);
  const out: OpportunityEvidence[] = [];
  for (const niche of wanted) {
    const acc = await db.one<{ tracked: number; accel: number; v: number | null }>(
      `SELECT count(*)::int AS tracked, count(*) FILTER (WHERE accelerating)::int AS accel,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY CASE WHEN followers > 0 AND velocity IS NOT NULL THEN velocity / followers END) AS v
         FROM tracked_account WHERE studio_id = $1 AND niche = $2 AND status = 'active'`,
      [studioId, niche],
    );
    if (!acc.tracked) continue;
    const at = now;
    if (acc.accel > 0) {
      out.push({
        niche,
        signal: 'demand',
        detail: `${acc.accel} of ${acc.tracked} tracked accounts are accelerating${acc.v !== null ? ` (median +${round(Number(acc.v) * 100, 1)}% followers a week)` : ''}.`,
        source: `Growth Radar: ${acc.accel} accelerating accounts, 14 d`,
        score: round(clamp01(acc.accel / Math.max(4, acc.tracked))),
        at,
      });
    } else if (acc.tracked >= 10) {
      out.push({ niche, signal: 'competition', detail: `${acc.tracked} established accounts tracked, none accelerating: a crowded, slow niche.`, source: 'Growth Radar: tracked accounts', score: 0.3, at });
    }
    for (const t of await latestTrends(db, studioId, { niche, limit: 2 })) {
      out.push({
        niche,
        signal: 'trend',
        detail: `${t.label} taken up by ${t.adopters} accelerating accounts in 14 days (avg ${round(t.avg_outlier, 1)}× their median).`,
        source: `Growth Radar: ${t.adopters} accelerating accounts, 14 d`,
        score: round(clamp01(t.score / 20)),
        at,
      });
    }
    const bm = await formatBenchmarks(db, studioId, niche, now);
    if (bm) {
      const gaps = (Object.keys(bm.formatLift) as PostFormat[]).filter((f) => (bm.formatLift[f] ?? 0) >= 3 && (bm.formatShare[f] ?? 0) < 0.15);
      for (const f of gaps.slice(0, 1)) {
        out.push({
          niche,
          signal: 'gap',
          detail: `${FORMAT_LABEL[f]} posts break out at ${bm.formatLift[f]}× the creator's median but are only ${Math.round((bm.formatShare[f] ?? 0) * 100)}% of the niche's winners.`,
          source: `Growth Radar: ${bm.sample.posts} posts, ${bm.sample.accounts} accounts`,
          score: round(clamp01((bm.formatLift[f] ?? 0) / 10)),
          at,
        });
      }
    }
    const pats = await monetisationPatterns(db, studioId, niche);
    const top = pats[0];
    if (top && top.share >= 0.3) {
      out.push({ niche, signal: 'demand', detail: `${Math.round(top.share * 100)}% of the fast growers reviewed ${KIND_TEXT[top.kind]}.`, source: 'Growth Radar: content reviews', score: round(top.share), at });
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, q.limit ?? 12);
}
