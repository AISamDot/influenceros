import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPostgres } from '../src/client';
import { loadMigrations, migrate } from '../src/migrate';

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * No Postgres server here (no Docker on this Mac): node-postgres is stubbed at the driver boundary to check that
 * the Postgres wrapper sends multi-statement SQL the way pg can run it (one parameterless query, which uses the
 * simple protocol). node-postgres has no `exec`, so calling one used to fail every migration.
 */
describe('Postgres driver wrapper', () => {
  it('runs migrations through query() without parameters', async () => {
    const sent: Array<{ sql: string; params: unknown }> = [];
    const query = async (sql: string, params?: unknown) => {
      sent.push({ sql, params });
      return { rows: [] };
    };
    const client = { query: vi.fn(query), release: vi.fn() };
    vi.spyOn(pg.Pool.prototype, 'query').mockImplementation(query as never);
    vi.spyOn(pg.Pool.prototype, 'connect').mockImplementation((async () => client) as never);

    const db = createPostgres('postgres://ios:ios@127.0.0.1:1/ios');
    const migrations = loadMigrations();
    expect(await migrate(db)).toEqual(migrations.map((m) => m.version));
    for (const m of migrations) {
      const call = sent.find((c) => c.sql === m.sql);
      expect(call, `migration ${m.version} was not sent`).toBeDefined();
      expect(call!.params).toBeUndefined();
    }
    // Each migration ran inside its own transaction on a pooled client.
    expect(sent.filter((c) => c.sql === 'BEGIN')).toHaveLength(migrations.length);
    expect(sent.filter((c) => c.sql === 'COMMIT')).toHaveLength(migrations.length);
    await db.close();
  });
});
