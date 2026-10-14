import type { CadencePolicy, JobHandlerMap, ProviderEnv, RoutingPolicy, ScheduledTask, ServiceBase, ToolDef } from '@ios/agents';
import type { Providers } from '@ios/providers';
import { profitJobs, profitSchedules } from './module';
import { createCadencePolicyImpl, createRoutingPolicyImpl } from './policies';
import { profitTools } from './tools';

/**
 * @ios/profit (IOS-2 stream D): Profit Engine v1 (P&L read models, levers, lever log, forecast, kill candidates,
 * Weekly Profit Report, "make more profit" tool), the scheduler behind the cron tick and the queue worker loop.
 * See docs/IOS-2-CONTRACTS.md.
 */
export * from './types';
export * from './settings';
export * from './pnl';
export * from './forecast';
export * from './policies';
export * from './levers';
export * from './kill';
export * from './actions';
export * from './card';
export * from './report';
export * from './cycle';
export * from './scheduler';
export * from './worker';
export { PROFIT_JOBS, lastDailyMark, lastWeeklyMark } from './module';
export { periodRange } from './tools';

/** Cadence and format-mix levers → stream B's calendar (overrides written by the levers; default 10 a week). */
export function createCadencePolicy(base: ServiceBase): CadencePolicy {
  return createCadencePolicyImpl(base);
}

/** Model-routing lever → stream A's runtime (tier overrides; null = no override). */
export function createRoutingPolicy(base: ServiceBase): RoutingPolicy {
  return createRoutingPolicyImpl(base);
}

// StudioModule exports, composed by @ios/wiring.
export const tools: ReadonlyArray<ToolDef<any, any>> = profitTools;
export const jobs: JobHandlerMap = profitJobs;
export const schedules: readonly ScheduledTask[] = profitSchedules;
/** Stream D owns no provider members: the Profit Engine reads the ledger and runs its agent through the runtime. */
export function liveProviders(_env: ProviderEnv): Partial<Providers> {
  return {};
}
