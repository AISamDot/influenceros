import { type Db, json } from '@troupe/db';
import { createTestDb } from '@troupe/db/testing';
import { DEFAULT_SETTINGS, type Autonomy, type PersonaState, type StudioSettings } from '../src';

export interface Ctx {
  db: Db;
  studioId: string;
}

export async function setup(settings: Partial<StudioSettings> = {}): Promise<Ctx> {
  const db = await createTestDb();
  const { id } = await db.one<{ id: string }>(
    `INSERT INTO studio (slug, name, settings) VALUES ('test', 'Test Studio', $1::jsonb) RETURNING id`,
    [json({ ...DEFAULT_SETTINGS, ...settings })],
  );
  return { db, studioId: id };
}

let n = 0;
/** Fixture shortcut: inserts a persona directly in a given state (the engine is tested separately). */
export async function makePersona(
  ctx: Ctx,
  opts: { state?: PersonaState; autonomy?: Autonomy; budget?: Record<string, number>; name?: string } = {},
): Promise<string> {
  n += 1;
  const name = opts.name ?? `Persona ${n}`;
  const { id } = await ctx.db.one<{ id: string }>(
    `INSERT INTO persona (studio_id, slug, name, niche, state, autonomy, budget)
     VALUES ($1, $2, $3, 'testing', $4, $5, $6::jsonb) RETURNING id`,
    [ctx.studioId, `p${n}-${Math.random().toString(36).slice(2, 7)}`, name, opts.state ?? 'TESTING', opts.autonomy ?? 'L1', json(opts.budget ?? {})],
  );
  return id;
}

export async function count(db: Db, sql: string, params: unknown[] = []): Promise<number> {
  const r = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql}) x`, params);
  return r.n;
}

export const HOUR = 3_600_000;
