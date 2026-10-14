import type { PersonaState } from '@ios/core';
import { type CadencePolicy, type CadenceTarget, DEFAULT_CADENCE, type KnowledgeService, type RoutingPolicy, type ServiceBase } from './contracts';

/** FR-4.3 winner column: ~17 a week (2–3 a day): 5 talking, 5 activity, 3 voiceover, 2 static, 2 carousel. */
export const WINNER_CADENCE: CadenceTarget = {
  postsPerWeek: 17,
  formatMix: { talking: 5, activity_text: 5, voiceover: 3, static: 2, carousel: 2 },
  purposeMix: { reach: 10, trust: 5, sell: 2 },
  source: 'default',
  reason: 'winner cadence (FR-4.3): 2–3 posts a day',
};
export const WINNER_STATES: readonly PersonaState[] = ['SCALING', 'BRAND'];

/**
 * The no-override target for a persona in `state`: the winner cadence for SCALING / BRAND, else DEFAULT_CADENCE.
 * Both the calendar and the Profit Engine's levers start from this, so a lever never builds on the wrong base.
 */
export const baseCadence = (state: PersonaState | null | undefined): CadenceTarget =>
  state && WINNER_STATES.includes(state) ? WINNER_CADENCE : DEFAULT_CADENCE;

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
