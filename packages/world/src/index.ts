import type { JobHandlerMap, ProviderEnv, ScheduledTask, ToolDef } from '@ios/agents';
import type { Providers } from '@ios/providers';
import { jobs as WORLD_JOB_HANDLERS, schedules as WORLD_SCHEDULES } from './jobs';
import { OpenMeteoWeather, PinterestApiV5 } from './live';
import { WORLD_TOOLS } from './tools';

/**
 * @ios/world (IOS-5 stream J, docs/IOS-5-CONTRACTS.md): World Bible, real-time grounding (Open-Meteo), storyline,
 * fact / continuity ledger, no-repeat engine (pgvector), Pinterest publishing and inspiration boards.
 */

export { createWorldService, loadWorld, groundingFor, updateBible, backfillWorld, ledgerOf, writeBible, adoptWorldInto, draftWorldWith } from './service';
export { computeGrounding, groundingChecks, LIVE_WINDOW_MS } from './grounding';
export { extractFacts, contradictions, continuityChecks, bibleFacts, type Fact, type LedgerFact } from './continuity';
export { checkConceptFingerprint, checkWording, recordFingerprint, seriesOf, NO_REPEAT } from './norepeat';
export { assignBeats, storylineView, weekOfArc, activeArc, arcBeats, refreshPlannedSlots } from './storyline';
export { steerStoryline, extendStoryline, addBeat, storylineUpkeep } from './upkeep';
export { searchInspiration, pickPins, describeBoard, moodBoard, listPins, cleanDescriptors, PINTEREST_APIFY, type PinRow } from './inspiration';
export { publishPin, ensureBoard, unpinned, aiDisclosure, isLivePinterest, PIN_KINDS } from './pinterest';
export { OpenMeteoWeather, PinterestApiV5, pinFromItem, wmoSummary } from './live';
export { buildBible, buildStoryline, fakeWorldDraft, ageFromArchetype, resolvePlace } from './draft';
export { placeFromText, type Place } from './geo';
export { holidaysNear, holidayCalendar, easter, nthWeekday } from './holidays';
export { mergeBible, asBible, asStoryline, type WorldBible, type Storyline, type CastMember, type RecurringPlace } from './model';
export { sunTimes, localParts, seasonOf } from './time';
export { WORLD_JOBS } from './jobs';
export { WORLD_TOOLS } from './tools';

// StudioModule exports, composed by @ios/wiring.
export const tools: ReadonlyArray<ToolDef<any, any>> = WORLD_TOOLS;
export const jobs: JobHandlerMap = WORLD_JOB_HANDLERS;
export const schedules: readonly ScheduledTask[] = WORLD_SCHEDULES;

/**
 * Pinterest goes live with `pinterest.access_token`. Open-Meteo has no key: its integration entry is live
 * (`liveAdapter: true`, no secrets), so it is served live whenever the process doesn't force fakes
 * (IOS_FAKE_PROVIDERS: tests, demos).
 */
export function liveProviders(env: ProviderEnv): Partial<Providers> {
  const out: { weather?: Providers['weather']; pinterest?: Providers['pinterest'] } = {};
  if (env.isLive('open-meteo')) out.weather = new OpenMeteoWeather();
  const token = env.isLive('pinterest') ? env.secret('pinterest.access_token') : null;
  if (token) out.pinterest = new PinterestApiV5(token);
  return out;
}
