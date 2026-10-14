import { activeKillSwitches, budgetStatus, type PersonaRow } from '@ios/core';
import type { Db } from '@ios/db';

/**
 * Read models the managers' tools return (and the no-key replies are built from). Plain JSON-serialisable data,
 * numbers first. Money in cents, spend in USD.
 */

const SINCE_7D = "now() - interval '7 days'";

export interface PersonaSummary {
  id: string;
  slug: string;
  name: string;
  niche: string;
  state: string;
  autonomy: string;
  views_7d: number;
  followers: number;
  revenue_7d_cents: number;
  orders_7d: number;
  kill_proposed: boolean;
  days_live: number | null;
}

export async function personaSummaries(db: Db, studioId: string, personaId?: string): Promise<PersonaSummary[]> {
  return db.query<PersonaSummary>(
    `SELECT p.id, p.slug, p.name, p.niche, p.state, p.autonomy,
            COALESCE((SELECT SUM(views) FROM metric_snapshot m WHERE m.persona_id = p.id AND m.post_id IS NULL
                       AND m.captured_on > (${SINCE_7D})::date), 0)::int AS views_7d,
            COALESCE((SELECT followers FROM metric_snapshot m WHERE m.persona_id = p.id AND m.post_id IS NULL AND m.followers IS NOT NULL
                       ORDER BY captured_on DESC LIMIT 1), 0)::int AS followers,
            COALESCE((SELECT SUM(amount_cents) FROM orders o WHERE o.persona_id = p.id AND o.ordered_at > ${SINCE_7D}
                       AND o.status <> 'refunded'), 0)::int AS revenue_7d_cents,
            (SELECT count(*) FROM orders o WHERE o.persona_id = p.id AND o.ordered_at > ${SINCE_7D})::int AS orders_7d,
            EXISTS (SELECT 1 FROM approval a WHERE a.persona_id = p.id AND a.status = 'pending'
                     AND a.kind IN ('persona_kill','persona_retire')) AS kill_proposed,
            CASE WHEN p.launched_at IS NULL THEN NULL ELSE (now()::date - p.launched_at::date)::int END AS days_live
       FROM persona p
      WHERE p.studio_id = $1 AND ($2::uuid IS NULL OR p.id = $2)
      ORDER BY CASE p.state WHEN 'SCALING' THEN 0 WHEN 'BRAND' THEN 0 WHEN 'MONETISING' THEN 1 WHEN 'TESTING' THEN 2
                            WHEN 'RE_ANGLE' THEN 2 WHEN 'SETUP' THEN 3 WHEN 'PROPOSED' THEN 4 ELSE 5 END, p.name`,
    [studioId, personaId ?? null],
  );
}

export interface StudioOverview {
  personas: { active: number; by_state: Record<string, number> };
  last_7d: { views: number; revenue_cents: number; orders: number };
  approvals: { pending: number; kill_proposals: number };
  budget: { llm_usd: { used: number; limit: number | null }; hf_credits: { used: number; limit: number | null } };
  paused: Array<{ scope: string; persona_id: string | null; platform: string | null; reason: string | null }>;
  top: Array<{ name: string; views_7d: number; revenue_7d_cents: number }>;
}

export async function studioOverview(db: Db, studioId: string): Promise<StudioOverview> {
  const personas = await personaSummaries(db, studioId);
  const live = personas.filter((p) => p.state !== 'KILLED' && p.state !== 'RETIRED');
  const byState: Record<string, number> = {};
  for (const p of personas) byState[p.state] = (byState[p.state] ?? 0) + 1;
  const ap = await db.one<{ pending: number; kills: number }>(
    `SELECT count(*)::int AS pending, count(*) FILTER (WHERE kind IN ('persona_kill','persona_retire'))::int AS kills
       FROM approval WHERE studio_id = $1 AND status = 'pending'`,
    [studioId],
  );
  const [llm, credits, switches] = await Promise.all([
    budgetStatus(db, { studioId, unit: 'llm_usd' }),
    budgetStatus(db, { studioId, unit: 'hf_credits' }),
    activeKillSwitches(db, studioId),
  ]);
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    personas: { active: live.length, by_state: byState },
    last_7d: {
      views: personas.reduce((a, p) => a + p.views_7d, 0),
      revenue_cents: personas.reduce((a, p) => a + p.revenue_7d_cents, 0),
      orders: personas.reduce((a, p) => a + p.orders_7d, 0),
    },
    approvals: { pending: ap.pending, kill_proposals: ap.kills },
    budget: {
      llm_usd: { used: round(llm.studio.used), limit: llm.studio.limit },
      hf_credits: { used: round(credits.studio.used), limit: credits.studio.limit },
    },
    paused: switches.map((k) => ({ scope: k.scope, persona_id: k.persona_id, platform: k.platform, reason: k.reason })),
    top: [...live]
      .sort((a, b) => b.revenue_7d_cents - a.revenue_7d_cents || b.views_7d - a.views_7d)
      .slice(0, 3)
      .map((p) => ({ name: p.name, views_7d: p.views_7d, revenue_7d_cents: p.revenue_7d_cents })),
  };
}

export interface PersonaStatus extends PersonaSummary {
  timezone: string;
  bible_version: number | null;
  next_slots: Array<{ slot_at: string; title: string; format: string; purpose: string; status: string }>;
  pending_approvals: Array<{ id: string; kind: string; title: string }>;
  budget: { llm_usd: { used: number; limit: number | null }; hf_credits: { used: number; limit: number | null } };
  paused: boolean;
}

export async function personaStatus(db: Db, studioId: string, personaId: string): Promise<PersonaStatus | null> {
  const [summary] = await personaSummaries(db, studioId, personaId);
  if (!summary) return null;
  const p = await db.one<Pick<PersonaRow, 'timezone' | 'current_bible_version'>>('SELECT timezone, current_bible_version FROM persona WHERE id = $1', [personaId]);
  const slots = await db.query<{ slot_at: Date; title: string; format: string; purpose: string; status: string }>(
    `SELECT slot_at, title, format, purpose, status FROM calendar_slot WHERE persona_id = $1 AND slot_at > now() AND status <> 'skipped'
      ORDER BY slot_at LIMIT 3`,
    [personaId],
  );
  const approvals = await db.query<{ id: string; kind: string; title: string }>(
    `SELECT id, kind, title FROM approval WHERE persona_id = $1 AND status = 'pending' ORDER BY created_at`,
    [personaId],
  );
  const [llm, credits, switches] = await Promise.all([
    budgetStatus(db, { studioId, personaId, unit: 'llm_usd' }),
    budgetStatus(db, { studioId, personaId, unit: 'hf_credits' }),
    activeKillSwitches(db, studioId),
  ]);
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    ...summary,
    timezone: p.timezone,
    bible_version: p.current_bible_version,
    next_slots: slots.map((s) => ({ ...s, slot_at: new Date(s.slot_at).toISOString() })),
    pending_approvals: approvals,
    budget: {
      llm_usd: { used: round(llm.persona?.used ?? 0), limit: llm.persona?.limit ?? null },
      hf_credits: { used: round(credits.persona?.used ?? 0), limit: credits.persona?.limit ?? null },
    },
    paused: switches.some((k) => k.scope === 'global' || (k.scope === 'persona' && k.persona_id === personaId)),
  };
}

export async function recentPosts(db: Db, personaId: string, limit = 10) {
  return db.query<{ id: string; platform: string; format: string; caption: string | null; status: string; published_at: Date | null; views: number; saves: number; shares: number }>(
    `SELECT p.id, p.platform, p.format, left(p.caption, 140) AS caption, p.status, p.published_at,
            COALESCE(m.views, 0)::int AS views, COALESCE(m.saves, 0)::int AS saves, COALESCE(m.shares, 0)::int AS shares
       FROM post p
       LEFT JOIN LATERAL (SELECT views, saves, shares FROM metric_snapshot ms WHERE ms.post_id = p.id ORDER BY captured_on DESC LIMIT 1) m ON true
      WHERE p.persona_id = $1 AND p.status IN ('live','failed','scheduled','publishing')
      ORDER BY COALESCE(p.published_at, p.scheduled_at, p.created_at) DESC LIMIT $2`,
    [personaId, Math.min(Math.max(limit, 1), 50)],
  );
}

export interface BibleRow {
  version: number;
  status: string;
  content: Record<string, unknown>;
}

export async function latestBible(db: Db, personaId: string): Promise<BibleRow | null> {
  return db.maybeOne<BibleRow>(
    `SELECT version, status, content FROM persona_bible WHERE persona_id = $1 AND status <> 'superseded' ORDER BY version DESC LIMIT 1`,
    [personaId],
  );
}

export async function playbookRules(db: Db, studioId: string, personaId: string | null, limit = 20) {
  return db.query<{ id: string; scope: string; rule: string; source: string; status: string; created_at: Date }>(
    `SELECT id, scope, rule, source, status, created_at FROM playbook_rule
      WHERE studio_id = $1 AND status = 'active' AND (scope = 'studio' OR persona_id = $2)
      ORDER BY scope DESC, created_at DESC LIMIT $3`,
    [studioId, personaId, limit],
  );
}

export async function recentFeedback(db: Db, personaId: string, limit = 20) {
  return db.query<{ id: string; text: string; class: string | null; status: string; applied_change: unknown; created_at: Date }>(
    `SELECT id, text, class, status, applied_change, created_at FROM feedback WHERE persona_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [personaId, limit],
  );
}

/** Stable text of a persona's bible for prompt caching (sorted keys, no timestamps). */
export function bibleText(name: string, b: BibleRow | null): string {
  if (!b) return `# ${name}: Persona Bible\n\n(No bible yet.)`;
  const sort = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [c]) => a.localeCompare(c)).map(([k, x]) => [k, sort(x)])) : v;
  return `# ${name}: Persona Bible v${b.version}\n\n${JSON.stringify(sort(b.content), null, 1)}`;
}

export const usd = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
export const compact = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K` : String(n));
