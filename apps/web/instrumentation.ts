/**
 * Local scheduler and worker. Outside Vercel (`pnpm dev` / `pnpm start` on the Mac) nothing calls /api/cron/tick, so
 * this process runs the same full tick every minute (core tick + every package's due schedules), sharing the PGlite
 * handle. With local PGlite only one process can open the data dir, so the queue worker runs here too
 * (TROUPE_WORKER=inline, the default without DATABASE_URL); with DATABASE_URL run `pnpm worker` instead (or set
 * TROUPE_WORKER=inline). On Vercel, vercel.json schedules the cron and the Mac worker works the queue.
 * TROUPE_TICKER=off disables the ticker; TROUPE_WORKER=off disables the inline worker.
 */
import { troupeEnv } from '@troupe/env';

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.VERCEL || process.env.NEXT_PHASE === 'phase-production-build') return;
  const ticker = troupeEnv('TICKER') !== 'off';
  const inlineWorker = (troupeEnv('WORKER') ?? (process.env.DATABASE_URL ? 'off' : 'inline')) === 'inline';
  if (!ticker && !inlineWorker) return;
  const g = globalThis as typeof globalThis & { __troupeTicker?: ReturnType<typeof setInterval>; __troupeWorker?: { stop(): Promise<void> } };
  if (g.__troupeTicker || g.__troupeWorker) return;

  const [{ getDb }, wiring, profit] = await Promise.all([import('@troupe/db'), import('@troupe/wiring'), import('@troupe/profit')]);
  // Services are rebuilt per tick so a key added in Settings (or the Keychain) is picked up without a restart.
  const services = async () => wiring.createStudioServices(await getDb());

  if (ticker) {
    let running = false;
    const run = async () => {
      if (running) return;
      running = true;
      try {
        const r = await profit.studioTick(await services(), wiring.allSchedules());
        if (r.schedules.ran.length) console.log(`[tick] ran ${r.schedules.ran.join(', ')}`);
        if (r.errors.length) console.error('[tick]', r.errors.join('; '));
      } catch (err) {
        console.error('[tick]', err);
      } finally {
        running = false;
      }
    };
    g.__troupeTicker = setInterval(run, 60_000);
    g.__troupeTicker.unref?.();
    setTimeout(run, 15_000).unref?.();
  }

  if (inlineWorker) {
    try {
      const worker = profit.createWorker({
        services: await services(),
        handlers: wiring.allJobs(),
        workerId: `inline-${Math.random().toString(36).slice(2, 8)}`,
        concurrency: 1,
        idleMs: 3_000,
        log: (line) => console.log(line),
      });
      worker.start();
      g.__troupeWorker = worker;
      console.log(`[worker] inline worker running ${Object.keys(wiring.allJobs()).length} job kinds (TROUPE_WORKER=off to disable)`);
    } catch (err) {
      console.error('[worker] inline worker did not start:', err);
    }
  }
}
