import type { JobHandlerMap, ProviderEnv, ScheduledTask, ToolDef } from '@troupe/agents';
import type { Providers } from '@troupe/providers';
import { ApifyResearch } from './apify';
import { radarJobs, radarSchedules } from './jobs';
import { radarTools } from './tools';

/**
 * @troupe/radar (IOS-5 stream I): the Growth Radar, Winner Finder and Viral Remix (PRD §3.15 items 1, 9–12). Apify
 * scrapers (public data, low volume, every run through meteredApify and the weekly cap) → tracked accounts and
 * weekly snapshots → outlier scoring and growth curves → content reviews (Trend Scout, untrusted) → trend clusters →
 * the weekly Trend Report, format/cadence benchmarks for the Format Plan, monetisation patterns, Generator evidence,
 * and remix briefs booked as ideas. See docs/IOS-5-CONTRACTS.md §2 (stream I).
 */
export { createRadarService } from './service';
export { ApifyError, ApifyResearch, normalizeIgPost, normalizeIgProfile, normalizeTikTok, tiktokAuthor, type ScrapedPost, type ScrapedProfile } from './apify';
export { addSeeds, DEFAULT_ACTORS, DEFAULT_LIMITS, estimateUsd, loadConfig, nicheKey, resolveConfig, SCRAPER_KINDS, type RadarConfig, type ScraperKind } from './config';
export * from './scoring';
export { clusterTrends, TREND_DIMENSIONS, trendKey, type Trend, type TrendDimension, type TrendPost } from './cluster';
export { classifyCamera, classifyCta, classifyFormat, classifyHook, classifyMonetisation, classifyTopic, HOOK_LABEL, HOOK_TYPES, type HookType } from './classify';
export { demoAccount, demoDataset, installFakeFixtures } from './fixtures';
export { isoDate, runScrape, weekStartOf } from './scrape';
export { discoverNiche, nichesToScan, parseSeedAccount, type NicheScan } from './discovery';
export { snapshotNiche } from './snapshot';
export { scoreAccount, upsertAccount, upsertPost, upsertPosts, type PostUpsert } from './store';
export { heuristicReview, parseReview, reviewAccount, reviewNiche, reviewPrompt, REVIEW_SYSTEM } from './review';
export { detectTrends, FORMAT_LABEL, formatBenchmarks, latestTrends, monetisationPatterns, opportunityEvidence, pushDemandSignals, safeLabel, type TrendRow } from './insights';
export { internalWinners, shortlistFor, type InternalWinner, type ShortlistItem } from './winners';
export { createRemixBrief, doubleDown, REMIX_RULES, remixFormat, weeklyRemix, type RemixOutcome } from './remix';
export { postTrendReport, radarSummary, reportText, type RadarSummary } from './report';
export { enqueueWeekly, JOB as RADAR_JOB } from './jobs';
export { radarOverview, type RadarOverview } from './queries';

// StudioModule exports, composed by @troupe/wiring.
export const tools: ReadonlyArray<ToolDef<any, any>> = radarTools;
export const jobs: JobHandlerMap = radarJobs;
export const schedules: readonly ScheduledTask[] = radarSchedules;

/** The live `research` member (Apify) when the `apify` integration is live (its token is in env or the Keychain). */
export function liveProviders(env: ProviderEnv): Partial<Providers> {
  if (!env.isLive('apify')) return {};
  const token = env.secret('apify.token');
  return token ? { research: new ApifyResearch({ token }) } : {};
}
