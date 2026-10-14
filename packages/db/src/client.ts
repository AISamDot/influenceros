import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PGlite, types } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import pg from 'pg';

export type Row = Record<string, unknown>;

/**
 * The thin query layer shared by PGlite (local dev, tests) and Postgres (Supabase).
 * Always pass jsonb values as JSON strings (`json(value)`) so both drivers behave the same.
 */
export interface Db {
  readonly dialect: 'pglite' | 'postgres';
  query<T = Row>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** Exactly one row, or throws. */
  one<T = Row>(sql: string, params?: readonly unknown[]): Promise<T>;
  /** First row or null. */
  maybeOne<T = Row>(sql: string, params?: readonly unknown[]): Promise<T | null>;
  /** Multi-statement SQL without parameters (migrations). */
  exec(sql: string): Promise<void>;
  /** Runs `fn` in a transaction. Inside a transaction this is a pass-through (no savepoints). */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export const json = (value: unknown): string => JSON.stringify(value ?? null);

// numeric and int8 come back as JS numbers on both drivers (amounts here stay well inside 2^53).
const parseNumber = (v: string) => (v === null ? null : Number(v));
const PGLITE_PARSERS = { [types.NUMERIC]: parseNumber, [types.INT8]: parseNumber };
/** pgvector for the Field Brain (knowledge_node.embedding). */
export const PGLITE_EXTENSIONS = { vector };
pg.types.setTypeParser(1700, parseNumber);
pg.types.setTypeParser(20, parseNumber);

interface Queryable {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
interface PgliteLike extends Queryable {
  exec(sql: string): Promise<unknown>;
}

/**
 * Multi-statement SQL. PGlite has `exec`; node-postgres has no `exec`, but a `query` without parameters uses the
 * simple query protocol, which runs several statements in one call.
 */
function execFor(q: Queryable): (sql: string) => Promise<void> {
  const maybeExec = (q as Partial<PgliteLike>).exec;
  if (typeof maybeExec === 'function') return async (sql) => void (await maybeExec.call(q, sql));
  return async (sql) => void (await q.query(sql));
}

function wrapQueryable(
  dialect: Db['dialect'],
  q: Queryable,
  transaction: Db['transaction'],
  close: () => Promise<void>,
): Db {
  const exec = execFor(q);
  const db: Db = {
    dialect,
    async query<T>(sql: string, params: readonly unknown[] = []) {
      const res = await q.query<T>(sql, params as unknown[]);
      return res.rows;
    },
    async one<T>(sql: string, params: readonly unknown[] = []) {
      const rows = await db.query<T>(sql, params);
      if (rows.length !== 1) throw new Error(`Expected exactly one row, got ${rows.length}`);
      return rows[0] as T;
    },
    async maybeOne<T>(sql: string, params: readonly unknown[] = []) {
      const rows = await db.query<T>(sql, params);
      return (rows[0] as T | undefined) ?? null;
    },
    async exec(sql: string) {
      await exec(sql);
    },
    transaction,
    close,
  };
  return db;
}

export function wrapPglite(pgl: PGlite): Db {
  const self: Db = wrapQueryable(
    'pglite',
    pgl as unknown as PgliteLike,
    (fn) =>
      pgl.transaction(async (tx) => {
        const txDb: Db = wrapQueryable(
          'pglite',
          tx as unknown as PgliteLike,
          (inner) => inner(txDb),
          async () => {},
        );
        return fn(txDb);
      }),
    () => pgl.close(),
  );
  return self;
}

export async function createPglite(dataDir?: string, loadDataDir?: Blob | File): Promise<Db> {
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  const pgl = await PGlite.create({
    ...(dataDir ? { dataDir } : {}),
    ...(loadDataDir ? { loadDataDir } : {}),
    parsers: PGLITE_PARSERS,
    extensions: PGLITE_EXTENSIONS,
  });
  return wrapPglite(pgl);
}

export function createPostgres(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: Number(process.env.DATABASE_POOL_MAX ?? 5) });
  return wrapQueryable(
    'postgres',
    pool as unknown as Queryable,
    async (fn) => {
      const client = await pool.connect();
      const txDb: Db = wrapQueryable(
        'postgres',
        client as unknown as Queryable,
        (inner) => inner(txDb),
        async () => {},
      );
      try {
        await client.query('BEGIN');
        const out = await fn(txDb);
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    () => pool.end(),
  );
}

/** Walks up from `start` to the monorepo root (the folder holding pnpm-workspace.yaml). */
export function findRepoRoot(start = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

export function defaultPgliteDir(): string {
  return process.env.PGLITE_DIR ?? join(findRepoRoot(), '.data', 'pglite');
}

/**
 * `DATABASE_URL` set → Postgres (Supabase). Otherwise → PGlite stored under `.data/pglite` (git-ignored).
 * One PGlite process per data dir: stop `pnpm dev` before running seed/reset scripts.
 */
export async function openDb(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (url) return createPostgres(url);
  return createPglite(defaultPgliteDir());
}

const GLOBAL_KEY = Symbol.for('influencer-os.db');
type GlobalWithDb = typeof globalThis & { [GLOBAL_KEY]?: Promise<Db> };

/** Process-wide singleton (survives Next.js hot reloads). */
export function getDb(): Promise<Db> {
  const g = globalThis as GlobalWithDb;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = openDb().catch((err) => {
      delete g[GLOBAL_KEY];
      throw err;
    });
  }
  return g[GLOBAL_KEY];
}
