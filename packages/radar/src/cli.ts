// `pnpm radar <command>`: stream I's Growth Radar from the terminal (docs/IOS-5-CONTRACTS.md).
//
//   demo [--niche <niche>]          a full weekly run on a fresh in-memory database with the demo datasets (no keys,
//                                   no Apify spend, safe while the dev server runs) and print the Trend Report
//   status                          tracked / accelerating accounts, outliers, trends, Apify spend vs the weekly cap
//   report                          this week's Trend Report text (not posted)
//   scan [--now]                    queue this week's Radar run (the worker runs it); --now runs it here
//   shortlist <persona-slug>        the Winner Finder shortlist for a persona
//   seed <niche> [--hashtag <h>] [--keyword <k>] [--account <@h | tiktok:@h>]
//                                   add seeds for a niche (Owner action from the terminal)
//
// Database commands open the local PGlite only when no other process holds it (the PGlite lock): while `pnpm dev`
// runs, use a scratch PGLITE_DIR (docs/IOS-5-CONTRACTS.md §2), or the Radar page and the Studio chat instead.
import { createServices, type ProviderEnv, type StudioServices } from '@ios/agents';
import { createTestStudio, makeTestPersona } from '@ios/agents/testing';
import { type JobRow, runOnce } from '@ios/core';
import { type Db, exitOnOpenError, openDb } from '@ios/db';
import { migrate } from '@ios/db/migrate';
import { createFakeProviders, type Providers } from '@ios/providers';
import { defaultBackend, integrationStates, isSecretName, readSecret } from '@ios/secrets';
import { addSeeds, loadConfig } from './config';
import { liveProviders } from './index';
import { enqueueWeekly, radarJobs } from './jobs';
import { radarSummary, reportText } from './report';
import { createRadarService } from './service';
import { shortlistFor } from './winners';

const args = process.argv.slice(2);
const [cmd] = args;
const VALUE_FLAGS = ['--niche', '--hashtag', '--keyword', '--account'];
const flag = (name: string) => args.includes(`--${name}`);
const opts = (name: string) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]!] : []));
const positional = args.slice(1).filter((a, i, all) => !a.startsWith('--') && !VALUE_FLAGS.includes(all[i - 1] ?? ''));

function providerEnv(): ProviderEnv {
  const backend = defaultBackend();
  const live = new Set(integrationStates(backend).filter((s) => s.mode === 'live').map((s) => s.def.id));
  return { isLive: (id) => live.has(id), secret: (name) => (isSecretName(name) ? (readSecret(name, backend)?.reveal() ?? null) : null) };
}

function cliServices(db: Db): StudioServices {
  const providers = { ...createFakeProviders(), ...liveProviders(providerEnv()) } as Providers;
  return createServices({ db, providers, mode: 'fake', radar: createRadarService });
}

async function withDb<T>(fn: (services: StudioServices, studioId: string) => Promise<T>): Promise<T> {
  const db = await openDb().catch((err) => exitOnOpenError('radar', err, () => 'Use the Radar page while the dev server runs, or point PGLITE_DIR at a scratch directory.'));
  try {
    await migrate(db);
    const studio = await db.maybeOne<{ id: string }>('SELECT id FROM studio ORDER BY created_at LIMIT 1');
    if (!studio) throw new Error('no studio: run `pnpm db:seed`');
    return await fn(cliServices(db), studio.id);
  } finally {
    await db.close();
  }
}

/** Runs due Radar jobs in this process until none is due. */
async function drain(services: StudioServices): Promise<number> {
  const handlers = Object.fromEntries(Object.entries(radarJobs).map(([k, h]) => [k, (job: JobRow) => h({ services, job, heartbeat: async () => true })]));
  let n = 0;
  for (let i = 0; i < 500; i += 1) {
    const r = await runOnce(services.db, handlers, { workerId: 'radar-cli', now: new Date(Date.now() + 60 * 60_000) });
    if (!r) break;
    n += 1;
    console.log(`  ${r.job.kind.padEnd(14)} ${r.outcome}${r.job.payload.niche ? ` · ${String(r.job.payload.niche)}` : ''}`);
    if (r.outcome === 'deferred' && r.job.kind === 'radar.scan') break;
  }
  return n;
}

function printStatus(s: Awaited<ReturnType<typeof radarSummary>>): void {
  console.log(`Week of ${s.week}: ${s.tracked} tracked, ${s.accelerating} accelerating, ${s.strongOutliers} strong outliers, ${s.trends.length} trends.`);
  console.log(`Apify: $${s.apify.spentUsd.toFixed(2)} of $${s.apify.capUsd.toFixed(2)} this week. Remix: ${s.remix.booked} booked, ${s.remix.doubleDowns} double-downs, ${s.remix.blocked} blocked.`);
}

async function main(): Promise<number> {
  switch (cmd) {
    case 'demo': {
      const niche = opts('niche')[0] ?? 'personal finance';
      const t = await createTestStudio({ radar: createRadarService });
      await makeTestPersona(t, { name: 'Demo Persona', niche, state: 'TESTING' });
      await enqueueWeekly(t.services, t.studioId);
      console.log(`Demo Radar run for "${niche}" (demo datasets, in-memory database):`);
      await drain(t.services);
      console.log('');
      console.log(reportText(await radarSummary(t.db, t.studioId, new Date())));
      await t.db.close();
      return 0;
    }
    case 'status':
      return withDb(async (s, studioId) => {
        printStatus(await radarSummary(s.db, studioId, s.now()));
        return 0;
      });
    case 'report':
      return withDb(async (s, studioId) => {
        console.log(reportText(await radarSummary(s.db, studioId, s.now())));
        return 0;
      });
    case 'scan':
      return withDb(async (s, studioId) => {
        const id = await enqueueWeekly(s, studioId);
        console.log(id ? `Queued this week's Radar run (${id}).` : "This week's Radar run is already queued or done.");
        if (flag('now')) {
          await drain(s);
          printStatus(await radarSummary(s.db, studioId, s.now()));
        }
        return 0;
      });
    case 'shortlist':
      return withDb(async (s) => {
        const slug = positional[0];
        if (!slug) throw new Error('usage: pnpm radar shortlist <persona-slug>');
        const p = await s.db.maybeOne<{ id: string; studio_id: string }>('SELECT id, studio_id FROM persona WHERE slug = $1', [slug]);
        if (!p) throw new Error(`no persona ${slug}`);
        const cfg = await loadConfig(s.db, p.studio_id);
        for (const w of await shortlistFor(s.db, p.id, s.now(), { limit: cfg.limits.shortlistSize })) {
          console.log(`${w.score.toFixed(3)}  ${w.outlier.toFixed(1)}×  ${w.platform.padEnd(9)} @${w.handle}  ${w.format ?? '?'} · ${w.hook_label ?? '?'}  ${w.url ?? ''}`);
        }
        return 0;
      });
    case 'seed':
      return withDb(async (s, studioId) => {
        const niche = positional[0];
        if (!niche) throw new Error('usage: pnpm radar seed <niche> [--hashtag h] [--keyword k] [--account @h]');
        console.log(JSON.stringify(await addSeeds(s.db, studioId, niche, { hashtags: opts('hashtag'), keywords: opts('keyword'), accounts: opts('account') }), null, 2));
        return 0;
      });
    default:
      console.log('Usage: pnpm radar demo [--niche <niche>] | status | report | scan [--now] | shortlist <persona-slug> | seed <niche> [--hashtag h] [--keyword k] [--account @h]');
      return cmd ? 1 : 0;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error((err as Error).message);
    process.exit(1);
  });
