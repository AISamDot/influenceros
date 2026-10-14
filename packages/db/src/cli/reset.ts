import { rmSync } from 'node:fs';
import { defaultPgliteDir } from '../client';

if (process.env.DATABASE_URL) {
  console.error('[db:reset] refusing to reset a DATABASE_URL database; it only wipes the local PGlite dir.');
  process.exit(1);
}
const dir = defaultPgliteDir();
rmSync(dir, { recursive: true, force: true });
console.log(`[db:reset] removed ${dir}`);
