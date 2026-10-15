import { enqueueOnceFor, PRODUCT_BUILD_JOB, type Caller, type StudioServices, type ToolDef } from '@ios/agents';
import { type ProductDoc } from './model';
import { importManuscript, type ImportResult } from './inbox';

/**
 * Product Builder tools (namespaces `product.*`, `workbook.*`). Reads are open to the studio's agents; builds and
 * imports enqueue work for the queue (never inline) and, from an untrusted run, need the Owner to have asked.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READERS: readonly Caller[] = ['product-builder', 'monetization-agent', 'persona-manager', 'studio-manager', 'owner', 'system'];
const BUILDERS: readonly Caller[] = ['product-builder', 'monetization-agent', 'persona-manager', 'studio-manager', 'owner', 'system'];

function obj(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('input must be an object');
  const o = raw as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !keys.includes(k));
  if (extra.length) throw new Error(`unknown input keys: ${extra.join(', ')}`);
  return o;
}
function uuid(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw new Error(`${key} must be a uuid`);
  return v;
}

/**
 * Queues a (re)build of a product. Before approval it rebuilds v1 (forced); an approved or live product gets the
 * next version. Returns null when the same build is already queued.
 */
export async function requestBuild(services: StudioServices, productId: string, personaId: string): Promise<{ jobId: string | null; version: number }> {
  const { db } = services;
  const p = await db.maybeOne<{ status: string; studio_id: string; manuscript: string | null }>(
    `SELECT pr.status, pe.studio_id,
            (SELECT m.storage_key FROM product_manuscript m WHERE m.product_id = pr.id ORDER BY m.created_at DESC LIMIT 1) AS manuscript
       FROM product pr JOIN persona pe ON pe.id = pr.persona_id WHERE pr.id = $1 AND pr.persona_id = $2`,
    [productId, personaId],
  );
  if (!p) throw new Error('no such product for this persona');
  if (p.status === 'retired') throw new Error('the product is retired');
  if (!p.manuscript && !(await db.maybeOne(`SELECT 1 FROM product_brief WHERE product_id = $1 LIMIT 1`, [productId]))) {
    throw new Error('this product has no brief yet: the Monetization Agent briefs it first (or import a manuscript)');
  }
  const max = (await db.one<{ v: number }>(`SELECT COALESCE(max(version), 0)::int AS v FROM product_version WHERE product_id = $1`, [productId])).v;
  const version = p.status === 'approved' || p.status === 'live' ? max + 1 : Math.max(1, max);
  const job = await enqueueOnceFor(db, {
    kind: PRODUCT_BUILD_JOB,
    key: `product:${productId}:v${version}:rebuild`,
    payload: { productId, personaId, source: p.manuscript ? 'manuscript' : 'brief', ...(p.manuscript ? { manuscriptKey: p.manuscript } : {}), version, force: true },
    studioId: p.studio_id,
    personaId,
    priority: 60,
  });
  return { jobId: job?.id ?? null, version };
}

export interface ProductStatusRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  ladder_rung: string;
  price_cents: number;
  current_version: number | null;
  build_status: string | null;
  block_reason: string | null;
  qp_score: number | null;
  qp_pass: boolean | null;
  pages: number | null;
  files: unknown[];
}

export async function productStatus(services: StudioServices, personaId: string): Promise<ProductStatusRow[]> {
  return services.db.query<ProductStatusRow>(
    `SELECT pr.id, pr.name, pr.slug, pr.status, pr.ladder_rung, pr.price_cents, pr.current_version,
            b.status AS build_status, b.block_reason, q.score::float AS qp_score, q.pass AS qp_pass, v.page_count AS pages, COALESCE(v.files, '[]'::jsonb) AS files
       FROM product pr
       LEFT JOIN LATERAL (SELECT * FROM product_build WHERE product_id = pr.id ORDER BY version DESC, updated_at DESC LIMIT 1) b ON true
       LEFT JOIN qc_report q ON q.id = b.qc_report_id
       LEFT JOIN product_version v ON v.product_id = pr.id AND v.version = b.version
      WHERE pr.persona_id = $1 AND pr.status <> 'retired'
      ORDER BY pr.created_at DESC`,
    [personaId],
  );
}

const productBuild: ToolDef<{ persona_id: string; product_id: string }, { job_id: string | null; version: number }> = {
  name: 'product.build',
  description: "Queue a build (or rebuild) of one of the persona's products: content → styled PDFs (A4 + US Letter) → QC QP → Gate → v1 approval card. Before approval it rebuilds v1; an approved product gets the next version.",
  scope: 'persona',
  callers: BUILDERS,
  mutates: true,
  ownerIntent: /\b(?:build|rebuild|make|remake|render|regenerate|redo)\b.*\b(?:product|workbook|pdf|planner|guide|checklist|lead magnet|v\d)\b/i,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['persona_id', 'product_id'],
    properties: { persona_id: { type: 'string', format: 'uuid' }, product_id: { type: 'string', format: 'uuid' } },
  },
  parse: (raw) => {
    const o = obj(raw, ['persona_id', 'product_id']);
    return { persona_id: uuid(o, 'persona_id'), product_id: uuid(o, 'product_id') };
  },
  async run(ctx, input) {
    const r = await requestBuild(ctx.services, input.product_id, input.persona_id);
    return { job_id: r.jobId, version: r.version };
  },
};

const productStatusTool: ToolDef<{ persona_id: string }, ProductStatusRow[]> = {
  name: 'product.status',
  description: "The persona's products with their latest build: status, QP score and pass, page count, files (PDFs, cover, templates) and any block reason.",
  scope: 'persona',
  callers: READERS,
  inputSchema: { type: 'object', additionalProperties: false, required: ['persona_id'], properties: { persona_id: { type: 'string', format: 'uuid' } } },
  parse: (raw) => ({ persona_id: uuid(obj(raw, ['persona_id']), 'persona_id') }),
  run: (ctx, input) => productStatus(ctx.services, input.persona_id),
};

const importTool: ToolDef<{ persona_id: string; markdown: string; filename: string }, ImportResult> = {
  name: 'product.import_manuscript',
  description:
    'Import a ready-written product manuscript (markdown: "## Section" headings, "### Rule: …", "- [ ] item" tick boxes, "Fill in: …" prompts, front matter for title/price/sections) and queue it to render as finished PDFs through the Product Builder.',
  scope: 'persona',
  callers: ['owner', 'studio-manager', 'persona-manager', 'product-builder', 'system'],
  mutates: true,
  ownerIntent: /\b(?:import|render|build|make|turn)\b.*\b(?:manuscript|markdown|pdf|product|workbook)\b/i,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['persona_id', 'markdown', 'filename'],
    properties: { persona_id: { type: 'string', format: 'uuid' }, markdown: { type: 'string', maxLength: 400_000 }, filename: { type: 'string', maxLength: 200 } },
  },
  parse: (raw) => {
    const o = obj(raw, ['persona_id', 'markdown', 'filename']);
    const markdown = typeof o.markdown === 'string' ? o.markdown : '';
    if (!markdown.trim() || markdown.length > 400_000) throw new Error('markdown must be 1–400000 characters');
    const filename = typeof o.filename === 'string' && o.filename.trim() ? o.filename.trim().slice(0, 200) : 'manuscript.md';
    return { persona_id: uuid(o, 'persona_id'), markdown, filename };
  },
  run: (ctx, input) => importManuscript(ctx.services, { personaId: input.persona_id, text: input.markdown, filename: input.filename }),
};

const outlineTool: ToolDef<{ persona_id: string; product_id: string }, { title: string; sections: Array<{ title: string; kind: string; blocks: string[] }> } | null> = {
  name: 'workbook.outline',
  description: "The structure of a product's latest build: its sections and the kinds of blocks in each (rules, trackers, fill-in pages, checklists).",
  scope: 'persona',
  callers: READERS,
  // An imported manuscript is third-party text.
  untrustedOutput: true,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['persona_id', 'product_id'],
    properties: { persona_id: { type: 'string', format: 'uuid' }, product_id: { type: 'string', format: 'uuid' } },
  },
  parse: (raw) => {
    const o = obj(raw, ['persona_id', 'product_id']);
    return { persona_id: uuid(o, 'persona_id'), product_id: uuid(o, 'product_id') };
  },
  async run(ctx, input) {
    const row = await ctx.services.db.maybeOne<{ doc: ProductDoc | null }>(
      `SELECT doc FROM product_build WHERE product_id = $1 AND persona_id = $2 AND doc IS NOT NULL ORDER BY version DESC, updated_at DESC LIMIT 1`,
      [input.product_id, input.persona_id],
    );
    if (!row?.doc) return null;
    return { title: row.doc.title, sections: row.doc.sections.map((s) => ({ title: s.title, kind: s.kind, blocks: s.blocks.map((b) => b.t) })) };
  },
};

export const productTools: ReadonlyArray<ToolDef<any, any>> = [productBuild, productStatusTool, importTool, outlineTool];
