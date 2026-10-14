import { PGlite } from '@electric-sql/pglite';
import { createPglite, PGLITE_EXTENSIONS, wrapPglite, type Db } from './client';
import { migrate } from './migrate';

let template: Promise<Blob> | null = null;

async function buildTemplate(): Promise<Blob> {
  const pgl = await PGlite.create({ extensions: PGLITE_EXTENSIONS });
  const db = wrapPglite(pgl);
  await migrate(db);
  const dump = await pgl.dumpDataDir('none');
  await pgl.close();
  return dump;
}

/** A fresh, fully migrated in-memory database. Migrations run once per test process, then each call clones. */
export async function createTestDb(): Promise<Db> {
  template ??= buildTemplate();
  return createPglite(undefined, await template);
}
