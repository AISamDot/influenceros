import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRODUCT_BUILD_JOB, type ProductFile } from '@ios/agents';
import { createTestStudio, makeTestPersona, type TestStudio } from '@ios/agents/testing';
import { briefProduct } from '@ios/content';
import { decide, type JobRow, OWNER } from '@ios/core';
import { json } from '@ios/db';
import type { MemoryMediaStore } from '@ios/providers';
import { afterEach, describe, expect, it } from 'vitest';
import { FakePdfRenderer, importManuscript, inspectPdf, jobs, PRODUCT_JOBS, scanInbox, schedules, setProductBackends, sweepBriefs, tools } from '../src';
import { MANUSCRIPT } from './fixtures';

const PALETTE = `| Palette | Hex | Used for |\n|---|---|---|\n| Cream | #F6F1E7 | backgrounds |\n| Navy | #1F2A44 | text |\n| Rust | #C2562B | accents |\n| Sage | #5A8F7B | second accent |`;

async function studio(): Promise<TestStudio & { persona: { id: string; slug: string; name: string } }> {
  const t = await createTestStudio({ tools });
  const persona = await makeTestPersona(t, { name: 'Dot', niche: 'home organisation' });
  await t.db.query(`INSERT INTO persona_bible (persona_id, version, content, status, created_by) VALUES ($1, 1, $2::jsonb, 'approved', 'test')`, [persona.id, json({ look: PALETTE })]);
  return { ...t, persona };
}

async function runJobs(t: TestStudio, kind: string): Promise<unknown[]> {
  const rows = await t.db.query<JobRow>(`SELECT * FROM job WHERE kind = $1 AND status = 'queued' ORDER BY created_at`, [kind]);
  const out: unknown[] = [];
  for (const job of rows) {
    out.push(await jobs[kind]!({ services: t.services, job, heartbeat: async () => true }));
    await t.db.query(`UPDATE job SET status = 'succeeded' WHERE id = $1`, [job.id]);
  }
  return out;
}

const storage = (t: TestStudio) => t.providers.storage as unknown as MemoryMediaStore;

afterEach(() => setProductBackends(null));

describe('product.build from a Monetization Agent brief', () => {
  it('sweep → build → A4 + Letter PDFs in the persona kit → QP pass → Gate → listing pack → 24 h product_v1 card', async () => {
    const t = await studio();
    const pdf = new FakePdfRenderer();
    setProductBackends({ pdf });
    const { productId } = await briefProduct(t.services, { personaId: t.persona.id, rung: 'entry', title: 'weekly reset planner', notify: false });
    expect(await sweepBriefs(t.services)).toBe(1);
    expect(await sweepBriefs(t.services)).toBe(0); // once per product version

    const [outcome] = (await runJobs(t, PRODUCT_BUILD_JOB)) as Array<{ status: string; version: number; files: ProductFile[]; approvalId: string; fixLoops: number }>;
    expect(outcome).toMatchObject({ status: 'passed', version: 1, fixLoops: 0 });
    expect(pdf.calls.map((c) => c.size)).toEqual(['A4', 'Letter']);

    const product = await t.db.one<{ status: string; current_version: number }>('SELECT status, current_version FROM product WHERE id = $1', [productId]);
    expect(product).toEqual({ status: 'awaiting_approval', current_version: 1 });
    const v = await t.db.one<{ status: string; files: ProductFile[]; file_url: string; page_count: number; source: string }>('SELECT * FROM product_version WHERE product_id = $1 AND version = 1', [productId]);
    expect(v.status).toBe('awaiting_approval');
    expect(v.source).toBe('brief');
    const pdfs = v.files.filter((f) => f.kind === 'pdf');
    expect(pdfs.map((f) => f.pageSize)).toEqual(['A4', 'Letter']);
    expect(v.file_url).toBe(pdfs[0]!.url);
    expect(v.files.some((f) => f.kind === 'cover' && f.storageKey!.startsWith(`public/${t.persona.slug}/`))).toBe(true);
    for (const f of pdfs) {
      const obj = await storage(t).get(f.storageKey!);
      expect(inspectPdf(obj!.data)).toMatchObject({ opens: true, pages: f.pages });
      expect(f.storageKey).toMatch(new RegExp(`^products/${t.persona.id}/${productId}/v1/`));
    }

    const qc = await t.db.one<{ pass: boolean; score: number; details: { checks: Array<{ check: string; pass: boolean }> } }>(`SELECT * FROM qc_report WHERE subject_type = 'product' AND subject_id = $1 AND stage = 'QP'`, [productId]);
    expect(qc.pass).toBe(true);
    expect(qc.details.checks.filter((c) => !c.pass)).toEqual([]);
    const gate = await t.db.one<{ verdict: string }>(`SELECT verdict FROM gate_result WHERE subject_type = 'product' AND subject_id = $1 ORDER BY created_at DESC LIMIT 1`, [productId]);
    expect(gate.verdict).not.toBe('red');
    expect((await t.db.query(`SELECT channel FROM product_listing WHERE product_id = $1 ORDER BY channel`, [productId])).map((r) => (r as { channel: string }).channel)).toEqual(['etsy', 'lemonsqueezy']);

    const card = await t.db.one<{ id: string; kind: string; status: string; mode: string; auto_approve_at: Date | null; payload: { version: number } }>(`SELECT * FROM approval WHERE subject_id = $1`, [productId]);
    expect(card).toMatchObject({ kind: 'product_v1', status: 'pending', payload: { version: 1 } });
    if (card.mode === 'auto_after') expect(card.auto_approve_at!.getTime() - Date.now()).toBeGreaterThan(23 * 3_600_000);

    // The persona kit reached the HTML (rust accent) and the build stored the structured doc.
    const build = await t.db.one<{ status: string; doc: { sections: Array<{ kind: string; blocks: Array<{ t: string }> }> } }>(`SELECT * FROM product_build WHERE product_id = $1`, [productId]);
    expect(build.status).toBe('passed');
    const kinds = new Set(build.doc.sections.flatMap((s) => s.blocks.map((b) => b.t)));
    for (const k of ['rule', 'checklist', 'tracker', 'fillin', 'example']) expect(kinds.has(k)).toBe(true);
    expect(build.doc.sections.at(-1)!.kind).toBe('credits');

    // Idempotent: the same version is not rebuilt.
    const again = await jobs[PRODUCT_BUILD_JOB]!({ services: t.services, job: (await t.db.one<JobRow>(`SELECT * FROM job WHERE kind = $1`, [PRODUCT_BUILD_JOB])), heartbeat: async () => true });
    expect(again).toMatchObject({ status: 'skipped' });

    // The Owner approves the card: core marks the product and v1 approved.
    await decide(t.db, { approvalId: card.id, decision: 'approve', actor: OWNER });
    expect((await t.db.one<{ status: string }>('SELECT status FROM product WHERE id = $1', [productId])).status).toBe('approved');
    await t.db.close();
  });

  it('fixes an overflowing layout in a loop (≤ 2) and records it', async () => {
    const t = await studio();
    setProductBackends({ pdf: new FakePdfRenderer({ overflowPages: [3], overflowTimes: 2 }) });
    const { productId } = await briefProduct(t.services, { personaId: t.persona.id, rung: 'entry', title: 'weekly reset planner', notify: false });
    await sweepBriefs(t.services);
    const [outcome] = (await runJobs(t, PRODUCT_BUILD_JOB)) as Array<{ status: string; fixLoops: number }>;
    expect(outcome).toMatchObject({ status: 'passed', fixLoops: 1 });
    expect((await t.db.one<{ fix_loops: number }>('SELECT fix_loops FROM product_build WHERE product_id = $1', [productId])).fix_loops).toBe(1);
    await t.db.close();
  });

  it('blocks with a QP report, defects and an Owner notification when fonts are not embedded', async () => {
    const t = await studio();
    setProductBackends({ pdf: new FakePdfRenderer({ embedFonts: false }) });
    const { productId } = await briefProduct(t.services, { personaId: t.persona.id, rung: 'entry', title: 'weekly reset planner', notify: false });
    await sweepBriefs(t.services);
    const [outcome] = (await runJobs(t, PRODUCT_BUILD_JOB)) as Array<{ status: string; reason: string }>;
    expect(outcome!.status).toBe('blocked');
    expect(outcome!.reason).toContain('fonts_embedded');
    expect((await t.db.one<{ status: string }>('SELECT status FROM product WHERE id = $1', [productId])).status).toBe('qc');
    expect(await t.db.query(`SELECT 1 FROM product_version WHERE product_id = $1`, [productId])).toHaveLength(0);
    expect(await t.db.query(`SELECT 1 FROM approval WHERE subject_id = $1`, [productId])).toHaveLength(0);
    const defects = await t.db.query<{ type: string; severity: string }>(`SELECT d.type, d.severity FROM qc_defect d JOIN qc_report r ON r.id = d.qc_report_id WHERE r.subject_id = $1`, [productId]);
    expect(defects).toContainEqual({ type: 'fonts_embedded', severity: 'blocker' });
    const n = await t.db.one<{ title: string; link: string }>(`SELECT title, link FROM notification WHERE persona_id = $1 ORDER BY created_at DESC LIMIT 1`, [t.persona.id]);
    expect(n.title).toContain('Product blocked');
    expect(n.link).toBe(`/products#${productId}`);
    // A blocked product isn't swept again until the Owner asks for a rebuild.
    expect(await sweepBriefs(t.services)).toBe(0);
    await t.db.close();
  });
});

describe('content import: manuscripts', () => {
  it('a dropped-in manuscript renders to finished A4 + Letter PDFs with templates, then a v1 card', async () => {
    const t = await studio();
    setProductBackends({ pdf: new FakePdfRenderer() });
    const imp = await importManuscript(t.services, { text: MANUSCRIPT, filename: 'calm-budget.md', personaSlug: t.persona.slug });
    expect(imp).toMatchObject({ status: 'imported', version: 1 });
    expect(imp.jobId).not.toBeNull();
    const product = await t.db.one<{ name: string; slug: string; price_cents: number; status: string }>('SELECT * FROM product WHERE id = $1', [imp.productId]);
    expect(product).toMatchObject({ name: 'The Calm Budget Workbook', slug: 'calm-budget', price_cents: 1700, status: 'brief' });
    // The brief sweep leaves manuscript products to their own job.
    expect(await sweepBriefs(t.services)).toBe(0);

    const [outcome] = (await runJobs(t, PRODUCT_BUILD_JOB)) as Array<{ status: string; files: ProductFile[]; reason?: string }>;
    expect(outcome!.reason).toBeUndefined();
    expect(outcome!.status).toBe('passed');
    expect(outcome!.files.map((f) => f.kind)).toEqual(['pdf', 'pdf', 'cover', 'sheet_template', 'notion_template']);
    expect(outcome!.files.find((f) => f.kind === 'sheet_template')!.url).toMatch(/^https:\/\/sheets\.fake\.invalid\/.+\/copy$/);
    const ms = await t.db.one<{ status: string; product_id: string }>('SELECT status, product_id FROM product_manuscript WHERE id = $1', [imp.manuscriptId]);
    expect(ms).toEqual({ status: 'built', product_id: imp.productId });
    expect((await t.db.one<{ status: string }>('SELECT status FROM product WHERE id = $1', [imp.productId])).status).toBe('awaiting_approval');
    expect(await t.db.query(`SELECT 1 FROM approval WHERE kind = 'product_v1' AND subject_id = $1`, [imp.productId])).toHaveLength(1);

    // The same file again is a duplicate; an edited file with the same slug rebuilds the unapproved v1.
    expect(await importManuscript(t.services, { text: MANUSCRIPT, filename: 'calm-budget.md', personaSlug: t.persona.slug })).toMatchObject({ status: 'duplicate' });
    const edited = await importManuscript(t.services, { text: MANUSCRIPT.replace('one evening.', 'one evening, start to finish.'), filename: 'calm-budget.md', personaSlug: t.persona.slug });
    expect(edited).toMatchObject({ status: 'imported', productId: imp.productId, version: 1 });
    await t.db.close();
  });

  it('QP blocks a manuscript with placeholder text or a missing promised section (no rewriting of the Owner’s words)', async () => {
    const t = await studio();
    const pdf = new FakePdfRenderer();
    setProductBackends({ pdf });
    const bad = MANUSCRIPT.replace('Pay the fixed bills first', 'TODO: [insert rule text] Pay the fixed bills first').replace('## Weekly money check', '## Something else');
    const imp = await importManuscript(t.services, { text: bad, filename: 'bad.md', personaSlug: t.persona.slug });
    const [outcome] = (await runJobs(t, PRODUCT_BUILD_JOB)) as Array<{ status: string; reason: string }>;
    expect(outcome!.status).toBe('blocked');
    expect(outcome!.reason).toContain('no_placeholder');
    expect(outcome!.reason).toContain('Weekly money check');
    expect(pdf.calls).toHaveLength(2); // no fix loop for a manuscript
    expect((await t.db.one<{ status: string }>('SELECT status FROM product_manuscript WHERE id = $1', [imp.manuscriptId])).status).toBe('blocked');
    await t.db.close();
  });

  it('the Gate blocks a manuscript that promises guaranteed income', async () => {
    const t = await studio();
    setProductBackends({ pdf: new FakePdfRenderer() });
    const imp = await importManuscript(t.services, { text: MANUSCRIPT.replace('This workbook takes one evening.', 'This system brings guaranteed income within 30 days.'), filename: 'x.md', personaSlug: t.persona.slug });
    const [outcome] = (await runJobs(t, PRODUCT_BUILD_JOB)) as Array<{ status: string; reason: string }>;
    expect(outcome).toMatchObject({ status: 'blocked' });
    expect(outcome!.reason).toMatch(/Compliance Gate red: guaranteed_returns/);
    expect(await t.db.query(`SELECT 1 FROM approval WHERE subject_id = $1`, [imp.productId])).toHaveLength(0);
    await t.db.close();
  });

  it('the inbox folder imports new files once, by persona subfolder, and tells the Owner about bad ones once', async () => {
    const t = await studio();
    setProductBackends({ pdf: new FakePdfRenderer() });
    const dir = mkdtempSync(join(tmpdir(), 'ios-inbox-'));
    try {
      mkdirSync(join(dir, t.persona.slug));
      writeFileSync(join(dir, t.persona.slug, 'calm-budget.md'), MANUSCRIPT);
      writeFileSync(join(dir, 'orphan.md'), '# No persona\n\n## A\n\nText.');
      const first = await scanInbox(t.services, dir);
      expect(first.imported).toHaveLength(1);
      expect(first.errors).toEqual([{ file: 'orphan.md', error: expect.stringContaining('which persona') }]);
      const second = await scanInbox(t.services, dir);
      expect(second).toMatchObject({ imported: [], skipped: 1 });
      expect(await t.db.query(`SELECT 1 FROM notification WHERE title LIKE 'Manuscript not imported: orphan.md%'`)).toHaveLength(1);
      // The schedule enqueues a scan only when something new is waiting.
      process.env.IOS_MANUSCRIPTS_DIR = dir;
      const inbox = schedules.find((s) => s.name === 'product.inbox')!;
      expect(await inbox.run(t.services, new Date())).toBe(1); // orphan.md is still unseen
      await t.db.query(`UPDATE job SET status = 'succeeded' WHERE kind = $1`, [PRODUCT_JOBS.scanInbox]);
      rmSync(join(dir, 'orphan.md'));
      expect(await inbox.run(t.services, new Date())).toBe(0);
    } finally {
      delete process.env.IOS_MANUSCRIPTS_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
    await t.db.close();
  });
});

describe('product tools', () => {
  it('registers product.* and workbook.* tools; the Owner can queue a rebuild and read status', async () => {
    const t = await studio();
    setProductBackends({ pdf: new FakePdfRenderer() });
    expect(tools.map((x) => x.name).sort()).toEqual(['product.build', 'product.import_manuscript', 'product.status', 'workbook.outline']);
    const ctx = { services: t.services, studioId: t.studioId, personaId: null, caller: 'owner' as const, actor: OWNER };
    const imp = (await t.services.tools.invoke(ctx, 'product.import_manuscript', { persona_id: t.persona.id, markdown: MANUSCRIPT, filename: 'calm.md' })) as { productId: string };
    await runJobs(t, PRODUCT_BUILD_JOB);
    const status = (await t.services.tools.invoke(ctx, 'product.status', { persona_id: t.persona.id })) as Array<{ id: string; build_status: string; qp_pass: boolean; pages: number }>;
    expect(status[0]).toMatchObject({ id: imp.productId, build_status: 'passed', qp_pass: true });
    const outline = (await t.services.tools.invoke(ctx, 'workbook.outline', { persona_id: t.persona.id, product_id: imp.productId })) as { sections: Array<{ title: string }> };
    expect(outline.sections.map((s) => s.title)).toContain('The three buckets');
    const rebuild = (await t.services.tools.invoke(ctx, 'product.build', { persona_id: t.persona.id, product_id: imp.productId })) as { job_id: string; version: number };
    expect(rebuild).toMatchObject({ version: 1 });
    const [again] = (await runJobs(t, PRODUCT_BUILD_JOB)) as Array<{ status: string }>;
    expect(again!.status).toBe('passed');
    await t.db.close();
  });
});

describe('products without a brief', () => {
  it('are not built (no retries on an idea) and a rebuild request says why', async () => {
    const t = await studio();
    const { id } = await t.db.one<{ id: string }>(`INSERT INTO product (persona_id, name, slug, ladder_rung, status) VALUES ($1, 'Idea only', 'idea-only', 'entry', 'idea') RETURNING id`, [t.persona.id]);
    expect(await jobs[PRODUCT_BUILD_JOB]!({ services: t.services, job: { payload: { productId: id, personaId: t.persona.id, source: 'brief' } } as unknown as JobRow, heartbeat: async () => true })).toMatchObject({ status: 'skipped', reason: 'no brief yet' });
    const ctx = { services: t.services, studioId: t.studioId, personaId: null, caller: 'owner' as const, actor: OWNER };
    await expect(t.services.tools.invoke(ctx, 'product.build', { persona_id: t.persona.id, product_id: id })).rejects.toThrow(/no brief yet/);
    await t.db.close();
  });
});
