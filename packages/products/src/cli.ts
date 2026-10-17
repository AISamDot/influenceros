// `pnpm products <command>`: stream H's Product Builder from the terminal (docs/IOS-34-CONTRACTS.md).
//
//   render <file.md> [--out <dir>] [--name <persona>] [--slug <persona-slug>] [--niche <niche>] [--fake]
//                                   a manuscript → A4 + Letter PDFs + the QP report, with no database (safe while the
//                                   dev server runs); front matter `palette: #hex, #hex, …` sets the colours
//   sample [--out <dir>] [--fake]   the same for a built-in sample brief
//   import <file.md> --persona <slug> [--now]
//                                   import a manuscript on the database (the worker builds it; --now builds here)
//   inbox                           import every new manuscript in the inbox folder (TROUPE_MANUSCRIPTS_DIR)
//   build <product-id>              (re)build one product here
//   status [<persona-slug>]         products, builds and QP results
//
// Database commands open the local PGlite only when no other process holds it (the PGlite lock): while `pnpm dev`
// runs, drop manuscripts into the inbox folder instead (the server imports and builds them within minutes).
import { troupeEnv } from '@troupe/env';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createServices, kitColors, liveProviders as agentsLiveProviders, type PersonaKitColor, type ProviderEnv, type StudioServices } from '@troupe/agents';
import type { ProductBrief } from '@troupe/content';
import { type Db, exitOnOpenError, findRepoRoot, openDb } from '@troupe/db';
import { migrate } from '@troupe/db/migrate';
import { createFakeProviders, LocalMediaStore, type Providers } from '@troupe/providers';
import { productBackends, setProductBackends } from './backends';
import { type BuildPayload, buildProduct, previewDoc } from './build';
import { withNextStepAndCredits } from './content';
import { coverSvg, renderHtml } from './html';
import { importManuscript, manuscriptsDir, scanInbox } from './inbox';
import { inspectPdf } from './inspect';
import { layoutDoc } from './layout';
import { parseManuscript } from './manuscript';
import { PAGE_SIZES, type ProductDoc, slugify } from './model';
import { FakePdfRenderer } from './pdf';
import { runQp } from './qp';
import { productStatus, requestBuild } from './tools';

const args = process.argv.slice(2);
const [cmd] = args;
const VALUE_FLAGS = ['--out', '--name', '--slug', '--niche', '--persona'];
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.slice(1).filter((a, i, all) => !a.startsWith('--') && !(i > 0 && VALUE_FLAGS.includes(all[i - 1]!)));

const HELP = `pnpm products <command>

  render <file.md> [--out <dir>] [--name <persona>] [--slug <persona-slug>] [--niche <niche>] [--fake]
                                  a manuscript → A4 + Letter PDFs + the QP report (no database)
  sample [--out <dir>] [--fake]   the same for a built-in sample brief
  import <file.md> --persona <slug> [--now]
                                  import a manuscript (the worker builds it; --now builds here)
  inbox                           import every new manuscript in ${manuscriptsDir()}
  build <product-id>              (re)build one product here
  status [<persona-slug>]         products, builds and QP results`;

/** Files the CLI writes go to the media dir the server uses (TROUPE_MEDIA_DIR, else <repo>/.data/media). */
const mediaDir = () => troupeEnv('MEDIA_DIR')?.trim() || join(findRepoRoot(), '.data', 'media');
const previewDir = () => resolve(opt('out') ?? join(findRepoRoot(), '.data', 'products-preview'));

/** Renders a doc to <out> without a database and prints the QP report. */
async function renderLocal(doc: ProductDoc, colors: ReturnType<typeof kitColors>, out: string): Promise<number> {
  if (flag('fake')) setProductBackends({ pdf: new FakePdfRenderer() });
  const backends = productBackends({ providers: createFakeProviders() });
  mkdirSync(out, { recursive: true });
  const renders = [];
  for (const size of PAGE_SIZES) {
    const layout = layoutDoc(doc, size);
    const html = renderHtml(doc, layout, colors);
    const r = await backends.pdf.render({ html, layout, title: doc.title });
    const file = join(out, `${slugify(doc.title)}-${size.toLowerCase()}.pdf`);
    writeFileSync(file, r.pdf);
    writeFileSync(file.replace(/\.pdf$/, '.html'), html);
    renders.push({ size, layout, html, pdf: inspectPdf(r.pdf), overflowPages: r.overflowPages });
    console.log(`${size.padEnd(6)} ${String(layout.pages.length).padStart(3)} pages  ${file}`);
  }
  writeFileSync(join(out, `${slugify(doc.title)}-cover.svg`), coverSvg(doc, colors));
  const qp = await runQp({ doc, renders, links: backends.links });
  console.log(`\nQP ${qp.pass ? 'PASS' : 'FAIL'} ${qp.score}/100 (renderer: ${backends.pdf.name})`);
  for (const c of qp.checks) console.log(`  ${c.pass ? 'ok  ' : c.severity === 'minor' ? 'warn' : 'FAIL'} ${c.check.padEnd(22)} ${c.message}`);
  return qp.pass ? 0 : 1;
}

function colorsFrom(hexes: readonly string[] | undefined): ReturnType<typeof kitColors> {
  const palette: PersonaKitColor[] = (hexes ?? []).map((hex, i) => ({ name: `c${i}`, hex: hex.toUpperCase(), use: '' }));
  return kitColors(palette, null);
}

/** Env-only providers for database commands (the server and worker use @troupe/wiring with the Keychain). */
function cliServices(db: Db): StudioServices {
  const penv: ProviderEnv = {
    isLive: (id) => id === 'anthropic' && !!process.env.ANTHROPIC_API_KEY,
    secret: (name) => (name === 'anthropic.api_key' ? (process.env.ANTHROPIC_API_KEY ?? null) : null),
  };
  const providers = { ...createFakeProviders(), ...agentsLiveProviders(penv), storage: new LocalMediaStore(mediaDir()) } as Providers;
  return createServices({ db, providers, mode: 'auto' });
}

async function withDb<T>(fn: (services: StudioServices) => Promise<T>): Promise<T> {
  const db = await openDb().catch((err) =>
    exitOnOpenError('products', err, (holder) =>
      holder.role === 'server' ? `The server imports manuscripts itself: drop the .md file into ${manuscriptsDir()}/<persona-slug>/ (or use \`pnpm products render\`, which needs no database).` : undefined,
    ),
  );
  try {
    await migrate(db);
    return await fn(cliServices(db));
  } finally {
    await db.close();
  }
}

const SAMPLE: ProductBrief = {
  name: 'Sunday Reset Planner',
  promise: 'Plan your week in one 20-minute sitting and keep it running in minutes a day.',
  audience: 'Busy people who say: my week runs me',
  outline: ['Start here: how to use this in 10 minutes', 'Part 1: Clear the decks', 'Part 2: Plan the week', 'Part 3: Fix what slips', 'Worked example', 'Your one-page summary'],
  format: 'Printable PDF planner',
  page_count: 12,
  bonuses: ['Meal grid', 'Errand list'],
  price_cents: 1900,
  ladder_rung: 'entry',
  upsell_pairing: 'the Monthly Reset bundle',
  cta_keyword: 'RESET',
  validation: 'sample',
};

async function main(): Promise<number> {
  switch (cmd) {
    case 'render': {
      const file = positional[0];
      if (!file) throw new Error('give a markdown file');
      const parsed = parseManuscript(readFileSync(file, 'utf8'), { filename: basename(file), personaName: opt('name') ?? '' });
      const name = opt('name') ?? parsed.meta.raw.author ?? 'the studio';
      const doc = withNextStepAndCredits(parsed.doc, { personaName: name, personaSlug: opt('slug') ?? parsed.meta.persona ?? slugify(name), niche: opt('niche') ?? parsed.meta.raw.niche ?? '' });
      return renderLocal(doc, colorsFrom(parsed.meta.palette), previewDir());
    }
    case 'sample':
      return renderLocal(previewDoc(SAMPLE, { name: 'Dot', slug: 'dot', niche: 'home organisation' }), colorsFrom(['#F4EFFA', '#2B2238', '#B48CDB', '#E8B931']), previewDir());
    case 'import': {
      const file = positional[0];
      const persona = opt('persona');
      if (!file) throw new Error('give a markdown file');
      return withDb(async (services) => {
        const r = await importManuscript(services, { text: readFileSync(file, 'utf8'), filename: basename(file), ...(persona ? { personaSlug: persona } : {}) });
        console.log(`${r.status}: product ${r.productId} v${r.version}${r.jobId ? `, build job ${r.jobId}` : ''}`);
        if (flag('now') && r.status === 'imported') {
          const key = (await services.db.one<{ storage_key: string }>('SELECT storage_key FROM product_manuscript WHERE id = $1', [r.manuscriptId])).storage_key;
          const out = await buildProduct(services, { productId: r.productId, personaId: r.personaId, source: 'manuscript', manuscriptKey: key, version: r.version, force: true });
          if (r.jobId) await services.db.query(`UPDATE job SET status = 'succeeded', finished_at = now() WHERE id = $1 AND status = 'queued'`, [r.jobId]);
          console.log(JSON.stringify(out, null, 2));
          return out.status === 'blocked' ? 1 : 0;
        }
        return 0;
      });
    }
    case 'inbox':
      return withDb(async (services) => {
        const r = await scanInbox(services);
        console.log(`inbox ${manuscriptsDir()}: ${r.imported.length} imported (the worker builds them), ${r.skipped} already seen, ${r.errors.length} errors`);
        for (const e of r.errors) console.log(`  ${e.file}: ${e.error}`);
        return r.errors.length ? 1 : 0;
      });
    case 'build': {
      const id = positional[0];
      if (!id) throw new Error('give a product id');
      return withDb(async (services) => {
        const p = await services.db.one<{ persona_id: string }>('SELECT persona_id FROM product WHERE id = $1', [id]);
        const req = await requestBuild(services, id, p.persona_id);
        if (!req.jobId) throw new Error('a build of this product is already queued');
        const job = await services.db.one<{ payload: BuildPayload }>('SELECT payload FROM job WHERE id = $1', [req.jobId]);
        const out = await buildProduct(services, job.payload);
        await services.db.query(`UPDATE job SET status = 'succeeded', finished_at = now() WHERE id = $1 AND status = 'queued'`, [req.jobId]);
        console.log(JSON.stringify(out, null, 2));
        return out.status === 'blocked' ? 1 : 0;
      });
    }
    case 'status':
      return withDb(async (services) => {
        const personas = await services.db.query<{ id: string; name: string }>(`SELECT id, name FROM persona WHERE ($1::text IS NULL OR slug = $1) ORDER BY name`, [positional[0] ?? null]);
        for (const p of personas) {
          const rows = await productStatus(services, p.id);
          if (!rows.length) continue;
          console.log(`\n${p.name}`);
          for (const r of rows) console.log(`  ${r.status.padEnd(18)} ${(r.build_status ?? '-').padEnd(8)} QP ${r.qp_score ?? '-'} ${String(r.pages ?? '-').padStart(3)}p  ${r.name}${r.block_reason ? `\n      ↳ ${r.block_reason.slice(0, 160)}` : ''}`);
        }
        return 0;
      });
    default:
      console.log(HELP);
      return cmd && cmd !== 'help' && cmd !== '--help' ? 2 : 0;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(`[products] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
