import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { findRepoRoot } from '@ios/db';
import { type LaunchPersona, loadLaunchPersonas, readManifest } from './launch';

/**
 * The persona archive on disk (Owner decision, 16 Oct): `packages/knowledge/seed/archive/<YYYY-MM-DD>/<slug>/` holds
 * archived personas' documents exactly as they were (bible, look prompts, content plan, Field Brain seed, product
 * manuscripts, `manifest.json`). The 14 Oct launch five live in `2026-10-16`. Restoring one goes through the Persona
 * Generator's review step (@ios/generator `restoreFromArchive`); nothing here writes to the database.
 */

const LABEL_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `packages/knowledge/seed/archive` (or IOS_ARCHIVE_DIR). */
export function archiveRootDir(): string {
  if (process.env.IOS_ARCHIVE_DIR) return resolve(process.env.IOS_ARCHIVE_DIR);
  return join(/*turbopackIgnore: true*/ findRepoRoot(), 'packages', 'knowledge', 'seed', 'archive');
}

/** Archive labels (dates), newest first. */
export function archiveLabels(root = archiveRootDir()): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((n) => LABEL_RE.test(n) && statSync(join(/*turbopackIgnore: true*/ root, n)).isDirectory())
    .sort()
    .reverse();
}

/**
 * The folder for `from`: an archive label (`2026-10-16`), an absolute path to a folder of persona folders (e.g. the
 * Owner's copy in the Ventures folder), or the newest label when omitted.
 */
export function archiveDir(from?: string, root = archiveRootDir()): string {
  if (from && (isAbsolute(from) || from.startsWith('.'))) {
    const dir = resolve(from);
    if (!existsSync(dir)) throw new Error(`no archive folder at ${dir}`);
    return dir;
  }
  const label = from ?? archiveLabels(root)[0];
  if (!label) throw new Error(`no persona archive in ${root}`);
  if (!LABEL_RE.test(label)) throw new Error(`archive label must look like YYYY-MM-DD: ${label}`);
  const dir = join(/*turbopackIgnore: true*/ root, label);
  if (!existsSync(dir)) throw new Error(`no archive ${label} (have: ${archiveLabels(root).join(', ') || 'none'})`);
  return dir;
}

export interface ArchivedPersonaInfo {
  label: string;
  slug: string;
  name: string;
  niche: string;
  subNiche: string | null;
  bibleLabel: string | null;
  products: number;
  /** Product manuscripts kept with the persona (products/*.md). */
  productDocs: string[];
  dir: string;
}

const cache = new Map<string, { at: number; personas: LaunchPersona[] }>();

/** Parsed archived personas of one archive (cached briefly: the documents don't change while the server runs). */
export function loadArchivedPersonas(from?: string, slugs?: readonly string[]): LaunchPersona[] {
  const dir = archiveDir(from);
  const hit = cache.get(dir);
  const personas = hit && Date.now() - hit.at < 60_000 ? hit.personas : loadLaunchPersonas(dir);
  if (!hit || hit.personas !== personas) cache.set(dir, { at: Date.now(), personas });
  return slugs ? personas.filter((p) => slugs.includes(p.slug)) : personas;
}

/** Every archived persona across every archive label (newest label first). */
export function listArchivedPersonas(root = archiveRootDir()): ArchivedPersonaInfo[] {
  const out: ArchivedPersonaInfo[] = [];
  for (const label of archiveLabels(root)) {
    const dir = join(/*turbopackIgnore: true*/ root, label);
    const manifest = readManifest(dir);
    for (const p of loadArchivedPersonas(dir)) {
      const pdir = join(/*turbopackIgnore: true*/ dir, p.slug, 'products');
      out.push({
        label,
        slug: p.slug,
        name: manifest[p.slug]?.name ?? p.name,
        niche: p.niche,
        subNiche: p.subNiche,
        bibleLabel: p.bibleLabel,
        products: p.products.length,
        productDocs: existsSync(pdir) ? readdirSync(pdir).filter((f) => f.endsWith('.md')).sort() : [],
        dir: join(/*turbopackIgnore: true*/ dir, p.slug),
      });
    }
  }
  return out;
}

/** The archive's own note (archive.json), when present. */
export function archiveNote(label: string, root = archiveRootDir()): Record<string, unknown> | null {
  const file = join(/*turbopackIgnore: true*/ root, label, 'archive.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : null;
}
