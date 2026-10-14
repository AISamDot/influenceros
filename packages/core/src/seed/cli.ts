import { openDb } from '@ios/db';
import { migrate } from '@ios/db/migrate';
import { isSeeded, seed } from './index';

// `pnpm db:seed [--if-empty]`. Stop `pnpm dev` first when using local PGlite (one process per data dir).
const ifEmpty = process.argv.includes('--if-empty');
const db = await openDb();
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
    const s = await seed(db);
    console.log(`[db:seed] seeded ${s.personas.map((p) => `${p.slug} (${p.state})`).join(', ')} in ${Date.now() - t0} ms`);
  }
} finally {
  await db.close();
}
