import { nullRadar, type JobHandlerMap, type ProviderEnv, type RadarService, type ScheduledTask, type ServiceFactory, type ToolDef } from '@ios/agents';
import type { Providers } from '@ios/providers';

/**
 * @ios/radar (IOS-5 stream I: Growth Radar, Winner Finder and Viral Remix (Apify scrapers, outlier scoring, trend clustering, remix briefs)).
 * Contract stub: stream I replaces these bodies and keeps the names and signatures. See docs/IOS-5-CONTRACTS.md.
 */

/** The RadarService @ios/wiring puts on StudioServices (docs/IOS-5-CONTRACTS.md §5). Stub: the @ios/agents default. */
export const createRadarService: ServiceFactory<RadarService> = (base) => nullRadar(base);

// StudioModule exports, composed by @ios/wiring.
export const tools: ReadonlyArray<ToolDef<any, any>> = [];
export const jobs: JobHandlerMap = {};
export const schedules: readonly ScheduledTask[] = [];
export function liveProviders(_env: ProviderEnv): Partial<Providers> {
  return {};
}
