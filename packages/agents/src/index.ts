import type { JobHandlerMap, ProviderEnv, ScheduledTask, ToolDef } from './contracts';
import type { Providers } from '@ios/providers';

/**
 * @ios/agents: the IOS-2 contracts (frozen, contracts.ts) plus the agent runtime, tool registry, Studio Manager
 * and Persona Manager (stream A).
 */
export * from './contracts';
export * from './defaults';
export { createToolRegistry } from './registry';
export { createFakeRuntime, createServices } from './runtime';

// StudioModule exports, composed by @ios/wiring. Stream A fills these.
export const tools: ReadonlyArray<ToolDef<any, any>> = [];
export const jobs: JobHandlerMap = {};
export const schedules: readonly ScheduledTask[] = [];
export function liveProviders(_env: ProviderEnv): Partial<Providers> {
  return {};
}
