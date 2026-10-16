import { ApifyWeeklyCapError, enqueueOnceFor, type JobHandlerMap, type ScheduledTask, type StudioServices } from '@ios/agents';
import { BudgetExceededError, DeferJob, PublishBlockedError, SYSTEM } from '@ios/core';
import { describeBoard, searchInspiration } from './inspiration';
import { PIN_KINDS, type PinKind, publishPin, unpinned } from './pinterest';
import { liveWeather, loadWorld } from './service';
import { storylineUpkeep } from './upkeep';

/** Stream J jobs (`world.*`, `storyline.*`, `pinterest.*`, `inspiration.*`) and schedules. Schedules only enqueue. */

export const WORLD_JOBS = {
  weather: 'world.weather_refresh',
  upkeep: 'storyline.upkeep',
  pin: 'pinterest.publish_pin',
  sync: 'pinterest.sync',
  search: 'inspiration.search',
  describe: 'inspiration.describe',
} as const;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ACTIVE = `state NOT IN ('KILLED','RETIRED','ARCHIVED','PROPOSED')`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const uuid = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw new Error(`${what} must be a uuid`);
  return v;
};

/** Defers instead of failing when a cap or a kill switch stops the work (it resumes when that clears). */
async function deferring<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApifyWeeklyCapError) throw new DeferJob(DAY, err.message);
    if (err instanceof BudgetExceededError) throw new DeferJob(6 * HOUR, err.message);
    if (err instanceof PublishBlockedError) throw new DeferJob(6 * HOUR, err.message);
    throw err;
  }
}

export const jobs: JobHandlerMap = {
  async [WORLD_JOBS.weather]({ services, job }) {
    const personaId = uuid(job.persona_id ?? job.payload.personaId, 'personaId');
    const w = await loadWorld(services.db, personaId);
    if (!w) return { skipped: 'no World Bible' };
    const now = services.now();
    const lw = await liveWeather(services, personaId, w.bible, now);
    return { ok: !!lw, summary: lw?.summary ?? null };
  },
  async [WORLD_JOBS.upkeep]({ services, job }) {
    const personaId = uuid(job.persona_id ?? job.payload.personaId, 'personaId');
    return storylineUpkeep(services, personaId, SYSTEM);
  },
  async [WORLD_JOBS.pin]({ services, job }) {
    const personaId = uuid(job.persona_id ?? job.payload.personaId, 'personaId');
    const kind = str(job.payload.kind) as PinKind | null;
    if (!kind || !PIN_KINDS.includes(kind)) throw new Error('kind must be product or carousel');
    const refId = uuid(job.payload.refId, 'refId');
    return deferring(() => publishPin(services, { personaId, kind, refId, link: str(job.payload.link) }));
  },
  async [WORLD_JOBS.sync]({ services, job }) {
    const studioId = uuid(job.studio_id ?? job.payload.studioId, 'studioId');
    let queued = 0;
    for (const x of await unpinned(services, studioId)) {
      if (await enqueueOnceFor(services.db, { kind: WORLD_JOBS.pin, key: `pin:${x.kind}:${x.refId}`, payload: { personaId: x.personaId, kind: x.kind, refId: x.refId }, studioId, personaId: x.personaId, priority: 160 })) queued++;
    }
    return { queued };
  },
  async [WORLD_JOBS.search]({ services, job }) {
    const studioId = uuid(job.studio_id ?? job.payload.studioId, 'studioId');
    const query = str(job.payload.query);
    if (!query) throw new Error('query is required');
    const r = await deferring(() =>
      searchInspiration(services, { studioId, query, draftId: str(job.payload.draftId), personaId: str(job.payload.personaId), limit: typeof job.payload.limit === 'number' ? job.payload.limit : undefined }),
    );
    return { source: r.source, pins: r.pins.length, costUsd: r.costUsd };
  },
  async [WORLD_JOBS.describe]({ services, job }) {
    const studioId = uuid(job.studio_id ?? job.payload.studioId, 'studioId');
    const descriptors = await deferring(() => describeBoard(services, { studioId, draftId: str(job.payload.draftId), personaId: str(job.payload.personaId) }));
    return { descriptors: descriptors.length };
  },
};

async function personasWithWorld(services: StudioServices): Promise<Array<{ id: string; studio_id: string }>> {
  return services.db.query(`SELECT p.id, p.studio_id FROM persona p JOIN world_bible w ON w.persona_id = p.id WHERE p.${ACTIVE} ORDER BY p.created_at`);
}

const every = (ms: number): ScheduledTask['due'] => (now, last) => !last || now.getTime() - last.getTime() >= ms;
const dailyAt = (hourUtc: number): ScheduledTask['due'] => (now, last) => {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc);
  return now.getTime() >= today && (!last || last.getTime() < today);
};

export const schedules: readonly ScheduledTask[] = [
  {
    // Hourly: refresh the weather cache for personas with a World Bible (grounding reads it for 30 minutes).
    name: 'world.weather',
    due: every(HOUR),
    async run(services, now) {
      let queued = 0;
      const hour = now.toISOString().slice(0, 13);
      for (const p of await personasWithWorld(services)) {
        if (await enqueueOnceFor(services.db, { kind: WORLD_JOBS.weather, key: `weather:${p.id}:${hour}`, payload: { personaId: p.id }, studioId: p.studio_id, personaId: p.id, priority: 200 })) queued++;
      }
      return { queued };
    },
  },
  {
    // Daily 04:00 UTC: storyline upkeep (beats on posted slots become used; a new season near the end of the arc).
    name: 'storyline.upkeep',
    due: dailyAt(4),
    async run(services, now) {
      let queued = 0;
      const day = now.toISOString().slice(0, 10);
      for (const p of await personasWithWorld(services)) {
        if (await enqueueOnceFor(services.db, { kind: WORLD_JOBS.upkeep, key: `upkeep:${p.id}:${day}`, payload: { personaId: p.id }, studioId: p.studio_id, personaId: p.id, priority: 170 })) queued++;
      }
      return { queued };
    },
  },
  {
    // Daily 06:00 UTC: pin live products and carousels to each persona's Pinterest board.
    name: 'pinterest.sync',
    due: dailyAt(6),
    async run(services, now) {
      const studios = await services.db.query<{ id: string }>('SELECT id FROM studio ORDER BY created_at');
      const day = now.toISOString().slice(0, 10);
      let queued = 0;
      for (const s of studios) {
        if (await enqueueOnceFor(services.db, { kind: WORLD_JOBS.sync, key: `pinsync:${s.id}:${day}`, payload: { studioId: s.id }, studioId: s.id, priority: 180 })) queued++;
      }
      return { queued };
    },
  },
];
