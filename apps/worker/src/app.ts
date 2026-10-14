import type { JobHandlerMap, ScheduledTask, StudioServices } from '@ios/agents';
import { createWorker, schedulerStatus, studioTick, type Worker } from '@ios/profit';

/**
 * The `pnpm worker` commands, separated from process concerns (opening the database, signals) so they can be
 * tested on an in-memory database.
 */
export interface WorkerArgs {
  command: 'run' | 'once' | 'tick' | 'status' | 'help';
  tick: boolean;
  concurrency: number | null;
}

export const HELP = `pnpm worker [command] [--no-tick] [--concurrency N]

  run (default)   claim and run queue jobs until stopped, plus the local tick every minute
  once            run every due job, then exit
  tick            run one tick (auto-approvals, reaper, due schedules), then exit
  status          queue counts by kind and the scheduler's last runs

  With local PGlite only one process can open the data dir: \`pnpm dev\` already runs the worker inline, so the
  standalone worker needs DATABASE_URL (Supabase) or a stopped dev server.`;

export function parseArgs(argv: readonly string[], env: Readonly<Record<string, string | undefined>> = process.env): WorkerArgs {
  const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--concurrency');
  const raw = positional[0] ?? 'run';
  const command = (['run', 'once', 'tick', 'status', 'help'] as const).find((c) => c === raw) ?? 'help';
  const i = argv.indexOf('--concurrency');
  const n = i >= 0 ? Number(argv[i + 1]) : env.IOS_WORKER_CONCURRENCY ? Number(env.IOS_WORKER_CONCURRENCY) : NaN;
  return {
    command: argv.includes('--help') ? 'help' : command,
    tick: !argv.includes('--no-tick') && env.IOS_TICKER !== 'off',
    concurrency: Number.isInteger(n) && n >= 1 && n <= 16 ? n : null,
  };
}

export interface WorkerDeps {
  services: StudioServices;
  handlers: JobHandlerMap;
  schedules: readonly ScheduledTask[];
  workerId: string;
  /** Postgres can run several claim loops; PGlite runs one. */
  defaultConcurrency: number;
  log?: (line: string) => void;
}

export async function queueStatus(services: StudioServices): Promise<Array<{ kind: string; status: string; n: number }>> {
  return services.db.query(`SELECT kind, status, count(*)::int AS n FROM job GROUP BY kind, status ORDER BY kind, status`);
}

/** Runs a one-shot command; for `run`, returns the started worker (the caller stops it on a signal). */
export async function runCommand(args: WorkerArgs, deps: WorkerDeps): Promise<{ code: number; worker?: Worker }> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const worker = createWorker({
    services: deps.services,
    handlers: deps.handlers,
    workerId: deps.workerId,
    concurrency: args.concurrency ?? deps.defaultConcurrency,
    tickMs: args.tick ? 60_000 : 0,
    schedules: deps.schedules,
    log,
  });
  switch (args.command) {
    case 'help':
      log(HELP);
      return { code: 0 };
    case 'once': {
      const done = await worker.drain();
      log(`[worker] ran ${done.length} job${done.length === 1 ? '' : 's'}`);
      return { code: done.some((d) => d.outcome === 'dead') ? 2 : 0 };
    }
    case 'tick': {
      const r = await studioTick(deps.services, deps.schedules);
      log(`[tick] approved ${r.approved.length}, reaped ${r.reaped}, ran ${r.schedules.ran.join(', ') || 'no schedules'}`);
      for (const e of r.errors) log(`[tick] error: ${e}`);
      return { code: r.errors.length ? 1 : 0 };
    }
    case 'status': {
      const q = await queueStatus(deps.services);
      log(q.length ? q.map((r) => `${r.kind.padEnd(28)} ${r.status.padEnd(10)} ${r.n}`).join('\n') : 'Queue is empty.');
      for (const s of await schedulerStatus(deps.services.db)) {
        log(`schedule ${s.name.padEnd(24)} last ${s.last_run_at ? new Date(s.last_run_at).toISOString() : 'never'} ${s.last_status ?? ''}${s.last_error ? ` (${s.last_error})` : ''}`);
      }
      return { code: 0 };
    }
    case 'run': {
      const kinds = Object.keys(deps.handlers);
      log(`[worker] ${deps.workerId} running ${kinds.length} job kinds${args.tick ? ' + local tick every 60 s' : ''}`);
      worker.start();
      return { code: 0, worker };
    }
  }
}
