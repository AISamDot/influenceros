import type { JobHandlerMap, ProviderEnv, ScheduledTask, ToolDef } from '@troupe/agents';
import type { Providers } from '@troupe/providers';
import { jobs as knowledgeJobs } from './jobs';
import { knowledgeLiveProviders } from './live';
import { schedules as knowledgeSchedules } from './schedules';
import { tools as knowledgeTools } from './tools';

/**
 * @troupe/knowledge (IOS-2 stream C): Field Brain (Knowledge Builder, embeddings, pgvector retrieval), News Desk,
 * the studio's repo skills and the launch-persona importer. See docs/IOS-2-CONTRACTS.md.
 */

/** The KnowledgeService content agents read from (`createKnowledgeService(base)`, composed by @troupe/wiring). */
export { createKnowledgeService, latestBriefing, NEWS_WINDOW_DAYS, retrieve, toBriefing } from './service';
export { buildFieldBrain, DEFAULT_MAX_NODES, fieldBrainStatus, type FieldBrainStatus, KNOWLEDGE_JOBS, researchNode } from './field-brain';
export {
  briefingText,
  buildBriefing,
  canonicalUrl,
  fakeBriefingDraft,
  feedsForNiche,
  googleNewsFeed,
  jaccard,
  NEWS_JOBS,
  newsKind,
  parseBriefingDraft,
  reactionQueue,
  sameStory,
  scanNiche,
  scoreItem,
  titleKey,
} from './news';
export { embedNews, embedNodes, embedPending, pendingEmbeddings } from './embed';
export { importPersonas, PERSONA_JOBS, personasSourceDir, syncPersonaDocs } from './personas';
export { requestFieldBrainBuild, requestNewsScan } from './requests';
export { readSkill, skillBlock, skillPath, skillsDir, validateSkills, validateSkillText } from './skills';
export * from './live';

// StudioModule exports, composed by @troupe/wiring.
export const tools: ReadonlyArray<ToolDef<any, any>> = knowledgeTools;
export const jobs: JobHandlerMap = knowledgeJobs;
export const schedules: readonly ScheduledTask[] = knowledgeSchedules;
export function liveProviders(env: ProviderEnv): Partial<Providers> {
  return knowledgeLiveProviders(env);
}
