import type { JobHandlerMap, ScheduledTask, StudioServices } from '@troupe/agents';
import { heartbeat, type JobHandler, type JobRow, runOnce } from '@troupe/core';
import { studioTick } from './scheduler';

/**
 * The queue worker loop (docs/IOS-2-CONTRACTS.md §5.5). `pnpm worker` (apps/worker) runs it on the Mac; in dev the
 * Next server runs it inline (instrumentation.ts, TROUPE_WORKER) because only one process can open a PGlite dir.
 * It claims only the kinds it has handlers for (so `media.render` waits for IOS-3), gives each handler its
 * JobContext (services, the claimed row untouched, a heartbeat bound to the lease), and keeps the per-persona
 * isolation and retry rules of the core queue. Optionally it also runs the local tick every minute.
 */

export type WorkerOutcome = 'succeeded' | 'retry' | 'dead' | 'deferred' | 'lost';

export interface WorkerOptions {
  services: StudioServices;
  handlers: JobHandlerMap;
  workerId: string;
  /** Parallel claim loops (keep 1 on PGlite). */
  concurrency?: number;
  maxRunningPerPersona?: number;
  /** Sleep when the queue is empty. */
  idleMs?: number;
  /** Run the local tick (core tick + schedules) this often; 0 = never. */
  tickMs?: number;
  schedules?: readonly ScheduledTask[];
  log?: (line: string) => void;
}

export interface Worker {
  /** Claims and runs one due job; null when nothing is due. */
  runOne(): Promise<{ job: JobRow; outcome: WorkerOutcome } | null>;
  /** Runs due jobs until the queue is empty (or `max`); returns the outcomes. */
  drain(max?: number): Promise<Array<{ kind: string; outcome: WorkerOutcome }>>;
  /** One local tick. */
  tick(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
  readonly running: boolean;
}

const sleep = (ms: number, signal: { stopped: boolean }) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
    if (signal.stopped) {
      clearTimeout(t);
      resolve();
    }
  });

export function createWorker(opts: WorkerOptions): Worker {
  const { services } = opts;
  const log = opts.log ?? (() => {});
  const wrapped: Record<string, JobHandler> = {};
  for (const [kind, handler] of Object.entries(opts.handlers)) {
    wrapped[kind] = (job) => handler({ services, job, heartbeat: () => heartbeat(services.db, job, services.now()) });
  }
  const state = { stopped: true };
  let loops: Promise<void>[] = [];
  let ticker: ReturnType<typeof setInterval> | null = null;
  let ticking = false;

  const runOne: Worker['runOne'] = async () => {
    if (!Object.keys(wrapped).length) return null;
    const r = await runOnce(services.db, wrapped, {
      workerId: opts.workerId,
      maxRunningPerPersona: opts.maxRunningPerPersona ?? 1,
      now: services.now(),
    });
    if (r) log(`[worker] ${r.job.kind} ${r.job.id.slice(0, 8)} → ${r.outcome}`);
    return r;
  };

  const tickOnce = async () => {
    if (ticking || !opts.schedules) return;
    ticking = true;
    try {
      const r = await studioTick(services, opts.schedules);
      if (r.schedules.ran.length) log(`[tick] ran ${r.schedules.ran.join(', ')}`);
      if (r.errors.length) log(`[tick] errors: ${r.errors.join('; ')}`);
    } catch (err) {
      log(`[tick] ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      ticking = false;
    }
  };

  const loop = async () => {
    while (!state.stopped) {
      let r = null;
      try {
        r = await runOne();
      } catch (err) {
        log(`[worker] ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!r) await sleep(opts.idleMs ?? 2_000, state);
    }
  };

  return {
    runOne,
    async drain(max = 1_000) {
      const out: Array<{ kind: string; outcome: WorkerOutcome }> = [];
      for (let i = 0; i < max; i++) {
        const r = await runOne();
        if (!r) break;
        out.push({ kind: r.job.kind, outcome: r.outcome });
      }
      return out;
    },
    tick: tickOnce,
    start() {
      if (!state.stopped) return;
      state.stopped = false;
      loops = Array.from({ length: Math.max(1, opts.concurrency ?? 1) }, () => loop());
      const every = opts.tickMs ?? 0;
      if (every > 0 && opts.schedules) {
        void tickOnce();
        ticker = setInterval(() => void tickOnce(), every);
        ticker.unref?.();
      }
    },
    async stop() {
      state.stopped = true;
      if (ticker) clearInterval(ticker);
      ticker = null;
      await Promise.all(loops);
      loops = [];
    },
    get running() {
      return !state.stopped;
    },
  };
}
