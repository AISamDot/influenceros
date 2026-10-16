import type { PersonaState } from '@ios/core';
import { type CadencePolicy, type CadenceTarget, DEFAULT_CADENCE, type KnowledgeService, type RoutingPolicy, type ServiceBase } from './contracts';
import {
  type CompiledPrompt,
  type FormatPlanService,
  type Grounding,
  NO_CAPTIONS,
  type PromptCompiler,
  type RadarService,
  type WorldService,
} from './ios5';

// >>> stream L winner cadence (IOS-5: L scales the new default proportionally to ~17)
/** FR-4.3 winner column: ~17 a week (2–3 a day): 5 talking, 5 activity, 3 voiceover, 2 static, 2 carousel. */
export const WINNER_CADENCE: CadenceTarget = {
  postsPerWeek: 17,
  formatMix: { talking: 5, activity_text: 5, voiceover: 3, static: 2, carousel: 2 },
  purposeMix: { reach: 10, trust: 5, sell: 2 },
  source: 'default',
  reason: 'winner cadence (FR-4.3): 2–3 posts a day',
};
// <<< stream L winner cadence
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

// ─── IOS-5 defaults (docs/IOS-5-CONTRACTS.md §5): used until the owning stream's package is wired, and in other
// streams' tests. Each stream replaces its own through its package's factory (composed by @ios/wiring). ───

/** No Radar data yet (stream I replaces): no benchmarks, no evidence, no patterns. */
export const nullRadar = (_base?: ServiceBase): RadarService => ({
  formatBenchmarks: async () => null,
  opportunityEvidence: async () => [],
  monetisationPatterns: async () => [],
});

/** No World Bible yet (stream J replaces): no grounding, no beats, no world checks, nothing recorded, nothing repeats, no mood board. */
export const nullWorld = (_base?: ServiceBase): WorldService => ({
  grounding: async () => null,
  beatsForWeek: async () => [],
  checkContent: async () => [],
  recordApproved: async () => undefined,
  checkConcept: async () => ({ ok: true, similarity: 0, nearest: null }),
  draftWorld: async () => null,
  adoptWorld: async () => undefined,
  moodBoard: async () => ({ pins: [], descriptors: [] }),
});

const groundingLine = (g: Grounding | null | undefined): string => (g ? g.block : '');

/**
 * A plain prompt compiler (stream K replaces it with the five-block compiler, character refs, location lock and
 * camera rotation). It keeps the two Owner rules every compiler keeps: the grounding block in every prompt and
 * "no captions or subtitles" in every video prompt.
 */
export const basicPromptCompiler = (_base?: ServiceBase): PromptCompiler => ({
  async image(spec): Promise<CompiledPrompt> {
    const blocks = {
      subject: spec.scene,
      wardrobe: spec.wardrobe ?? '',
      setting: spec.location ?? '',
      camera: spec.camera ? `${spec.camera.replace(/_/g, ' ')} camera` : 'handheld phone camera',
      lighting: groundingLine(spec.grounding),
    };
    return {
      text: Object.values(blocks).filter(Boolean).join(' '),
      blocks,
      references: [],
      camera: spec.camera ?? null,
      settings: { aspect: spec.aspect ?? '9:16' },
      notes: ['basic compiler (stream K not wired)'],
    };
  },
  async video(spec): Promise<CompiledPrompt> {
    const blocks = {
      start_frame: spec.startFrame,
      action: spec.action,
      camera_motion: spec.camera ? `${spec.camera.replace(/_/g, ' ')} camera` : 'handheld phone camera',
      audio: spec.line ? `Says: "${spec.line}"${spec.accent ? `, ${spec.accent}` : ''}.` : 'No speech.',
      constraints: [groundingLine(spec.grounding), NO_CAPTIONS].filter(Boolean).join(' '),
    };
    return {
      text: Object.values(blocks).filter(Boolean).join(' '),
      blocks,
      references: spec.startFrameUrl ? [spec.startFrameUrl] : [],
      camera: spec.camera ?? null,
      settings: { aspect: '9:16', duration_s: spec.durationS },
      notes: ['basic compiler (stream K not wired)'],
    };
  },
});

/** No Format Plans yet (stream L replaces): no recommendation, no plan (the cadence default applies), adopt is a no-op. */
export const nullFormatPlans = (_base?: ServiceBase): FormatPlanService => ({
  recommend: async () => null,
  planFor: async () => null,
  adoptPlan: async () => undefined,
});
