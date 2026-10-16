import type { JobHandlerMap, ProviderEnv, ScheduledTask, ToolDef } from '@ios/agents';
import type { Providers } from '@ios/providers';
import { formatsJobs, formatsSchedules } from './jobs';
import { formatsTools } from './tools';

/**
 * @ios/formats (IOS-5 stream L): per-persona Format Plans (PRD FR-4.3c) and the Stories engine (FR-4.3d).
 * See docs/IOS-5-CONTRACTS.md. The FormatPlanService goes on StudioServices through @ios/wiring.
 */

export { createFormatPlanService, mediaBudgetUsd } from './service';
export * from './catalog';
export * from './plan';
export * from './store';
export * from './stories';
export * from './curate';
export { enqueuePlanDay, scheduleStoryDays, STORY_DAY_STARTS_AT } from './jobs';
export { localDate, localTime } from './time';

// StudioModule exports, composed by @ios/wiring.
export const tools: ReadonlyArray<ToolDef<any, any>> = formatsTools;
export const jobs: JobHandlerMap = formatsJobs;
export const schedules: readonly ScheduledTask[] = formatsSchedules;
/** No live provider of its own: story publishing rides on stream F's Zernio adapter (story parts by stream L). */
export function liveProviders(_env: ProviderEnv): Partial<Providers> {
  return {};
}
