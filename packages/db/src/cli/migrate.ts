import { migrate } from '../migrate';
import { openDb } from '../client';
import { exitOnOpenError } from '../lock';

// Refuses (DbLockedError) while another process, e.g. the dev server, has the local PGlite dir open.
const db = await openDb().catch((err) => exitOnOpenError('db:migrate', err));
try {
  const applied = await migrate(db);
  console.log(
    `[db:migrate] ${db.dialect}: ${applied.length ? `applied ${applied.join(', ')}` : 'already up to date'}`,
  );
} finally {
  await db.close();
}
