import type { StudioServices } from '@ios/agents';
import { BudgetExceededError, metered } from '@ios/core';
import { json } from '@ios/db';
import type { FieldMap, TopicResearch } from '@ios/providers';
import { embedNodes } from './embed';
import { skillBlock } from './skills';
import { deferOnBudget, enqueueOnce, hostOf, shortQuote, trimText } from './util';

/**
 * The Knowledge Builder (PRD §3.10, FR-23.1). One Field Brain per niche, shared by the personas in it:
 *   1. map the field (WebResearchProvider.mapField): source canon, expert map, curriculum skeleton;
 *   2. plan the curriculum up to ~120 nodes (the `knowledge-builder` agent, which only adds nodes);
 *   3. research each node (WebResearchProvider.researchTopic): cited synthesis, facts, frameworks, questions;
 *   4. embed each node for retrieval.
 * Steps 1–2 run in the `knowledge.build` job and enqueue one `knowledge.research_node` job per stale node, so a
 * build survives restarts and spreads its cost. Live research is Claude web search/fetch (metered as llm_usd
 * against the `knowledge` cost ref); fakes run the whole path with no key.
 */

export const DEFAULT_MAX_NODES = 120;
export const DEFAULT_MAX_SOURCES = 40;
/** Volatile levels (frontier, debate) are re-verified weekly… */
export const REFRESH_DAYS = 7;
/** …fundamentals, methods and myths every two months. */
export const STABLE_REFRESH_DAYS = 60;
/** At most this many already-researched nodes are re-researched per niche per build (stalest first), so the weekly
 *  refresh rolls over the Field Brain inside the PRD's ~$5–8 per persona per month instead of rebuilding it. */
export const REFRESH_CAP = 12;
/** A node that failed research this many times is left out of builds until someone forces it. */
export const MAX_RESEARCH_FAILURES = 3;
/** Holds for one paid research call, sized to its worst case (up to 4 streams of 16k output tokens on the standard
 *  tier, fetched pages, searches and a repair call), so concurrent workers can't overshoot a cap. */
export const RESEARCH_ESTIMATE_USD = { map: 1.5, topic: 1.2 } as const;
const VOLATILE_LEVELS = ['frontier', 'debate'];

export const KNOWLEDGE_JOBS = {
  build: 'knowledge.build',
  researchNode: 'knowledge.research_node',
  embed: 'knowledge.embed',
} as const;

const LEVELS = ['fundamental', 'intermediate', 'advanced', 'debate', 'myth', 'frontier'] as const;
type Level = (typeof LEVELS)[number];

export interface BuildOptions {
  studioId: string;
  niche: string;
  maxNodes?: number;
  maxSources?: number;
  /** Re-research nodes verified longer ago than this. */
  refreshDays?: number;
  /** Research nodes in this call instead of enqueueing jobs (CLI, tests). */
  inline?: boolean;
}

export interface BuildSummary {
  buildId: string;
  niche: string;
  mode: 'live' | 'fake';
  sources: number;
  experts: number;
  nodes: number;
  planned: number;
  queued: number;
  researched: number;
  costUsd: number;
}

const meterCtx = (studioId: string) => ({ studioId, personaId: null, agent: 'knowledge-builder', ref: { type: 'knowledge' as const, id: studioId } });

export async function buildFieldBrain(services: StudioServices, opts: BuildOptions): Promise<BuildSummary> {
  const { db, providers } = services;
  const niche = opts.niche.trim().toLowerCase();
  const maxNodes = opts.maxNodes ?? DEFAULT_MAX_NODES;
  const mode: 'live' | 'fake' = providers.webResearch.name.startsWith('fake') ? 'fake' : 'live';
  const build = await db.one<{ id: string }>(
    `INSERT INTO knowledge_build (studio_id, niche, mode, started_at) VALUES ($1, $2, $3, $4) RETURNING id`,
    [opts.studioId, niche, mode, services.now()],
  );
  let cost = 0;
  try {
    let map: FieldMap;
    try {
      map = await metered(
        db,
        meterCtx(opts.studioId),
        { unit: 'llm_usd', estimate: RESEARCH_ESTIMATE_USD.map, provider: providers.webResearch.name, operation: 'map_field' },
        () => providers.webResearch.mapField({ niche, maxSources: opts.maxSources ?? DEFAULT_MAX_SOURCES, maxNodes }),
        (r) => r.costUsd,
      );
    } catch (err) {
      deferOnBudget(err, `map ${niche}`);
    }
    cost += map.costUsd;
    const { sources, experts } = await upsertFieldMap(services, opts.studioId, niche, map);
    for (const c of map.curriculum) await insertNode(services, opts.studioId, niche, { path: c.path, title: c.title, level: c.level }, 'map');

    const planned = await planCurriculum(services, opts.studioId, niche, maxNodes);
    cost += planned.costUsd;

    // Never-researched nodes first (a new niche), then a capped slice of the stalest researched ones: volatile levels
    // after REFRESH_DAYS, the rest after STABLE_REFRESH_DAYS (or `refreshDays` for both, when given).
    const day = 86_400_000;
    const now = services.now().getTime();
    const volatileBefore = new Date(now - (opts.refreshDays ?? REFRESH_DAYS) * day);
    const stableBefore = new Date(now - (opts.refreshDays ?? STABLE_REFRESH_DAYS) * day);
    const healthy = `COALESCE((notes->>'research_failures')::int, 0) < ${MAX_RESEARCH_FAILURES}`;
    const fresh = await db.query<{ id: string }>(
      `SELECT id FROM knowledge_node WHERE studio_id = $1 AND lower(niche) = $2 AND researched_at IS NULL AND ${healthy}
        ORDER BY array_position($3::text[], level), path LIMIT $4`,
      [opts.studioId, niche, [...LEVELS], maxNodes],
    );
    const refresh = await db.query<{ id: string }>(
      `SELECT id FROM knowledge_node
        WHERE studio_id = $1 AND lower(niche) = $2 AND researched_at IS NOT NULL AND ${healthy}
          AND researched_at < CASE WHEN level = ANY($3::text[]) THEN $4::timestamptz ELSE $5::timestamptz END
        ORDER BY researched_at, path LIMIT $6`,
      [opts.studioId, niche, VOLATILE_LEVELS, volatileBefore, stableBefore, Math.min(REFRESH_CAP, maxNodes)],
    );
    const stale = [...fresh, ...refresh];
    let queued = 0;
    let researched = 0;
    for (const n of stale) {
      if (opts.inline) {
        const r = await researchNode(services, n.id, { refreshDays: opts.refreshDays });
        cost += r.costUsd;
        if (r.status === 'researched') researched += 1;
      } else if (await enqueueOnce(db, { kind: KNOWLEDGE_JOBS.researchNode, key: `node:${n.id}`, payload: { nodeId: n.id, buildId: build.id }, studioId: opts.studioId, priority: 120, maxAttempts: 2 })) {
        queued += 1;
      }
    }
    const total = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM knowledge_node WHERE studio_id = $1 AND lower(niche) = $2`, [opts.studioId, niche]);
    await db.query(
      `UPDATE knowledge_build SET status = 'done', nodes_total = $2, nodes_queued = $3, sources_total = $4, cost_usd = $5, finished_at = $6 WHERE id = $1`,
      [build.id, total.n, queued, sources, cost, services.now()],
    );
    return { buildId: build.id, niche, mode, sources, experts, nodes: total.n, planned: planned.added, queued, researched, costUsd: cost };
  } catch (err) {
    await db.query(`UPDATE knowledge_build SET status = 'failed', error = $2, cost_usd = $3, finished_at = $4 WHERE id = $1`, [
      build.id,
      err instanceof Error ? err.message.slice(0, 500) : String(err),
      cost,
      services.now(),
    ]);
    throw err;
  }
}

async function upsertFieldMap(services: StudioServices, studioId: string, niche: string, map: FieldMap): Promise<{ sources: number; experts: number }> {
  const { db } = services;
  for (const s of map.sources) {
    await db.query(
      `INSERT INTO knowledge_source (studio_id, niche, name, url, kind, canon, credibility, notes, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       ON CONFLICT (studio_id, niche, name) DO UPDATE
         SET url = COALESCE(knowledge_source.url, EXCLUDED.url), credibility = GREATEST(knowledge_source.credibility, EXCLUDED.credibility)`,
      [studioId, niche, trimText(s.name, 200), s.url, s.kind, s.credibility >= 4, Math.min(5, Math.max(1, Math.round(s.credibility))), s.notes ?? null, json({ origin: 'map' })],
    );
  }
  for (const e of map.experts) {
    await db.query(
      `INSERT INTO knowledge_source (studio_id, niche, name, url, kind, canon, credibility, notes, meta)
       VALUES ($1, $2, $3, $4, 'expert', false, 3, $5, $6::jsonb) ON CONFLICT (studio_id, niche, name) DO NOTHING`,
      [studioId, niche, trimText(e.name, 200), e.url ?? null, e.why, json({ origin: 'map', school: e.school })],
    );
  }
  const counts = await db.one<{ sources: number; experts: number }>(
    `SELECT count(*) FILTER (WHERE kind <> 'expert')::int AS sources, count(*) FILTER (WHERE kind = 'expert')::int AS experts
       FROM knowledge_source WHERE studio_id = $1 AND lower(niche) = $2`,
    [studioId, niche],
  );
  return counts;
}

const PATH_RE = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*){0,3}$/;

async function insertNode(
  services: StudioServices,
  studioId: string,
  niche: string,
  n: { path: string; title: string; level: string; questions?: readonly string[] },
  origin: 'map' | 'plan',
): Promise<boolean> {
  const path = n.path.toLowerCase().replace(/[^a-z0-9/-]+/g, '-').replace(/-+/g, '-').replace(/^[-/]+|[-/]+$/g, '').slice(0, 120);
  if (!PATH_RE.test(path) || !n.title.trim()) return false;
  const level: Level = (LEVELS as readonly string[]).includes(n.level) ? (n.level as Level) : 'intermediate';
  const rows = await services.db.query(
    `INSERT INTO knowledge_node (studio_id, niche, path, title, level, questions, origin)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) ON CONFLICT (studio_id, niche, path) DO NOTHING RETURNING id`,
    [studioId, niche, path, trimText(n.title, 200), level, json(n.questions ?? []), origin],
  );
  return rows.length > 0;
}

// ───────────────────────────── Curriculum planning (the knowledge-builder agent) ─────────────────────────────

export interface CurriculumPlan {
  nodes: Array<{ path: string; title: string; level: Level; questions: string[] }>;
}

export const CURRICULUM_PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['nodes'],
  properties: {
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'title', 'level', 'questions'],
        properties: {
          path: { type: 'string', description: "lowercase 'module/topic' slug" },
          title: { type: 'string' },
          level: { type: 'string', enum: [...LEVELS] },
          questions: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const;

export function parseCurriculumPlan(value: unknown): CurriculumPlan {
  const v = value as { nodes?: unknown };
  if (!v || !Array.isArray(v.nodes)) throw new Error('curriculum plan: expected { nodes: [] }');
  return {
    nodes: v.nodes
      .filter((n): n is Record<string, unknown> => !!n && typeof n === 'object')
      .map((n) => ({
        path: String(n.path ?? ''),
        title: String(n.title ?? ''),
        level: ((LEVELS as readonly string[]).includes(String(n.level)) ? n.level : 'intermediate') as Level,
        questions: Array.isArray(n.questions) ? n.questions.map(String).slice(0, 6) : [],
      }))
      .filter((n) => n.path && n.title),
  };
}

const PLANNER_SYSTEM = [
  'You are the Knowledge Builder for an AI influencer studio. You design the curriculum of a niche "Field Brain":',
  'topic nodes from fundamentals through intermediate and advanced methods, debates, common myths and the research frontier.',
  'Add only nodes that are missing from the existing curriculum, never duplicates. Paths are lowercase "module/topic" slugs.',
  'Each node lists 2-4 questions or misconceptions the research must answer. General education only: no individual',
  'medical, legal or financial advice topics, no specific securities or crypto picks. English only.',
].join(' ');

async function planCurriculum(services: StudioServices, studioId: string, niche: string, maxNodes: number): Promise<{ added: number; costUsd: number }> {
  const existing = await services.db.query<{ path: string; title: string; level: string | null }>(
    `SELECT path, title, level FROM knowledge_node WHERE studio_id = $1 AND lower(niche) = $2 ORDER BY path`,
    [studioId, niche],
  );
  const missing = maxNodes - existing.length;
  if (missing <= 0) return { added: 0, costUsd: 0 };
  const result = await services.runtime.run<CurriculumPlan>({
    agent: 'knowledge-builder',
    scope: { studioId, personaId: null },
    label: `field-brain plan: ${niche}`,
    system: PLANNER_SYSTEM,
    cached: [skillBlock('field-brain')],
    skills: ['field-brain'],
    prompt: JSON.stringify({
      niche,
      add_up_to: Math.min(missing, 60),
      target_total: maxNodes,
      existing: existing.map((e) => ({ path: e.path, title: e.title, level: e.level })),
    }),
    maxTokens: 8000,
    parse: parseCurriculumPlan,
    jsonSchema: CURRICULUM_PLAN_SCHEMA,
    // No key: keep the seed and the field map as they are (adding invented topics would only add noise).
    fake: () => ({ nodes: [] }),
    costRef: { type: 'knowledge', id: studioId },
  }).catch((err) => deferOnBudget(err, `plan ${niche}`));
  let added = 0;
  for (const n of result.output.nodes.slice(0, missing)) if (await insertNode(services, studioId, niche, n, 'plan')) added += 1;
  return { added, costUsd: result.costUsd };
}

// ───────────────────────────── Node research ─────────────────────────────

export interface ResearchResult {
  nodeId: string;
  status: 'researched' | 'skipped';
  costUsd: number;
}

interface NodeRow {
  id: string;
  studio_id: string;
  niche: string;
  path: string;
  title: string;
  level: string;
  questions: string[];
  researched_at: Date | null;
}

export async function researchNode(services: StudioServices, nodeId: string, opts: { refreshDays?: number; force?: boolean } = {}): Promise<ResearchResult> {
  const { db, providers } = services;
  const node = await db.maybeOne<NodeRow>('SELECT id, studio_id, niche, path, title, level, questions, researched_at FROM knowledge_node WHERE id = $1', [nodeId]);
  if (!node) return { nodeId, status: 'skipped', costUsd: 0 };
  const minAgeDays = opts.refreshDays ?? (VOLATILE_LEVELS.includes(node.level) ? REFRESH_DAYS : STABLE_REFRESH_DAYS);
  const fresh = node.researched_at && services.now().getTime() - new Date(node.researched_at).getTime() < minAgeDays * 86_400_000;
  if (fresh && !opts.force) return { nodeId, status: 'skipped', costUsd: 0 };
  let r: TopicResearch;
  try {
    r = await metered(
      db,
      meterCtx(node.studio_id),
      { unit: 'llm_usd', estimate: RESEARCH_ESTIMATE_USD.topic, provider: providers.webResearch.name, operation: 'research_topic' },
      () => providers.webResearch.researchTopic({ niche: node.niche, path: node.path, title: node.title, questions: node.questions, maxSources: 8 }),
      (x) => x.costUsd,
    );
  } catch (err) {
    // Real failures count up (a budget deferral doesn't); after MAX_RESEARCH_FAILURES the node leaves the builds.
    await db.query(
      `UPDATE knowledge_node SET research_error = $2,
              notes = CASE WHEN $3 THEN notes || jsonb_build_object('research_failures', COALESCE((notes->>'research_failures')::int, 0) + 1) ELSE notes END
        WHERE id = $1`,
      [nodeId, err instanceof Error ? err.message.slice(0, 500) : String(err), !(err instanceof BudgetExceededError)],
    );
    deferOnBudget(err, `research ${node.path}`);
  }
  const sourceIds = await registerSources(services, node.studio_id, node.niche, r.sources);
  const facts = r.facts.map((f) => ({
    claim: trimText(f.claim, 400),
    citations: f.citations.slice(0, 4).map((c) => ({ url: c.url, title: trimText(c.title, 200), quote: shortQuote(c.quote), source_id: sourceIds.get(c.url) ?? sourceIds.get(hostOf(c.url) ?? '') ?? null })),
  }));
  const now = services.now();
  await db.query(
    `UPDATE knowledge_node SET synthesis = $2, facts = $3::jsonb, frameworks = $4::jsonb, questions = $5::jsonb,
            last_verified_at = $6, researched_at = $6, research_error = NULL, notes = notes - 'research_failures', updated_at = $6
      WHERE id = $1`,
    [nodeId, trimText(r.synthesis, 4000), json(facts), json(r.frameworks.slice(0, 8)), json(r.questions.slice(0, 10)), now],
  );
  try {
    await embedNodes(services, [nodeId]);
  } catch (err) {
    // The research is saved; knowledge.embed_pending embeds the node later.
    console.warn(`[knowledge] embedding node ${node.path} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { nodeId, status: 'researched', costUsd: r.costUsd };
}

/** Research citations join the source list (not the canon) so facts can point at a knowledge_source row. */
async function registerSources(services: StudioServices, studioId: string, niche: string, sources: TopicResearch['sources']): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const s of sources.slice(0, 12)) {
    const host = hostOf(s.url);
    if (!host) continue;
    const known = await services.db.maybeOne<{ id: string }>(
      `SELECT id FROM knowledge_source WHERE studio_id = $1 AND lower(niche) = $2 AND url IS NOT NULL
          AND (url = $3 OR lower(split_part(split_part(url, '://', 2), '/', 1)) = $4)
        ORDER BY (url = $3) DESC, credibility DESC NULLS LAST LIMIT 1`,
      [studioId, niche, s.url, host],
    );
    const id =
      known?.id ??
      (
        await services.db.one<{ id: string }>(
          `INSERT INTO knowledge_source (studio_id, niche, name, url, kind, canon, credibility, meta)
           VALUES ($1, $2, $3, $4, 'publication', false, 3, $5::jsonb)
           ON CONFLICT (studio_id, niche, name) DO UPDATE SET url = COALESCE(knowledge_source.url, EXCLUDED.url) RETURNING id`,
          [studioId, niche, trimText(s.title || host, 200), s.url, json({ origin: 'research' })],
        )
      ).id;
    out.set(s.url, id);
    out.set(host, id);
  }
  return out;
}

// ───────────────────────────── Status ─────────────────────────────

export interface FieldBrainStatus {
  niche: string;
  nodes: number;
  researched: number;
  embedded: number;
  sources: number;
  canon: number;
  experts: number;
  feeds: number;
  lastVerifiedAt: Date | null;
  lastBuild: { status: string; startedAt: Date; finishedAt: Date | null; costUsd: number; mode: string } | null;
}

export async function fieldBrainStatus(services: Pick<StudioServices, 'db' | 'providers'>, studioId: string, niche?: string): Promise<FieldBrainStatus[]> {
  const rows = await services.db.query<Omit<FieldBrainStatus, 'lastBuild'> & { niche: string }>(
    `WITH niches AS (
       SELECT DISTINCT lower(niche) AS niche FROM persona WHERE studio_id = $1 AND state NOT IN ('KILLED','RETIRED')
       UNION SELECT DISTINCT lower(niche) FROM knowledge_node WHERE studio_id = $1)
     SELECT n.niche,
            (SELECT count(*) FROM knowledge_node k WHERE k.studio_id = $1 AND lower(k.niche) = n.niche)::int AS nodes,
            (SELECT count(*) FROM knowledge_node k WHERE k.studio_id = $1 AND lower(k.niche) = n.niche AND k.researched_at IS NOT NULL)::int AS researched,
            (SELECT count(*) FROM knowledge_node k WHERE k.studio_id = $1 AND lower(k.niche) = n.niche AND k.embedding_model = $3)::int AS embedded,
            (SELECT count(*) FROM knowledge_source s WHERE s.studio_id = $1 AND lower(s.niche) = n.niche AND s.kind NOT IN ('expert','rss'))::int AS sources,
            (SELECT count(*) FROM knowledge_source s WHERE s.studio_id = $1 AND lower(s.niche) = n.niche AND s.canon AND s.kind NOT IN ('expert','rss'))::int AS canon,
            (SELECT count(*) FROM knowledge_source s WHERE s.studio_id = $1 AND lower(s.niche) = n.niche AND s.kind = 'expert')::int AS experts,
            (SELECT count(*) FROM knowledge_source s WHERE s.studio_id = $1 AND lower(s.niche) = n.niche AND s.kind = 'rss')::int AS feeds,
            (SELECT max(last_verified_at) FROM knowledge_node k WHERE k.studio_id = $1 AND lower(k.niche) = n.niche) AS "lastVerifiedAt"
       FROM niches n WHERE ($2::text IS NULL OR n.niche = lower($2)) ORDER BY n.niche`,
    [studioId, niche ?? null, services.providers.embeddings.name],
  );
  const out: FieldBrainStatus[] = [];
  for (const r of rows) {
    const b = await services.db.maybeOne<{ status: string; started_at: Date; finished_at: Date | null; cost_usd: number; mode: string }>(
      `SELECT status, started_at, finished_at, cost_usd, mode FROM knowledge_build WHERE studio_id = $1 AND lower(niche) = $2 ORDER BY started_at DESC LIMIT 1`,
      [studioId, r.niche],
    );
    out.push({ ...r, lastBuild: b ? { status: b.status, startedAt: b.started_at, finishedAt: b.finished_at, costUsd: Number(b.cost_usd), mode: b.mode } : null });
  }
  return out;
}
