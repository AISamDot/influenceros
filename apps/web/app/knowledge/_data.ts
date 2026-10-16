import type { KnowledgeService } from '@ios/agents';
import type { Db } from '@ios/db';
import { createKnowledgeService } from '@ios/knowledge';
import type { Providers } from '@ios/providers';
import { resolveProviders } from '@ios/wiring';

/**
 * Stream C's server helpers for the Knowledge pages and routes. Providers are resolved once per server process so
 * the local embedding model loads once (it backs the search box's query embedding).
 */
const KEY = Symbol.for('influencer-os.knowledge-providers');
type G = typeof globalThis & { [KEY]?: Providers };

export function knowledgeProviders(): Providers {
  const g = globalThis as G;
  g[KEY] ??= resolveProviders();
  return g[KEY];
}

export function knowledgeService(db: Db): KnowledgeService {
  return createKnowledgeService({ db, providers: knowledgeProviders(), now: () => new Date() });
}

/** Niches with at least one persona that isn't killed or retired. */
export async function activeNiches(db: Db, studioId: string): Promise<string[]> {
  const rows = await db.query<{ niche: string }>(
    `SELECT DISTINCT lower(niche) AS niche FROM persona WHERE studio_id = $1 AND state NOT IN ('KILLED','RETIRED','ARCHIVED') ORDER BY 1`,
    [studioId],
  );
  return rows.map((r) => r.niche);
}

export const NICHE_RE = /^[a-z0-9][a-z0-9 &'()+,./-]{0,79}$/i;
