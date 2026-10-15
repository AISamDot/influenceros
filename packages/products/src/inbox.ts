import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { enqueueOnceFor, PRODUCT_BUILD_JOB, type StudioServices } from '@ios/agents';
import { audit, notify } from '@ios/core';
import { loadPersonaContext, priceFor, productKeyword, type ProductBrief, type Rung } from '@ios/content';
import { findRepoRoot, json } from '@ios/db';
import { PRODUCT_BUILDER } from './build';
import { parseManuscript } from './manuscript';
import { slugify } from './model';

/**
 * Content import (stream H scope 2): ready-written manuscripts dropped into the inbox folder become finished PDFs
 * through the same pipeline. Layout: `<IOS_MANUSCRIPTS_DIR or <repo>/.data/manuscripts>/<persona-slug>/<file>.md`
 * (or any `.md` with `persona:` in its front matter). Each file is imported once per content hash; an edited file
 * with the same product slug becomes a new version (or replaces an unapproved v1).
 */

const RUNGS: readonly Rung[] = ['lead_magnet', 'entry', 'addon', 'core_bundle', 'upsell', 'product_2_3', 'marketplace', 'membership', 'course'];

export function manuscriptsDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env.IOS_MANUSCRIPTS_DIR?.trim() || join(findRepoRoot(), '.data', 'manuscripts');
}

export interface ImportResult {
  readonly status: 'imported' | 'duplicate';
  readonly productId: string;
  readonly personaId: string;
  readonly version: number;
  readonly manuscriptId: string;
  readonly jobId: string | null;
}

export async function importManuscript(
  services: StudioServices,
  args: { text: string; filename: string; personaId?: string; personaSlug?: string },
): Promise<ImportResult> {
  const { db } = services;
  const parsed = parseManuscript(args.text, { filename: args.filename });
  const slugRef = args.personaSlug ?? parsed.meta.persona;
  const persona = args.personaId
    ? await db.maybeOne<{ id: string; studio_id: string; name: string; state: string }>('SELECT id, studio_id, name, state FROM persona WHERE id = $1', [args.personaId])
    : slugRef
      ? await db.maybeOne<{ id: string; studio_id: string; name: string; state: string }>('SELECT id, studio_id, name, state FROM persona WHERE slug = $1', [slugRef])
      : null;
  if (!persona) throw new Error(slugRef ? `no persona "${slugRef}"` : 'which persona? Put the file in <inbox>/<persona-slug>/ or add "persona: <slug>" to its front matter');
  if (persona.state === 'KILLED' || persona.state === 'RETIRED') throw new Error(`${persona.name} is ${persona.state}`);

  const hash = createHash('sha256').update(args.text).digest('hex');
  const dup = await db.maybeOne<{ id: string; product_id: string | null; version: number | null }>(`SELECT id, product_id, version FROM product_manuscript WHERE persona_id = $1 AND sha256 = $2`, [persona.id, hash]);
  if (dup?.product_id) return { status: 'duplicate', productId: dup.product_id, personaId: persona.id, version: dup.version ?? 1, manuscriptId: dup.id, jobId: null };

  const key = `products/${persona.id}/manuscripts/${hash.slice(0, 24)}.md`;
  await services.providers.storage.put({ key, data: args.text, contentType: 'text/markdown' });

  const slug = parsed.meta.slug ?? slugify(parsed.doc.title);
  const rung: Rung = RUNGS.includes(parsed.meta.rung as Rung) ? (parsed.meta.rung as Rung) : 'entry';
  let product = await db.maybeOne<{ id: string; status: string; price_cents: number; cta_keyword: string | null }>(`SELECT id, status, price_cents, cta_keyword FROM product WHERE persona_id = $1 AND slug = $2`, [persona.id, slug]);
  let version = 1;
  if (product) {
    if (product.status === 'approved' || product.status === 'live') {
      const max = await db.one<{ v: number }>(`SELECT COALESCE(max(version), 0)::int AS v FROM product_version WHERE product_id = $1`, [product.id]);
      version = max.v + 1;
    }
  } else {
    const ctx = await loadPersonaContext(db, persona.id);
    const price = parsed.meta.priceCents ?? priceFor(rung, ctx.priceBand);
    product = await db.one(
      `INSERT INTO product (persona_id, name, slug, ladder_rung, status, price_cents, cta_keyword) VALUES ($1, $2, $3, $4, 'brief', $5, $6) RETURNING id, status, price_cents, cta_keyword`,
      [persona.id, parsed.doc.title.slice(0, 80), slug, rung, price, await productKeyword(db, persona.id, parsed.doc.title)],
    );
  }
  const p = product!;
  // A brief synthesised from the manuscript, so the listing pack and dashboards read it like any other product.
  const brief: ProductBrief = {
    name: parsed.doc.title.slice(0, 80),
    promise: parsed.doc.subtitle,
    audience: parsed.meta.raw.audience ?? '',
    outline: [...parsed.doc.promised],
    format: `PDF workbook (A4 and US Letter)${parsed.meta.templates?.includes('sheet') ? ' + Google Sheets template' : ''}${parsed.meta.templates?.includes('notion') ? ' + Notion template' : ''}`,
    page_count: 0,
    bonuses: parsed.doc.sections.filter((s) => s.kind === 'bonus').map((s) => s.title.replace(/^bonus:\s*/i, '')),
    price_cents: p.price_cents,
    ladder_rung: rung,
    upsell_pairing: parsed.meta.raw.upsell ?? '',
    cta_keyword: p.cta_keyword ?? '',
    validation: `imported manuscript ${basename(args.filename)}`,
  };
  await db.query(`INSERT INTO product_brief (persona_id, product_id, content, source) VALUES ($1, $2, $3::jsonb, 'manuscript')`, [persona.id, p.id, json(brief)]);
  const ms = await db.one<{ id: string }>(
    `INSERT INTO product_manuscript (persona_id, product_id, sha256, filename, storage_key, meta, version) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     ON CONFLICT (persona_id, sha256) DO UPDATE SET product_id = EXCLUDED.product_id, version = EXCLUDED.version RETURNING id`,
    [persona.id, p.id, hash, basename(args.filename).slice(0, 200), key, json(parsed.meta.raw), version],
  );
  const job = await enqueueOnceFor(
    db,
    {
      kind: PRODUCT_BUILD_JOB,
      key: `product:${p.id}:v${version}:m${hash.slice(0, 12)}`,
      payload: { productId: p.id, personaId: persona.id, source: 'manuscript', manuscriptKey: key, version, force: true },
      studioId: persona.studio_id,
      personaId: persona.id,
      priority: 70,
    },
    { ever: true },
  );
  await audit(db, { studioId: persona.studio_id, personaId: persona.id, actor: PRODUCT_BUILDER, action: 'product.manuscript_imported', entityType: 'product', entityId: p.id, data: { file: basename(args.filename), version, sha: hash.slice(0, 12) } });
  return { status: 'imported', productId: p.id, personaId: persona.id, version, manuscriptId: ms.id, jobId: job?.id ?? null };
}

/** Markdown files in the inbox: `<dir>/<persona-slug>/*.md` and `<dir>/*.md` (persona from front matter). */
export function listInbox(dir: string): Array<{ path: string; personaSlug: string | null }> {
  if (!existsSync(dir)) return [];
  const out: Array<{ path: string; personaSlug: string | null }> = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.') || name === 'processed') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isFile() && /\.(md|markdown)$/i.test(name)) out.push({ path: full, personaSlug: null });
    else if (st.isDirectory()) {
      for (const f of readdirSync(full).sort()) if (/\.(md|markdown)$/i.test(f) && !f.startsWith('.')) out.push({ path: join(full, f), personaSlug: name.toLowerCase() });
    }
  }
  return out;
}

/** Imports every new manuscript in the inbox. Bad files notify the Owner once (per content hash) and are skipped. */
export async function scanInbox(services: StudioServices, dir = manuscriptsDir()): Promise<{ imported: ImportResult[]; skipped: number; errors: Array<{ file: string; error: string }> }> {
  const imported: ImportResult[] = [];
  const errors: Array<{ file: string; error: string }> = [];
  let skipped = 0;
  const studio = await services.db.maybeOne<{ id: string }>('SELECT id FROM studio ORDER BY created_at LIMIT 1');
  for (const f of listInbox(dir)) {
    const text = readFileSync(f.path, 'utf8');
    const hash = createHash('sha256').update(text).digest('hex');
    const known = await services.db.maybeOne(`SELECT 1 FROM product_manuscript WHERE sha256 = $1 AND product_id IS NOT NULL LIMIT 1`, [hash]);
    if (known) {
      skipped += 1;
      continue;
    }
    try {
      imported.push(await importManuscript(services, { text, filename: basename(f.path), ...(f.personaSlug ? { personaSlug: f.personaSlug } : {}) }));
    } catch (err) {
      const error = (err as Error).message;
      errors.push({ file: basename(f.path), error });
      const tag = `[${hash.slice(0, 8)}]`;
      const told = studio ? await services.db.maybeOne(`SELECT 1 FROM notification WHERE studio_id = $1 AND title LIKE $2 LIMIT 1`, [studio.id, `%${tag}`]) : true;
      if (studio && !told) {
        await notify(services.db, { studioId: studio.id, kind: 'system', severity: 'warn', title: `Manuscript not imported: ${basename(f.path)} ${tag}`, body: error.slice(0, 500), link: '/products' });
      }
    }
  }
  return { imported, skipped, errors };
}
