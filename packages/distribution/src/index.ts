import type { JobHandlerMap, ProviderEnv, ScheduledTask, ToolDef } from '@ios/agents';
import type { Providers } from '@ios/providers';

/**
 * @ios/distribution (IOS-4 stream F: Zernio publishing, community worker (comments, DMs, escalations), analytics ingestion, Settings → Accounts).
 * Contract stub: stream F replaces these bodies and keeps the names and signatures. See docs/IOS-34-CONTRACTS.md.
 */

// StudioModule exports, composed by @ios/wiring.
export const tools: ReadonlyArray<ToolDef<any, any>> = [];
export const jobs: JobHandlerMap = {};
export const schedules: readonly ScheduledTask[] = [];
export function liveProviders(_env: ProviderEnv): Partial<Providers> {
  return {};
}
