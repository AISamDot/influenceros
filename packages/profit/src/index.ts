import {
  type CadencePolicy,
  defaultCadence,
  defaultRouting,
  type JobHandlerMap,
  type ProviderEnv,
  type RoutingPolicy,
  type ScheduledTask,
  type ServiceBase,
  type ToolDef,
} from '@ios/agents';
import type { Providers } from '@ios/providers';

/**
 * @ios/profit (IOS-2 stream D): Profit Engine v1 (P&L read models, levers, lever log, forecast, kill candidates,
 * Weekly Profit Report, "make more profit" tool) and the scheduler behind the cron tick. See docs/IOS-2-CONTRACTS.md.
 */
export * from './types';

/** Cadence and format-mix levers. Stream D replaces the 10-post default. */
export function createCadencePolicy(base: ServiceBase): CadencePolicy {
  return defaultCadence(base);
}

/** Model-routing lever. Stream D replaces the no-override default. */
export function createRoutingPolicy(base: ServiceBase): RoutingPolicy {
  return defaultRouting(base);
}

// StudioModule exports, composed by @ios/wiring. Stream D fills these.
export const tools: ReadonlyArray<ToolDef<any, any>> = [];
export const jobs: JobHandlerMap = {};
export const schedules: readonly ScheduledTask[] = [];
export function liveProviders(_env: ProviderEnv): Partial<Providers> {
  return {};
}
