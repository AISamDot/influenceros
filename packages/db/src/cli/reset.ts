import { rmSync } from 'node:fs';
import { defaultPgliteDir } from '../client';
import { assertPgliteFree, exitOnOpenError, lockPathFor } from '../lock';

if (process.env.DATABASE_URL) {
  console.error('[db:reset] refusing to reset a DATABASE_URL database; it only wipes the local PGlite dir.');
  process.exit(1);
}
const dir = defaultPgliteDir();
try {
  // Never wipe the dir under a running server (it would keep writing into a deleted database).
  assertPgliteFree(dir);
} catch (err) {
  exitOnOpenError('db:reset', err);
}
rmSync(dir, { recursive: true, force: true });
rmSync(lockPathFor(dir), { force: true });
console.log(`[db:reset] removed ${dir}`);
