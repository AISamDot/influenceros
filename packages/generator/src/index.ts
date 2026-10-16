import type { JobHandlerMap, ProviderEnv, ScheduledTask, ToolDef } from '@ios/agents';
import type { Providers } from '@ios/providers';
import { GENERATOR_TOOLS } from './tools';

/**
 * @ios/generator: the Persona Generator (PRD §3.12, Owner decision 16 Oct) and the persona archive. The Owner
 * co-creates each persona with the Studio Manager in seven steps; the Owner alone approves the launch.
 */
export * from './types';
export * from './store';
export * from './steps';
export * from './review';
export * from './launch';
export * from './archive';
export * from './chat';
export { draftSummary, GENERATOR_TOOLS, CHAT_TOOLS } from './tools';
export { distinctness, draftSignature, archiveSignatures, studioSignatures, scoreConcept, lineFlags, similarity, bibleSignature } from './score';
export { higgsfieldLive } from './media';
export { NICHES, ARCHETYPES } from './library';

// StudioModule exports, composed by @ios/wiring.
export const tools: ReadonlyArray<ToolDef<any, any>> = GENERATOR_TOOLS;
export const jobs: JobHandlerMap = {};
export const schedules: readonly ScheduledTask[] = [];
export function liveProviders(_env: ProviderEnv): Partial<Providers> {
  return {};
}
