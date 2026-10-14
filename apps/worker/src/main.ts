/**
 * `pnpm worker`: runs queue jobs on the Mac (claims with SKIP LOCKED, heartbeats long jobs) plus the local tick.
 * Handlers come from @ios/wiring (allJobs), so every stream's jobs run here; kinds without a handler (media.render
 * until IOS-3) stay queued. With local PGlite only one process can open the data dir, so the standalone worker
 * needs DATABASE_URL (or a stopped dev server: `pnpm dev` already runs the worker inline).
 */
import { hostname } from 'node:os';
import { openDb } from '@ios/db';
import { migrate } from '@ios/db/migrate';
import { allJobs, allSchedules, createStudioServices } from '@ios/wiring';
import { HELP, parseArgs, runCommand } from './app';

async function devServerRunning(): Promise<boolean> {
  try {
    // Any answer means a server holds the data dir (even a 401 or a 503).
    await fetch('http://127.0.0.1:3100/api/health', { signal: AbortSignal.timeout(800) });
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'help') {
    console.log(HELP);
    return 0;
  }
  const postgres = !!process.env.DATABASE_URL;
  if (!postgres && (await devServerRunning())) {
    console.error(
      '[worker] The dev server is running and already works the queue inline (one process per PGlite data dir).\n' +
        '         Stop `pnpm dev` first, or set DATABASE_URL to run a separate worker against Postgres.',
    );
    return 1;
  }
  const db = await openDb();
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
