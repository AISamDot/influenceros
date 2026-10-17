import type { JobHandlerMap, ProviderEnv, ScheduledTask, ToolDef } from '@ios/agents';
import type { Providers } from '@ios/providers';
import { jobs as F_JOBS, schedules as F_SCHEDULES } from './jobs';
import { F_TOOLS } from './tools';
import { ZernioPublisher } from './zernio';

/**
 * @ios/distribution (IOS-4 stream F): Zernio publishing (publish.prepare → post Q4 → Gate → approval → publish.post),
 * the community worker (comments, DMs, escalations, crisis handling, reply budgets), analytics ingestion (1h/24h/72h/7d
 * metric windows → Profit Engine and scorecards) and Settings → Accounts (setup sheet, AI-label tracking, vendor sync).
 * See docs/IOS-34-CONTRACTS.md.
 */
export {
  accountSetupSheet,
  AI_LABEL_STEPS,
  BIO_MAX,
  enqueueSync,
  INSTAGRAM_LOGIN_WARNING,
  type SetupSheet,
  type SetupSheetRow,
  SETUP_PLATFORMS,
  suggestBio,
  suggestHandle,
  syncAccounts,
  type SyncResult,
  updateAccount,
  upsertAccount,
} from './accounts';
export { dueWindows, enqueuePull, personaScorecard, pullMetrics, type PullResult, rollupAccountDay, type Scorecard } from './analytics';
export {
  approvedCrisisText,
  budgetLeft,
  classify,
  classifyHeuristic,
  type Classification,
  cleanReply,
  CRISIS_PURPOSE,
  DEFAULT_CRISIS_TEXT,
  dmLinkFor,
  enqueueHandle,
  escalate,
  handleCommunity,
  type HandleSummary,
  ingestComment,
  ingestDm,
  ingestEvents,
  isPaused,
  MAX_HANDLE_ATTEMPTS,
  mergeClassification,
  PRIVATE_REPLY_PLATFORMS,
  PRIVATE_REPLY_WINDOW_MS,
  pollCommunity,
  proposeCrisisText,
  REPLY_BUDGET,
  resolveEscalation,
  resumeUser,
  SLA_MS,
  templateReply,
} from './community';
export * from './platforms';
export { ANOMALY, detectAnomalies, recordTakedown, tripCircuitBreaker, type AnomalyFinding } from './anomalies';
export {
  applyPostStatus,
  enqueueDuePosts,
  ensureVendorMedia,
  parsePreparePayload,
  postQ4,
  preparePublish,
  type PrepareResult,
  publishOne,
  type PublishOutcome,
  syncLiveSlots,
} from './publishing';
export {
  assertAiFlagOptions,
  buildPostBody,
  DEFAULT_ZERNIO_PLATFORMS,
  echoedAiFlag,
  instagramAudioOptions,
  parseZernioEvent,
  ROUTES as ZERNIO_ROUTES,
  TIKTOK_ORIGINAL_SOUND_VOLUME,
  tiktokMusicOptions,
  ZERNIO_AI_FIELD,
  ZERNIO_BASE_URL,
  ZernioError,
  type ZernioPlatform,
  ZernioPublisher,
  type ZernioPublishRequest,
  type ZernioSnapshot,
} from './zernio';
export { JOB as DISTRIBUTION_JOBS, PREPARE_DEAD_LIMIT, sweepStuckPrepares } from './jobs';
export { F_TOOLS } from './tools';
export { fenceUntrusted } from './util';

// StudioModule exports, composed by @ios/wiring.
export const tools: ReadonlyArray<ToolDef<any, any>> = F_TOOLS;
export const jobs: JobHandlerMap = F_JOBS;
export const schedules: readonly ScheduledTask[] = F_SCHEDULES;

/** The live `publish` member (Zernio) when its key is present; webhooks verify with zernio.webhook_secret (optional). */
export function liveProviders(env: ProviderEnv): Partial<Providers> {
  if (!env.isLive('zernio')) return {};
  const apiKey = env.secret('zernio.api_key');
  if (!apiKey) return {};
  return { publish: new ZernioPublisher({ apiKey, webhookSecret: env.secret('zernio.webhook_secret'), baseUrl: process.env.ZERNIO_API_URL || undefined }) };
}
