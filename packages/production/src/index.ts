import { basicPromptCompiler, type JobHandlerMap, type ProviderEnv, type PromptCompiler, type ScheduledTask, type ServiceFactory, type ToolDef } from '@ios/agents';
import type { Providers } from '@ios/providers';

/**
 * @ios/production (IOS-5 stream K: production playbook (prompt compiler, character sheet, BOPA look pack, location lock, camera styles, niche filter, hook templates)).
 * Contract stub: stream K replaces these bodies and keeps the names and signatures. See docs/IOS-5-CONTRACTS.md.
 */

/** The PromptCompiler @ios/wiring puts on StudioServices (docs/IOS-5-CONTRACTS.md §5). Stub: the @ios/agents default. */
export const createPromptCompiler: ServiceFactory<PromptCompiler> = (base) => basicPromptCompiler(base);

// StudioModule exports, composed by @ios/wiring.
export const tools: ReadonlyArray<ToolDef<any, any>> = [];
export const jobs: JobHandlerMap = {};
export const schedules: readonly ScheduledTask[] = [];
export function liveProviders(_env: ProviderEnv): Partial<Providers> {
  return {};
}
