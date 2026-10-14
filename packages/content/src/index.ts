import type { JobHandlerMap, ProviderEnv, ScheduledTask, ToolDef } from '@ios/agents';
import type { Providers } from '@ios/providers';

/**
 * @ios/content (IOS-2 stream B): weekly calendar, Scriptwriter + hook-lab, Monetization Agent v1, Compliance Gate v1,
 * QC Q1/Q2 and the idea → script → Q1 → Gate → media-queued pipeline. See docs/IOS-2-CONTRACTS.md.
 */

// StudioModule exports, composed by @ios/wiring. Stream B fills these.
export const tools: ReadonlyArray<ToolDef<any, any>> = [];
export const jobs: JobHandlerMap = {};
export const schedules: readonly ScheduledTask[] = [];
export function liveProviders(_env: ProviderEnv): Partial<Providers> {
  return {};
}
