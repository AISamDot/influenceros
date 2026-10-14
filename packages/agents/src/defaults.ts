import { type CadencePolicy, DEFAULT_CADENCE, type KnowledgeService, type RoutingPolicy, type ServiceBase } from './contracts';

/**
 * Defaults used until the owning stream's implementation is wired in (and in other streams' tests):
 * no knowledge (stream C replaces), the 10-post default cadence and no routing overrides (stream D replaces).
 */
export const nullKnowledge = (_base?: ServiceBase): KnowledgeService => ({
  retrieve: async () => [],
  latestBriefing: async () => null,
});

export const defaultCadence = (_base?: ServiceBase): CadencePolicy => ({
  target: async () => DEFAULT_CADENCE,
});

export const defaultRouting = (_base?: ServiceBase): RoutingPolicy => ({
  tierFor: async () => null,
});
