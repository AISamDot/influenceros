import { exitOnOpenError, openDb } from '@ios/db';
import { migrate } from '@ios/db/migrate';
import { isSeeded, seed } from './index';

// `pnpm db:seed [--if-empty] [--samples]`. With local PGlite it refuses while another process (e.g. `pnpm dev`) has the data dir open.
// Seeds the launch personas from packages/knowledge/seed/personas when present; --samples forces the IOS-1 demo studio.
const ifEmpty = process.argv.includes('--if-empty');
const samples = process.argv.includes('--samples');
const db = await openDb().catch((err) => exitOnOpenError('db:seed', err));
try {
  await migrate(db);
  if (await isSeeded(db)) {
    if (ifEmpty) {
      console.log('[db:seed] already seeded, skipping');
    } else {
      console.error('[db:seed] the database already has a studio. Run `pnpm db:reset` for a fresh local seed.');
      process.exitCode = 1;
    }
  } else {
    const t0 = Date.now();
    const s = await seed(db, { samples });
    console.log(`[db:seed] seeded ${s.kind} personas ${s.personas.map((p) => `${p.slug} (${p.state})`).join(', ')} in ${Date.now() - t0} ms`);
  }
} finally {
  await db.close();
}
