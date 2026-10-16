import { nullWorld, type JobHandlerMap, type ProviderEnv, type WorldService, type ScheduledTask, type ServiceFactory, type ToolDef } from '@ios/agents';
import type { Providers } from '@ios/providers';

/**
 * @ios/world (IOS-5 stream J: World Bible, real-time grounding, storyline, continuity ledger, no-repeat engine and Pinterest).
 * Contract stub: stream J replaces these bodies and keeps the names and signatures. See docs/IOS-5-CONTRACTS.md.
 */

/** The WorldService @ios/wiring puts on StudioServices (docs/IOS-5-CONTRACTS.md §5). Stub: the @ios/agents default. */
export const createWorldService: ServiceFactory<WorldService> = (base) => nullWorld(base);

// StudioModule exports, composed by @ios/wiring.
export const tools: ReadonlyArray<ToolDef<any, any>> = [];
export const jobs: JobHandlerMap = {};
export const schedules: readonly ScheduledTask[] = [];
export function liveProviders(_env: ProviderEnv): Partial<Providers> {
  return {};
}
