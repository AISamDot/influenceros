import { OUTLIER } from '@ios/agents';
import type { PostFormat } from '@ios/core';
import type { Db } from '@ios/db';
import { HOOK_LABEL, type HookType } from './classify';
import { nicheKey } from './config';
import { coverage, heuristicReplicability, internalLift, novelty, recency, winnerScore } from './scoring';

/**
 * Winner Finder (PRD §3.15.9). External outliers: the niche's fresh (≤ 14 d) posts at ≥ 5× their creator's median,
 * ranked by the composite winner score with monetisation fit against the persona's niche, pillars and products, and
 * novelty against its own history. Internal winners: our own posts beating the persona's median by ≥ 2× on views and
 * saves + shares. Results carry our labels and numbers only, never a scraped caption.
 */

export interface ShortlistItem {
  radar_post_id: string;
  platform: 'instagram' | 'tiktok';
  handle: string;
  url: string | null;
  kind: 'video' | 'image' | 'carousel';
  format: PostFormat | null;
  hook_type: string | null;
  hook_label: string | null;
  topic: string | null;
  outlier: number;
  tier: 'outlier' | 'strong';
  views: number | null;
  views_per_follower: number | null;
  depth: number | null;
  age_days: number | null;
  replicability: number;
  monetisation_fit: number;
  novelty: number;
  score: number;
  structure: string | null;
  remixed: boolean;
}

export interface PersonaProfile {
  id: string;
  studio_id: string;
  name: string;
  niche: string;
  sub_niche: string | null;
}

export async function personaProfile(db: Db, personaId: string): Promise<PersonaProfile & { terms: string[]; history: string[] }> {
  const p = await db.one<PersonaProfile>('SELECT id, studio_id, name, niche, sub_niche FROM persona WHERE id = $1', [personaId]);
  const bible = await db.maybeOne<{ content: { content_dna?: { pillars?: Array<{ name?: string }> } } }>(
    `SELECT content FROM persona_bible WHERE persona_id = $1 ORDER BY (status = 'approved') DESC, version DESC LIMIT 1`,
    [personaId],
  );
  const pillars = (bible?.content?.content_dna?.pillars ?? []).map((x) => x?.name).filter((x): x is string => typeof x === 'string');
  const products = (await db.query<{ name: string }>(`SELECT name FROM product WHERE persona_id = $1 AND status <> 'retired' LIMIT 20`, [personaId])).map((r) => r.name);
  const history = (await db.query<{ title: string }>(`SELECT title FROM idea WHERE persona_id = $1 ORDER BY created_at DESC LIMIT 80`, [personaId])).map((r) => r.title);
  return { ...p, terms: [p.niche, p.sub_niche ?? '', ...pillars, ...products].filter(Boolean), history };
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number.isFinite(Number(v)) ? Number(v) : null);

export async function shortlistFor(db: Db, personaId: string, now: Date, opts: { limit?: number; includeRemixed?: boolean } = {}): Promise<ShortlistItem[]> {
  const p = await personaProfile(db, personaId);
  const rows = await db.query<{
    id: string;
    platform: 'instagram' | 'tiktok';
    handle: string;
    url: string | null;
    kind: 'video' | 'image' | 'carousel';
    format: PostFormat | null;
    hook_type: string | null;
    topic: string | null;
    caption: string | null;
    hashtags: string[];
    outlier_score: string;
    tier: 'outlier' | 'strong';
    views: string | null;
    views_per_follower: string | null;
    depth: string | null;
    duration_s: string | null;
    posted_at: Date | null;
    analysis: { replicability?: number; structure?: string } | null;
    remixed: boolean;
  }>(
    `SELECT r.id, r.platform, r.handle, r.url, r.kind, r.format, r.hook_type, r.topic, r.caption, r.hashtags, r.outlier_score, r.tier, r.views,
            r.views_per_follower, r.depth, r.duration_s, r.posted_at, r.analysis,
            EXISTS (SELECT 1 FROM remix_brief b WHERE b.persona_id = $2 AND b.radar_post_id = r.id) AS remixed
       FROM radar_post r
      WHERE r.studio_id = $1 AND r.niche = $3 AND r.outlier_score >= $4 AND r.posted_at > $5
      ORDER BY r.outlier_score DESC LIMIT 200`,
    [p.studio_id, personaId, nicheKey(p.niche), OUTLIER.outlier, new Date(now.getTime() - OUTLIER.recencyDays * 86_400_000)],
  );
  const items = rows
    .filter((r) => opts.includeRemixed || !r.remixed)
    .map((r): ShortlistItem => {
      const outlier = Number(r.outlier_score);
      const rec = recency(r.posted_at ? new Date(r.posted_at) : null, now);
      const replicability = typeof r.analysis?.replicability === 'number' ? r.analysis.replicability : heuristicReplicability(r.kind, num(r.duration_s));
      // Fit and novelty are scored on our labels plus the post's tags (the caption is only read for overlap, never returned).
      const text = [r.topic ?? '', ...(r.hashtags ?? []), r.hook_type ?? '', r.caption ?? ''].join(' ');
      const monetisationFit = Math.min(1, coverage(text, p.terms));
      const nov = novelty([r.topic ?? '', HOOK_LABEL[(r.hook_type ?? 'other') as HookType] ?? '', r.format ?? ''].join(' '), p.history);
      const score = winnerScore({ outlier, viewsPerFollower: num(r.views_per_follower), depth: num(r.depth), recencyWeight: rec.weight, replicability, monetisationFit, novelty: nov });
      return {
        radar_post_id: r.id,
        platform: r.platform,
        handle: r.handle,
        url: r.url,
        kind: r.kind,
        format: r.format,
        hook_type: r.hook_type,
        hook_label: r.hook_type ? (HOOK_LABEL[r.hook_type as HookType] ?? null) : null,
        topic: r.topic,
        outlier,
        tier: r.tier,
        views: num(r.views),
        views_per_follower: num(r.views_per_follower),
        depth: num(r.depth),
        age_days: rec.ageDays,
        replicability,
        monetisation_fit: Math.round(monetisationFit * 1000) / 1000,
        novelty: nov,
        score,
        structure: r.analysis?.structure ?? null,
        remixed: r.remixed,
      };
    })
    .sort((a, b) => b.score - a.score || b.outlier - a.outlier);
  return items.slice(0, opts.limit ?? 10);
}

export interface InternalWinner {
  post_id: string;
  title: string;
  format: PostFormat;
  views: number;
  saves_shares: number;
  views_lift: number | null;
  depth_lift: number | null;
  published_at: Date;
}

/**
 * Our own winners: live posts published in the last 14 days and at least 24 h old whose views AND saves + shares beat
 * the persona's median over its last 20 posts by ≥ INTERNAL_WINNER_LIFT, all measured at 24 h (PRD §3.15.9): each
 * post's first snapshot captured the day after it went live, so a fresh post is never compared with cumulative
 * numbers of older ones. Posts with no 24 h snapshot are left out of both the candidates and the baseline.
 */
export async function internalWinners(db: Db, personaId: string, now: Date): Promise<InternalWinner[]> {
  const rows = await db.query<{ id: string; title: string | null; format: PostFormat; published_at: Date; views: number | null; ss: number | null }>(
    `SELECT p.id, COALESCE(cs.title, i.title, left(p.caption, 80)) AS title, p.format, p.published_at, m.views, (m.saves + m.shares) AS ss
       FROM post p
       LEFT JOIN calendar_slot cs ON cs.id = p.calendar_slot_id
       LEFT JOIN idea i ON i.id = cs.idea_id
       LEFT JOIN LATERAL (SELECT views, saves, shares FROM metric_snapshot ms
                           WHERE ms.post_id = p.id AND ms.captured_on >= (p.published_at AT TIME ZONE 'UTC')::date + 1
                           ORDER BY captured_on ASC LIMIT 1) m ON true
      WHERE p.persona_id = $1 AND p.status = 'live' AND p.published_at IS NOT NULL
      ORDER BY p.published_at DESC LIMIT 60`,
    [personaId],
  );
  const hist = rows.filter((r) => r.views !== null).map((r) => ({ id: r.id, views: Number(r.views), savesShares: Number(r.ss ?? 0) }));
  const out: InternalWinner[] = [];
  for (const r of rows) {
    if (r.views === null) continue;
    const age = now.getTime() - new Date(r.published_at).getTime();
    if (age < 86_400_000 || age > OUTLIER.recencyDays * 86_400_000) continue;
    const lift = internalLift({ id: r.id, views: Number(r.views), savesShares: Number(r.ss ?? 0) }, hist);
    if (lift.winner) {
      out.push({ post_id: r.id, title: r.title ?? 'untitled post', format: r.format, views: Number(r.views), saves_shares: Number(r.ss ?? 0), views_lift: lift.viewsLift, depth_lift: Number.isFinite(lift.depthLift ?? 0) ? lift.depthLift : null, published_at: new Date(r.published_at) });
    }
  }
  return out.sort((a, b) => (b.views_lift ?? 0) - (a.views_lift ?? 0));
}
