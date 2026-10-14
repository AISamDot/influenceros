import type { JobHandlerMap, StudioJobHandler } from '@ios/agents';
import { embedPending } from './embed';
import { buildFieldBrain, KNOWLEDGE_JOBS, researchNode } from './field-brain';
import { buildBriefing, NEWS_JOBS, scanNiche } from './news';
import { importPersonas, PERSONA_JOBS } from './personas';

/** Queue handlers (idempotent; `ctx.job` is passed through untouched). */

const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`job payload needs ${what}`);
  return v;
};
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

const build: StudioJobHandler = async ({ services, job }) => {
  const p = job.payload;
  return buildFieldBrain(services, {
    studioId: str(p.studioId ?? job.studio_id, 'studioId'),
    niche: str(p.niche, 'niche'),
    maxNodes: num(p.maxNodes),
    maxSources: num(p.maxSources),
    refreshDays: num(p.refreshDays),
  });
};

const research: StudioJobHandler = async ({ services, job }) => researchNode(services, str(job.payload.nodeId, 'nodeId'), { refreshDays: num(job.payload.refreshDays), force: job.payload.force === true });

const embed: StudioJobHandler = async ({ services, job, heartbeat }) => {
  let total = { nodes: 0, news: 0 };
  // Rounds of 200 rows; heartbeat between rounds so a long re-embed (a model switch) isn't reaped.
  for (let round = 0; round < 10; round++) {
    const r = await embedPending(services, { studioId: (job.payload.studioId as string | undefined) ?? job.studio_id ?? undefined, limit: 200 });
    total = { nodes: total.nodes + r.nodes, news: total.news + r.news };
    if (r.nodes + r.news < 200 || !(await heartbeat())) break;
  }
  return total;
};

const scan: StudioJobHandler = async ({ services, job }) =>
  scanNiche(services, { studioId: str(job.payload.studioId ?? job.studio_id, 'studioId'), niche: str(job.payload.niche, 'niche') });

const briefing: StudioJobHandler = async ({ services, job }) => {
  const r = await buildBriefing(services, {
    personaId: str(job.payload.personaId ?? job.persona_id, 'personaId'),
    date: typeof job.payload.date === 'string' ? job.payload.date : undefined,
    force: job.payload.force === true,
  });
  return r ? { date: r.briefing.date, items: r.briefing.items.length, reactions: r.briefing.reactionIdeas.length, created: r.created } : null;
};

const importJob: StudioJobHandler = async ({ services, job }) =>
  importPersonas(services, { studioId: (job.payload.studioId as string | undefined) ?? job.studio_id ?? undefined, dir: typeof job.payload.dir === 'string' ? job.payload.dir : undefined });

export const jobs: JobHandlerMap = {
  [KNOWLEDGE_JOBS.build]: build,
  [KNOWLEDGE_JOBS.researchNode]: research,
  [KNOWLEDGE_JOBS.embed]: embed,
  [NEWS_JOBS.scan]: scan,
  [NEWS_JOBS.briefing]: briefing,
  [PERSONA_JOBS.import]: importJob,
};
