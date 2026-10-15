import type { JobHandlerMap, ProviderEnv, ScheduledTask, ToolDef } from '@ios/agents';
import type { Providers } from '@ios/providers';

/**
 * @ios/products (IOS-4 stream H: Product Builder (brief or manuscript → styled HTML → PDF A4/Letter, templates), QC QP, listing packs).
 * Contract stub: stream H replaces these bodies and keeps the names and signatures. See docs/IOS-34-CONTRACTS.md.
 */

// StudioModule exports, composed by @ios/wiring.
export const tools: ReadonlyArray<ToolDef<any, any>> = [];
export const jobs: JobHandlerMap = {};
export const schedules: readonly ScheduledTask[] = [];
export function liveProviders(_env: ProviderEnv): Partial<Providers> {
  return {};
}
