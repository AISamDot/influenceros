import type { ServiceBase } from '@troupe/agents';
import { toVector, trimText } from './util';

/**
 * Embeddings for Field Brain nodes and news items. Every row records the provider that produced its vector
 * (`embedding_model`), so retrieval only compares vectors from the same model and a switch of embedder (fake →
 * local → Voyage) re-embeds the old rows instead of mixing vector spaces.
 */

export const EMBED_BATCH = 32;

interface NodeText {
  title: string;
  synthesis: string | null;
  facts: Array<{ claim?: string }> | null;
  questions: string[] | null;
  notes: { use?: Record<string, string>; seed_facts?: string | null } | null;
}

export function nodeEmbeddingText(n: NodeText): string {
  const claims = (n.facts ?? []).map((f) => f.claim).filter(Boolean).slice(0, 8).join(' ');
  const uses = Object.values(n.notes?.use ?? {}).join(' ');
  return trimText([n.title, n.synthesis ?? '', claims, n.notes?.seed_facts ?? '', (n.questions ?? []).slice(0, 4).join(' '), uses].join('\n'), 2000);
}

export function newsEmbeddingText(n: { title: string; summary: string | null }): string {
  return trimText(`${n.title}\n${n.summary ?? ''}`, 1500);
}

export async function embedNodes(base: ServiceBase, ids: readonly string[]): Promise<number> {
  if (!ids.length) return 0;
  const rows = await base.db.query<NodeText & { id: string }>(
    'SELECT id, title, synthesis, facts, questions, notes FROM knowledge_node WHERE id = ANY($1::uuid[])',
    [ids],
  );
  return embedRows(base, 'knowledge_node', rows.map((r) => ({ id: r.id, text: nodeEmbeddingText(r) })));
}

export async function embedNews(base: ServiceBase, ids: readonly string[]): Promise<number> {
  if (!ids.length) return 0;
  const rows = await base.db.query<{ id: string; title: string; summary: string | null }>(
    'SELECT id, title, summary FROM news_item WHERE id = ANY($1::uuid[])',
    [ids],
  );
  return embedRows(base, 'news_item', rows.map((r) => ({ id: r.id, text: newsEmbeddingText(r) })));
}

async function embedRows(base: ServiceBase, table: 'knowledge_node' | 'news_item', rows: Array<{ id: string; text: string }>): Promise<number> {
  const model = base.providers.embeddings.name;
  let done = 0;
  for (let i = 0; i < rows.length; i += EMBED_BATCH) {
    const batch = rows.slice(i, i + EMBED_BATCH);
    const vectors = await base.providers.embeddings.embed(batch.map((r) => r.text));
    for (const [j, r] of batch.entries()) {
      await base.db.query(`UPDATE ${table} SET embedding = $2::vector, embedding_model = $3 WHERE id = $1`, [r.id, toVector(vectors[j]!), model]);
      done += 1;
    }
  }
  return done;
}

/** Rows with no vector, or a vector from another embedder. */
export async function pendingEmbeddings(base: ServiceBase, studioId?: string): Promise<{ nodes: number; news: number }> {
  const model = base.providers.embeddings.name;
  const r = await base.db.one<{ nodes: number; news: number }>(
    `SELECT (SELECT count(*) FROM knowledge_node WHERE ($1::uuid IS NULL OR studio_id = $1)
              AND (embedding IS NULL OR embedding_model IS DISTINCT FROM $2))::int AS nodes,
            (SELECT count(*) FROM news_item WHERE ($1::uuid IS NULL OR studio_id = $1) AND duplicate_of IS NULL
              AND (embedding IS NULL OR embedding_model IS DISTINCT FROM $2))::int AS news`,
    [studioId ?? null, model],
  );
  return r;
}

/** Embeds up to `limit` pending rows (nodes first). Returns how many were embedded. */
export async function embedPending(base: ServiceBase, opts: { studioId?: string; limit?: number } = {}): Promise<{ nodes: number; news: number }> {
  const model = base.providers.embeddings.name;
  const limit = opts.limit ?? 500;
  const nodeIds = await base.db.query<{ id: string }>(
    `SELECT id FROM knowledge_node WHERE ($1::uuid IS NULL OR studio_id = $1) AND (embedding IS NULL OR embedding_model IS DISTINCT FROM $2)
      ORDER BY created_at LIMIT $3`,
    [opts.studioId ?? null, model, limit],
  );
  const nodes = await embedNodes(base, nodeIds.map((r) => r.id));
  const newsIds = await base.db.query<{ id: string }>(
    `SELECT id FROM news_item WHERE ($1::uuid IS NULL OR studio_id = $1) AND duplicate_of IS NULL
        AND (embedding IS NULL OR embedding_model IS DISTINCT FROM $2)
      ORDER BY created_at DESC LIMIT $3`,
    [opts.studioId ?? null, model, Math.max(0, limit - nodes)],
  );
  const news = await embedNews(base, newsIds.map((r) => r.id));
  return { nodes, news };
}

