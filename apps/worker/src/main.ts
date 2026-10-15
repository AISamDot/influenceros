/**
 * `pnpm worker`: runs queue jobs on the Mac (claims with SKIP LOCKED, heartbeats long jobs) plus the local tick.
 * Handlers come from @ios/wiring (allJobs), so every stream's jobs run here; kinds without a handler stay queued.
 * With local PGlite only one process can open the data dir: while the dev server has it open (it already works the
 * queue inline) the worker is refused by the PGlite lock with a clear message; set DATABASE_URL to run a separate
 * worker against Postgres.
 */
import { hostname } from 'node:os';
import { exitOnOpenError, openDb } from '@ios/db';
import { migrate } from '@ios/db/migrate';
import { allJobs, allSchedules, createStudioServices } from '@ios/wiring';
import { HELP, parseArgs, runCommand } from './app';

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'help') {
    console.log(HELP);
    return 0;
  }
  const postgres = !!process.env.DATABASE_URL;
  const db = await openDb({ role: 'worker', origin: null }).catch((err) =>
    exitOnOpenError('worker', err, (holder) => (holder.role === 'server' ? 'The dev server already works the queue inline, so no separate worker is needed.' : undefined)),
  );
  if (!postgres) await migrate(db);
  const services = createStudioServices(db);
  const { code, worker } = await runCommand(args, {
    services,
    handlers: allJobs(),
    schedules: allSchedules(),
    workerId: `mac-${hostname().split('.')[0]}-${process.pid}`,
    defaultConcurrency: postgres ? 2 : 1,
  });
  if (!worker) {
    await db.close();
    return code;
  }
  await new Promise<void>((resolve) => {
    const stop = (signal: string) => {
      console.log(`[worker] ${signal}: finishing the current job…`);
      void worker.stop().then(resolve);
    };
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
  });
  await db.close();
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(`[worker] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exitCode = 1;
  },
);
