import type { JobHandlerMap, ProviderEnv, ScheduledTask, ToolDef } from '@ios/agents';
import type { Providers } from '@ios/providers';

/**
 * @ios/media (IOS-3 stream E: Higgsfield adapter (Soul ID, stills, activity clips, Seedance talking), voice, render worker for the 5 formats, QC Q3/Q4, media.render).
 * Contract stub: stream E replaces these bodies and keeps the names and signatures. See docs/IOS-34-CONTRACTS.md.
 */

// StudioModule exports, composed by @ios/wiring.
export const tools: ReadonlyArray<ToolDef<any, any>> = [];
export const jobs: JobHandlerMap = {};
export const schedules: readonly ScheduledTask[] = [];
export function liveProviders(_env: ProviderEnv): Partial<Providers> {
  return {};
}
