import { nullFormatPlans, type JobHandlerMap, type ProviderEnv, type FormatPlanService, type ScheduledTask, type ServiceFactory, type ToolDef } from '@ios/agents';
import type { Providers } from '@ios/providers';

/**
 * @ios/formats (IOS-5 stream L: per-persona Format Plans and the Stories engine).
 * Contract stub: stream L replaces these bodies and keeps the names and signatures. See docs/IOS-5-CONTRACTS.md.
 */

/** The FormatPlanService @ios/wiring puts on StudioServices (docs/IOS-5-CONTRACTS.md §5). Stub: the @ios/agents default. */
export const createFormatPlanService: ServiceFactory<FormatPlanService> = (base) => nullFormatPlans(base);

// StudioModule exports, composed by @ios/wiring.
export const tools: ReadonlyArray<ToolDef<any, any>> = [];
export const jobs: JobHandlerMap = {};
export const schedules: readonly ScheduledTask[] = [];
export function liveProviders(_env: ProviderEnv): Partial<Providers> {
  return {};
}
