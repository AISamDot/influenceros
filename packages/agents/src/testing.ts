import { DEFAULT_SETTINGS, type Autonomy, type PersonaState, type StudioSettings } from '@troupe/core';
import { type Db, json } from '@troupe/db';
import { createTestDb } from '@troupe/db/testing';
import { createFakeProviders, type FakeProviders } from '@troupe/providers';
import type { CreateServicesOptions, StudioServices } from './contracts';
import { createServices } from './runtime';

/**
 * Shared test fixtures for every IOS-2 package (import from '@troupe/agents/testing'). Fresh in-memory PGlite, one
 * studio, fake providers, fake runtime. Tests never depend on the seed's personas (only stream C tests the seed).
 */
export interface TestStudio {
  db: Db;
  studioId: string;
  services: StudioServices;
  providers: FakeProviders;
}

export async function createTestStudio(
  opts: { settings?: Partial<StudioSettings> } & Omit<Partial<CreateServicesOptions>, 'db' | 'providers' | 'mode'> & { providers?: FakeProviders } = {},
): Promise<TestStudio> {
  const db = await createTestDb();
  const { id } = await db.one<{ id: string }>(
    `INSERT INTO studio (slug, name, settings) VALUES ('test', 'Test Studio', $1::jsonb) RETURNING id`,
    [json({ ...DEFAULT_SETTINGS, ...(opts.settings ?? {}) })],
  );
  const providers = opts.providers ?? createFakeProviders();
  const services = createServices({ ...opts, db, providers, mode: 'fake' });
  return { db, studioId: id, services, providers };
}

let seq = 0;
/** Inserts a persona directly in a given state (lifecycle rules are tested in core). */
export async function makeTestPersona(
  t: Pick<TestStudio, 'db' | 'studioId'>,
  opts: { name?: string; niche?: string; state?: PersonaState; autonomy?: Autonomy; budget?: Record<string, number>; timezone?: string } = {},
): Promise<{ id: string; slug: string; name: string; niche: string }> {
  seq += 1;
  const name = opts.name ?? `Persona ${seq}`;
  const slug = `p${seq}-${Math.random().toString(36).slice(2, 7)}`;
  const niche = opts.niche ?? 'personal finance';
  const { id } = await t.db.one<{ id: string }>(
    `INSERT INTO persona (studio_id, slug, name, niche, state, autonomy, budget, timezone)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) RETURNING id`,
    [t.studioId, slug, name, niche, opts.state ?? 'TESTING', opts.autonomy ?? 'L1', json(opts.budget ?? {}), opts.timezone ?? 'UTC'],
  );
  return { id, slug, name, niche };
}
