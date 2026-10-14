import type { JobHandlerMap, ProviderEnv, ScheduledTask, ToolDef } from '@ios/agents';
import type { Providers } from '@ios/providers';
import { jobs as contentJobs, schedules as contentSchedules } from './jobs';
import { contentLiveProviders } from './live';
import { tools as contentTools } from './tools';

/**
 * @ios/content (IOS-2 stream B): weekly calendar, Scriptwriter + hook-lab, Monetization Agent v1, Compliance Gate v1,
 * QC Q1/Q2 and the idea → script → Q1 → Gate → media-queued pipeline. See docs/IOS-2-CONTRACTS.md.
 */
export * from './board';
export * from './calendar';
export * from './gate';
export * from './hooks';
export * from './monetization';
export * from './persona';
export * from './pipeline';
export * from './qc';
export * from './sample';
export * from './script';
export * from './tts';
export { ElevenLabsTranscriber, STT_USD_PER_HOUR } from './live';
export { enqueueMonetization, enqueuePlanWeek, enqueueSlot, JOB, reopenFailedSlot, runSlot, SLOT_DEAD_LIMIT } from './jobs';

// StudioModule exports, composed by @ios/wiring.
export const tools: ReadonlyArray<ToolDef<any, any>> = contentTools;
export const jobs: JobHandlerMap = contentJobs;
export const schedules: readonly ScheduledTask[] = contentSchedules;
export function liveProviders(env: ProviderEnv): Partial<Providers> {
  return contentLiveProviders(env);
}
