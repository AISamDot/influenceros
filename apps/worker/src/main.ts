/**
 * `pnpm worker`: runs queue jobs on the Mac (claims with SKIP LOCKED, heartbeats long jobs) plus the local tick.
 * Handlers come from @ios/wiring (allJobs). With local PGlite only one process can open the data dir, so the
 * standalone worker needs DATABASE_URL (or a stopped dev server). IOS-2 stream D implements this.
 */
console.error('[worker] not implemented yet (IOS-2 stream D)');
process.exitCode = 1;

export {};
