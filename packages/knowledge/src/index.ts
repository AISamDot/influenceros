import { type JobHandlerMap, type KnowledgeService, nullKnowledge, type ProviderEnv, type ScheduledTask, type ServiceBase, type ToolDef } from '@ios/agents';
import type { Providers } from '@ios/providers';

/**
 * @ios/knowledge (IOS-2 stream C): Field Brain (Knowledge Builder, embeddings, pgvector retrieval), News Desk,
 * repo skills and the launch-persona importer. See docs/IOS-2-CONTRACTS.md.
 */

/** The KnowledgeService content agents read from. Stream C replaces the null default. */
export function createKnowledgeService(base: ServiceBase): KnowledgeService {
  return nullKnowledge(base);
}

// StudioModule exports, composed by @ios/wiring. Stream C fills these.
export const tools: ReadonlyArray<ToolDef<any, any>> = [];
export const jobs: JobHandlerMap = {};
export const schedules: readonly ScheduledTask[] = [];
export function liveProviders(_env: ProviderEnv): Partial<Providers> {
  return {};
}
