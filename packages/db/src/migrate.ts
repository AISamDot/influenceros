import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './client';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

export interface Migration {
  readonly version: string;
  readonly sql: string;
}

export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ version: f.replace(/\.sql$/, ''), sql: readFileSync(join(dir, f), 'utf8') }));
}

/** Applies pending migrations in order, each in its own transaction. Returns the versions applied. */
export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  );`);
  const done = new Set(
    (await db.query<{ version: string }>('SELECT version FROM schema_migrations')).map((r) => r.version),
  );
  const applied: string[] = [];
  for (const m of loadMigrations(dir)) {
    if (done.has(m.version)) continue;
    await db.transaction(async (tx) => {
      await tx.exec(m.sql);
      await tx.query('INSERT INTO schema_migrations (version) VALUES ($1)', [m.version]);
    });
    applied.push(m.version);
  }
  return applied;
}
