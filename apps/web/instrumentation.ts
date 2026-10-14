/**
 * Local scheduler: outside Vercel (`pnpm dev` / `pnpm start` on the Mac) nothing calls /api/cron/tick, so this
 * runs the same tick every minute in the server process (it shares the PGlite handle). On Vercel, vercel.json
 * schedules the cron instead. Set IOS_TICKER=off to disable.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.VERCEL || process.env.IOS_TICKER === 'off' || process.env.NEXT_PHASE === 'phase-production-build') return;
  const g = globalThis as typeof globalThis & { __iosTicker?: ReturnType<typeof setInterval> };
  if (g.__iosTicker) return;
  const [{ tick }, { getDb }] = await Promise.all([import('@ios/core'), import('@ios/db')]);
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const r = await tick(await getDb());
      if (r.errors.length) console.error('[tick]', r.errors.join('; '));
    } catch (err) {
      console.error('[tick]', err);
    } finally {
      running = false;
    }
  };
  g.__iosTicker = setInterval(run, 60_000);
  g.__iosTicker.unref?.();
}
