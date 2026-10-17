import type { JobHandlerMap, ProviderEnv, ScheduledTask, ToolDef } from '@troupe/agents';
import type { Providers } from '@troupe/providers';
import { tools as productionTools } from './tools';

/**
 * @troupe/production (IOS-5 stream K): the production playbook (PRD §3.12 notes, §3.15 items 1–8, FR-4.3c's format
 * library). The prompt compiler (five image blocks, five video blocks, grounding, accent, 2.5–3 wps, no captions),
 * the 5-view character sheet + detail strip + identity stack + core refs, the BOPA look pack, the location lock and
 * consistency chain, the realism camera styles, the niche filter and the hook templates. Pure prompts and the
 * stream's tables live here; @troupe/media runs the generations (it imports this package, never the reverse).
 * See docs/IOS-5-CONTRACTS.md.
 */
export * from './camera';
export * from './compiler';
export * from './location';
export * from './niche';
export * from './read';
export * from './sheet';
export * from './store';
export { PRODUCTION_JOB } from './tools';

// StudioModule exports, composed by @troupe/wiring. The generation jobs (`look.build`, `production.lock_locations`) are
// registered by @troupe/media, which owns the Higgsfield spend.
export const tools: ReadonlyArray<ToolDef<any, any>> = productionTools;
export const jobs: JobHandlerMap = {};
export const schedules: readonly ScheduledTask[] = [];
export function liveProviders(_env: ProviderEnv): Partial<Providers> {
  return {};
}
