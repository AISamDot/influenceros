import { troupeEnv } from '@troupe/env';
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { StudioServices } from '@troupe/agents';
import { ensureThreads } from '@troupe/core';
import { defaultPersonasDir, type ImportResult, importLaunchPersona, LAUNCH_FILES, loadLaunchPersonas } from '@troupe/core/seed';

/**
 * Launch-persona import (stream C). The seed writes the personas into a fresh studio; this keeps an existing studio
 * in step with the Persona Architect's documents: new folders become new personas (launch card proposed by the
 * Studio Manager; it auto-approves on the timer and the Owner is notified), and edited documents become the next
 * bible version (persona creative decisions are delegated to the Studio Manager). It never deletes or retires a
 * persona: that stays an Owner decision.
 */

export const PERSONA_JOBS = { import: 'personas.import' } as const;

/** Where the importer reads from: TROUPE_PERSONAS_SOURCE (e.g. the Ventures folder on the Mac) or the repo's seed dir. */
export function personasSourceDir(): string {
  const configured = troupeEnv('PERSONAS_SOURCE');
  return configured ? resolve(configured) : defaultPersonasDir();
}

export async function importPersonas(services: StudioServices, opts: { studioId?: string; dir?: string } = {}): Promise<ImportResult[]> {
  const { db } = services;
  const studio = opts.studioId
    ? { id: opts.studioId }
    : await db.maybeOne<{ id: string }>('SELECT id FROM studio ORDER BY created_at LIMIT 1');
  if (!studio) return [];
  const personas = loadLaunchPersonas(opts.dir ?? personasSourceDir());
  const out: ImportResult[] = [];
  for (const lp of personas) out.push(await importLaunchPersona(db, studio.id, lp, { now: services.now() }));
  if (out.some((r) => r.created)) await ensureThreads(db, studio.id);
  return out;
}

/**
 * Copies the persona documents (the four Markdown files per folder) from `from` into the repo's seed folder so they
 * can be committed. Returns the slugs copied. `manifest.json` in the destination is left alone.
 */
export function syncPersonaDocs(from: string, to = defaultPersonasDir()): string[] {
  if (!existsSync(from)) throw new Error(`no persona folder at ${from}`);
  const slugs = readdirSync(from).filter((n) => /^[a-z0-9][a-z0-9-]*$/.test(n) && statSync(join(/*turbopackIgnore: true*/ from, n)).isDirectory() && existsSync(join(/*turbopackIgnore: true*/ from, n, LAUNCH_FILES.bible)));
  for (const slug of slugs) {
    mkdirSync(join(/*turbopackIgnore: true*/ to, slug), { recursive: true });
    for (const file of Object.values(LAUNCH_FILES)) {
      const src = join(/*turbopackIgnore: true*/ from, slug, file);
      if (existsSync(src)) copyFileSync(src, join(/*turbopackIgnore: true*/ to, slug, file));
    }
  }
  return slugs;
}
