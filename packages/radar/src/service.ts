import type { RadarService, ServiceFactory } from '@troupe/agents';
import { formatBenchmarks, monetisationPatterns, opportunityEvidence } from './insights';

/**
 * The RadarService on StudioServices (docs/IOS-5-CONTRACTS.md §5): niche format and cadence benchmarks for stream L's
 * Format Plan, opportunity evidence for Persona Generator step 1, and monetisation patterns for the Monetization
 * Agent. Reads only (the weekly jobs fill the tables); empty / null until the first Radar run for a niche.
 */
export const createRadarService: ServiceFactory<RadarService> = (base) => ({
  formatBenchmarks: (q) => formatBenchmarks(base.db, q.studioId, q.niche, base.now()),
  opportunityEvidence: (q) => opportunityEvidence(base.db, q.studioId, base.now(), { niches: q.niches, limit: q.limit }),
  monetisationPatterns: (q) => monetisationPatterns(base.db, q.studioId, q.niche),
});
