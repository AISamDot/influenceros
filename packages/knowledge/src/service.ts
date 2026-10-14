import type { Briefing, BriefingItem, Citation, KnowledgeHit, KnowledgeService, ReactionIdea, ServiceBase } from '@ios/agents';
import type { Db } from '@ios/db';
import { EMBEDDING_DIM } from '@ios/providers';
import { clamp, shortQuote, toVector, trimText } from './util';

/**
 * The KnowledgeService content agents read (Scriptwriter, Monetization, Community): similarity search over the
 * niche's Field Brain nodes and recent news (pgvector, cosine), plus each persona's latest morning briefing.
 * Every hit carries an id to store as the claim's evidence (FR-23.3) and its citations.
 */
export function createKnowledgeService(base: ServiceBase): KnowledgeService {
  return {
    retrieve: (q) => retrieve(base, q),
    latestBriefing: (personaId) => latestBriefing(base.db, personaId),
  };
}

export interface RetrieveQuery {
  studioId: string;
  niche: string;
  query: string;
  k?: number;
  kinds?: ReadonlyArray<'node' | 'news'>;
}

/** How far back news stays retrievable. Reddit threads are audience signal (hooks, language), never evidence. */
export const NEWS_WINDOW_DAYS = 30;

interface NodeRow {
  id: string;
  niche: string;
  title: string;
  synthesis: string | null;
  facts: Array<{ claim: string; citations?: Array<{ url: string; title?: string; quote?: string; source_id?: string }> }>;
  notes: { seed_citations?: Array<{ source_id: string; url: string | null; title: string }>; seed_facts?: string | null };
  last_verified_at: Date | null;
  sim: number;
}

interface NewsRow {
  id: string;
  niche: string;
  title: string;
  url: string;
  summary: string | null;
  source: string | null;
  source_id: string | null;
  published_at: Date | null;
  created_at: Date;
  sim: number;
}

export async function retrieve(base: ServiceBase, q: RetrieveQuery): Promise<KnowledgeHit[]> {
  const query = q.query.trim();
  if (!query || !q.niche.trim()) return [];
  const k = clamp(Math.trunc(q.k ?? 5), 1, 25);
  const kinds = new Set(q.kinds?.length ? q.kinds : (['node', 'news'] as const));
  const since = new Date(base.now().getTime() - NEWS_WINDOW_DAYS * 86_400_000);
  let vec: number[] | null = null;
  try {
    const [v] = await base.providers.embeddings.embed([query.slice(0, 2000)]);
    vec = v && v.length === EMBEDDING_DIM ? v : null;
  } catch (err) {
    // The local model can be unavailable (first download offline): fall back to keyword search, never fail the caller.
    console.warn(`[knowledge] embedding the query failed, using keyword search: ${err instanceof Error ? err.message : String(err)}`);
  }
  const model = base.providers.embeddings.name;
  const hits: KnowledgeHit[] = [];
  if (kinds.has('node')) {
    const rows = vec ? await nodeSimilarity(base.db, q.studioId, q.niche, toVector(vec), model, k) : [];
    const use = rows.length ? rows : await nodeKeyword(base.db, q.studioId, q.niche, query, k);
    hits.push(...use.map(nodeHit));
  }
  if (kinds.has('news')) {
    const rows = vec ? await newsSimilarity(base.db, q.studioId, q.niche, toVector(vec), model, since, k) : [];
    const use = rows.length ? rows : await newsKeyword(base.db, q.studioId, q.niche, query, since, k);
    hits.push(...use.map(newsHit));
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, k);
}

const NODE_COLS = `id, niche, title, synthesis, facts, notes, last_verified_at`;

function nodeSimilarity(db: Db, studioId: string, niche: string, vec: string, model: string, k: number): Promise<NodeRow[]> {
  return db.query<NodeRow>(
    `SELECT ${NODE_COLS}, 1 - ((embedding::vector(384)) <=> $3::vector(384)) AS sim
       FROM knowledge_node
      WHERE studio_id = $1 AND lower(niche) = lower($2) AND vector_dims(embedding) = 384 AND embedding_model = $4
      ORDER BY (embedding::vector(384)) <=> $3::vector(384)
      LIMIT $5`,
    [studioId, niche, vec, model, k],
  );
}

const NEWS_COLS = `n.id, n.niche, n.title, n.url, n.summary, n.raw->>'source' AS source, n.source_id, n.published_at, n.created_at`;

function newsSimilarity(db: Db, studioId: string, niche: string, vec: string, model: string, since: Date, k: number): Promise<NewsRow[]> {
  return db.query<NewsRow>(
    `SELECT ${NEWS_COLS}, 1 - ((n.embedding::vector(384)) <=> $3::vector(384)) AS sim
       FROM news_item n
      WHERE n.studio_id = $1 AND lower(n.niche) = lower($2) AND n.duplicate_of IS NULL AND n.created_at >= $5 AND n.kind <> 'reddit'
        AND vector_dims(n.embedding) = 384 AND n.embedding_model = $4
      ORDER BY (n.embedding::vector(384)) <=> $3::vector(384)
      LIMIT $6`,
    [studioId, niche, vec, model, since, k],
  );
}

const tokens = (s: string) => [...new Set(s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])].slice(0, 12);

async function nodeKeyword(db: Db, studioId: string, niche: string, query: string, k: number): Promise<NodeRow[]> {
  const words = tokens(query);
  if (!words.length) return [];
  const rows = await db.query<NodeRow & { hits: number }>(
    `SELECT ${NODE_COLS}, (SELECT count(*) FROM unnest($3::text[]) w WHERE lower(title || ' ' || coalesce(synthesis,'')) LIKE '%' || w || '%')::int AS hits
       FROM knowledge_node WHERE studio_id = $1 AND lower(niche) = lower($2)
      ORDER BY hits DESC, title LIMIT $4`,
    [studioId, niche, words, k],
  );
  return rows.filter((r) => r.hits > 0).map((r) => ({ ...r, sim: (r.hits / words.length) * 0.5 }));
}

async function newsKeyword(db: Db, studioId: string, niche: string, query: string, since: Date, k: number): Promise<NewsRow[]> {
  const words = tokens(query);
  if (!words.length) return [];
  const rows = await db.query<NewsRow & { hits: number }>(
    `SELECT ${NEWS_COLS}, (SELECT count(*) FROM unnest($3::text[]) w WHERE lower(n.title || ' ' || coalesce(n.summary,'')) LIKE '%' || w || '%')::int AS hits
       FROM news_item n WHERE n.studio_id = $1 AND lower(n.niche) = lower($2) AND n.duplicate_of IS NULL AND n.created_at >= $4 AND n.kind <> 'reddit'
      ORDER BY hits DESC, n.score DESC NULLS LAST LIMIT $5`,
    [studioId, niche, words, since, k],
  );
  return rows.filter((r) => r.hits > 0).map((r) => ({ ...r, sim: (r.hits / words.length) * 0.5 }));
}

function nodeHit(r: NodeRow): KnowledgeHit {
  const citations: Citation[] = [];
  const seen = new Set<string>();
  const push = (c: Citation) => {
    if (!c.url || seen.has(c.url) || citations.length >= 6) return;
    seen.add(c.url);
    citations.push(c);
  };
  for (const f of r.facts ?? []) {
    for (const c of f.citations ?? []) push({ url: c.url, title: c.title, quote: shortQuote(c.quote), sourceId: c.source_id });
  }
  for (const c of r.notes?.seed_citations ?? []) if (c.url) push({ url: c.url, title: c.title, sourceId: c.source_id });
  const claims = (r.facts ?? []).slice(0, 4).map((f) => f.claim).filter(Boolean);
  const text = [r.synthesis ?? '', claims.length ? `Key facts: ${claims.join(' · ')}` : r.notes?.seed_facts ? `Seed facts: ${r.notes.seed_facts}` : '']
    .filter(Boolean)
    .join('\n');
  return {
    kind: 'node',
    id: r.id,
    niche: r.niche,
    title: r.title,
    text: trimText(text, 1200),
    citations,
    score: clamp(Number(r.sim) || 0, 0, 1),
    lastVerifiedAt: r.last_verified_at ? new Date(r.last_verified_at) : null,
  };
}

function newsHit(r: NewsRow): KnowledgeHit {
  return {
    kind: 'news',
    id: r.id,
    niche: r.niche,
    title: r.title,
    text: trimText(r.summary ?? r.title, 800),
    citations: [{ url: r.url, title: r.source ?? r.title, sourceId: r.source_id ?? undefined }],
    score: clamp(Number(r.sim) || 0, 0, 1),
    lastVerifiedAt: new Date(r.published_at ?? r.created_at),
  };
}

// ───────────────────────────── Briefings ─────────────────────────────

interface BriefingRow {
  persona_id: string;
  date: string;
  items: Array<{ news_item_id: string; title: string; url: string; why_it_matters: string; take: string; score: number }>;
  reaction_ideas: Array<{ news_item_id: string; title: string; angle: string; hook?: string; expires_at: string }>;
}

export function toBriefing(r: BriefingRow): Briefing {
  const items: BriefingItem[] = r.items.map((i) => ({
    newsItemId: i.news_item_id,
    title: i.title,
    url: i.url,
    whyItMatters: i.why_it_matters,
    take: i.take,
    score: i.score,
  }));
  const reactionIdeas: ReactionIdea[] = r.reaction_ideas.map((x) => ({
    title: x.title,
    angle: x.angle,
    ...(x.hook ? { hook: x.hook } : {}),
    newsItemId: x.news_item_id,
    expiresAt: new Date(x.expires_at),
  }));
  return { personaId: r.persona_id, date: r.date, items, reactionIdeas };
}

export async function latestBriefing(db: Db, personaId: string): Promise<Briefing | null> {
  const r = await db.maybeOne<BriefingRow>(
    `SELECT persona_id, to_char(briefing_date, 'YYYY-MM-DD') AS date, items, reaction_ideas
       FROM news_briefing WHERE persona_id = $1 ORDER BY briefing_date DESC LIMIT 1`,
    [personaId],
  );
  return r ? toBriefing(r) : null;
}
