import { migrate } from '../migrate';
import { openDb } from '../client';

const db = await openDb();
try {
  const applied = await migrate(db);
  console.log(
    `[db:migrate] ${db.dialect}: ${applied.length ? `applied ${applied.join(', ')}` : 'already up to date'}`,
  );
} finally {
  await db.close();
}
