import { createHash } from 'node:crypto';
import { loadPersonaKit, type ProductBuildPayload, type ProductFile, type StudioServices } from '@ios/agents';
import { type Actor, audit, notify, propose } from '@ios/core';
import { buildListingPack, type ProductBrief, runGate, saveGateResult } from '@ios/content';
import { json } from '@ios/db';
import { type ProductBackends, productBackends } from './backends';
import { fakeDoc, promisedFromBrief, withNextStepAndCredits, writeFromBrief } from './content';
import { coverSvg, renderHtml } from './html';
import { inspectPdf } from './inspect';
import { layoutDoc } from './layout';
import { parseManuscript } from './manuscript';
import { docText, PAGE_SIZES, type ProductDoc } from './model';
import { runQp, saveQpReport, type QpResult } from './qp';
import { hasTemplateContent, templateSpec, wantedTemplates } from './templates';

/**
 * product.build (docs/IOS-34-CONTRACTS.md §5.1, H):
 *   brief (writer agent) or manuscript (parsed as written) → structured content → styled HTML (persona kit) →
 *   PDFs A4 + Letter (headless Chrome) → QP (≤ 2 fix loops) → Gate → stored files → product_version →
 *   v1: listing pack + product 'awaiting_approval' + a product_v1 card (24 h, studio policy).
 * Idempotent per product version: a version that already passed is skipped; a crashed build resumes from scratch.
 */

export const PRODUCT_BUILDER: Actor = { type: 'agent', id: 'product-builder' };
export const MAX_FIX_LOOPS = 2;

/** Extra payload fields H's own enqueuers set (the shared ProductBuildPayload stays as frozen in ios34.ts). */
export type BuildPayload = ProductBuildPayload & { readonly version?: number; readonly force?: boolean };

export interface BuildOutcome {
  readonly status: 'passed' | 'blocked' | 'skipped';
  readonly productId: string;
  readonly version: number;
  readonly reason?: string;
  readonly qcReportId?: string;
  readonly approvalId?: string;
  readonly files?: readonly ProductFile[];
  readonly fixLoops?: number;
  readonly pages?: number;
}

interface ProductRow {
  id: string;
  persona_id: string;
  name: string;
  slug: string;
  status: string;
  ladder_rung: string;
  price_cents: number;
  persona_slug: string;
  persona_name: string;
  niche: string;
  studio_id: string;
  state: string;
}

const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');

/** Section titles: what "material change" between versions compares (FR-9.3). */
const outlineOf = (doc: ProductDoc) => doc.sections.filter((s) => s.kind !== 'credits').map((s) => s.title);

async function loadDoc(services: StudioServices, p: ProductRow, payload: BuildPayload, feedback?: readonly string[]): Promise<{ doc: ProductDoc; format: string; templates: Array<'sheet' | 'notion'>; nextStep?: string }> {
  const { db } = services;
  if (payload.source === 'manuscript') {
    if (!payload.manuscriptKey) throw new Error('a manuscript build needs manuscriptKey');
    const obj = await services.providers.storage.get(payload.manuscriptKey);
    if (!obj) throw new Error(`manuscript ${payload.manuscriptKey} is not in storage`);
    const parsed = parseManuscript(new TextDecoder().decode(obj.data), { personaName: p.persona_name });
    return { doc: parsed.doc, format: 'PDF workbook', templates: [...(parsed.meta.templates ?? [])] };
  }
  const row = await db.maybeOne<{ content: ProductBrief }>(`SELECT content FROM product_brief WHERE product_id = $1 ORDER BY created_at DESC LIMIT 1`, [p.id]);
  if (!row) throw new Error(`product ${p.id} has no brief`);
  const brief = row.content;
  const { doc } = await writeFromBrief(services, { personaId: p.persona_id, productId: p.id, brief, feedback });
  // The writer must keep the brief's promise list even when the model drops a field.
  const promised = doc.promised.length ? doc.promised : promisedFromBrief(brief);
  return { doc: { ...doc, promised }, format: brief.format, templates: [], nextStep: brief.upsell_pairing || undefined };
}

async function renderAll(doc: ProductDoc, colors: Parameters<typeof renderHtml>[2], backends: ProductBackends, density: number) {
  const out = [];
  for (const size of PAGE_SIZES) {
    const layout = layoutDoc(doc, size, density);
    const html = renderHtml(doc, layout, colors);
    const r = await backends.pdf.render({ html, layout, title: doc.title });
    out.push({ size, layout, html, pdfBytes: r.pdf, pdf: inspectPdf(r.pdf), overflowPages: r.overflowPages });
  }
  return out;
}

async function setBuild(services: StudioServices, productId: string, version: number, fields: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${k} = $${i + 3}${k === 'doc' ? '::jsonb' : ''}`).join(', ');
  await services.db.query(`UPDATE product_build SET ${sets}, updated_at = now() WHERE product_id = $1 AND version = $2`, [productId, version, ...keys.map((k) => (k === 'doc' ? json(fields[k]) : fields[k]))]);
}

async function block(services: StudioServices, p: ProductRow, version: number, payload: BuildPayload, reason: string, qcReportId?: string): Promise<BuildOutcome> {
  await setBuild(services, p.id, version, { status: 'blocked', block_reason: reason.slice(0, 1000) });
  if (payload.manuscriptKey) await services.db.query(`UPDATE product_manuscript SET status = 'blocked' WHERE storage_key = $1`, [payload.manuscriptKey]);
  await notify(services.db, {
    studioId: p.studio_id,
    personaId: p.persona_id,
    kind: 'system',
    severity: 'warn',
    title: `Product blocked: ${p.name} v${version}`,
    body: reason.slice(0, 600),
    link: `/products#${p.id}`,
  });
  await audit(services.db, { studioId: p.studio_id, personaId: p.persona_id, actor: PRODUCT_BUILDER, action: 'product.blocked', entityType: 'product', entityId: p.id, data: { version, reason: reason.slice(0, 300) } });
  return { status: 'blocked', productId: p.id, version, reason, qcReportId };
}

export async function buildProduct(
  services: StudioServices,
  payload: BuildPayload,
  opts: { heartbeat?: () => Promise<boolean>; backends?: ProductBackends } = {},
): Promise<BuildOutcome> {
  const { db } = services;
  const backends = opts.backends ?? productBackends(services);
  const alive = async () => (opts.heartbeat ? opts.heartbeat() : true);
  const p = await db.maybeOne<ProductRow>(
    `SELECT pr.id, pr.persona_id, pr.name, pr.slug, pr.status, pr.ladder_rung, pr.price_cents,
            pe.slug AS persona_slug, pe.name AS persona_name, pe.niche, pe.studio_id, pe.state
       FROM product pr JOIN persona pe ON pe.id = pr.persona_id WHERE pr.id = $1 AND pr.persona_id = $2`,
    [payload.productId, payload.personaId],
  );
  const version = Math.max(1, Math.trunc(payload.version ?? 1));
  if (!p) return { status: 'skipped', productId: payload.productId, version, reason: 'no such product for this persona' };
  if (p.state === 'KILLED' || p.state === 'RETIRED') return { status: 'skipped', productId: p.id, version, reason: `persona is ${p.state}` };
  if (p.status === 'retired') return { status: 'skipped', productId: p.id, version, reason: 'product retired' };

  if (payload.source === 'brief' && !(await db.maybeOne(`SELECT 1 FROM product_brief WHERE product_id = $1 LIMIT 1`, [p.id]))) {
    return { status: 'skipped', productId: p.id, version, reason: 'no brief yet' };
  }
  const existing = await db.maybeOne<{ status: string }>(`SELECT status FROM product_version WHERE product_id = $1 AND version = $2`, [p.id, version]);
  if (existing && (existing.status === 'approved' || existing.status === 'live' || existing.status === 'retired')) {
    return { status: 'skipped', productId: p.id, version, reason: `v${version} is already ${existing.status}` };
  }
  const prior = await db.maybeOne<{ status: string }>(`SELECT status FROM product_build WHERE product_id = $1 AND version = $2`, [p.id, version]);
  if (existing && prior?.status === 'passed' && !payload.force) return { status: 'skipped', productId: p.id, version, reason: `v${version} already built` };

  await db.query(
    `INSERT INTO product_build (product_id, persona_id, version, source, status, renderer) VALUES ($1, $2, $3, $4, 'running', $5)
     ON CONFLICT (product_id, version) DO UPDATE SET status = 'running', source = EXCLUDED.source, renderer = EXCLUDED.renderer, error = NULL, block_reason = NULL, fix_loops = 0, updated_at = now()`,
    [p.id, p.persona_id, version, payload.source, backends.pdf.name],
  );
  const firstVersion = !['approved', 'live'].includes(p.status);
  if (firstVersion) await db.query(`UPDATE product SET status = 'building' WHERE id = $1 AND status IN ('idea','brief','building','qc','awaiting_approval')`, [p.id]);

  try {
    const kit = await loadPersonaKit(db, p.persona_id);
    const finish = (d: ProductDoc, nextStep?: string) => withNextStepAndCredits(d, { personaName: p.persona_name, personaSlug: p.persona_slug, niche: p.niche, nextStep });
    let loaded = await loadDoc(services, p, payload);
    let doc = finish(loaded.doc, loaded.nextStep);
    if (firstVersion) await db.query(`UPDATE product SET status = 'qc' WHERE id = $1 AND status = 'building'`, [p.id]);

    let density = 1;
    let fixLoops = 0;
    let renders = await renderAll(doc, kit.colors, backends, density);
    let qp: QpResult = await runQp({ doc, renders, links: backends.links });
    while (!qp.pass && fixLoops < MAX_FIX_LOOPS) {
      if (!(await alive())) throw new Error('lease lost');
      let fixed = false;
      if (qp.overflow) {
        density += 0.15;
        fixed = true;
      }
      if (qp.contentFeedback.length && payload.source === 'brief') {
        loaded = await loadDoc(services, p, payload, qp.contentFeedback);
        doc = finish(loaded.doc, loaded.nextStep);
        fixed = true;
      }
      if (!fixed) break; // a manuscript's words are the Owner's: QP reports, it doesn't rewrite them
      fixLoops += 1;
      renders = await renderAll(doc, kit.colors, backends, density);
      qp = await runQp({ doc, renders, links: backends.links });
    }
    if (!(await alive())) throw new Error('lease lost');

    const pages = renders[0]!.layout.pages.length;
    const qcReportId = await saveQpReport(db, {
      personaId: p.persona_id,
      productId: p.id,
      version,
      result: qp,
      extra: { source: payload.source, fix_loops: fixLoops, renderer: backends.pdf.name, pages: Object.fromEntries(renders.map((r) => [r.size, r.layout.pages.length])) },
    });
    await setBuild(services, p.id, version, { doc, fix_loops: fixLoops, qc_report_id: qcReportId });
    if (!qp.pass) {
      const failing = qp.checks.filter((c) => !c.pass && c.severity !== 'minor').map((c) => `${c.check} (${c.severity}): ${c.message}`);
      return await block(services, p, version, payload, `QP failed after ${fixLoops} fix loop${fixLoops === 1 ? '' : 's'}: ${failing.join(' | ')}`, qcReportId);
    }

    // The Compliance Gate on the product's words (legal/platform lines only). Red never ships.
    const gate = await runGate(services, {
      studioId: p.studio_id,
      personaId: p.persona_id,
      input: { kind: 'listing', text: docText(doc).slice(0, 30_000), purpose: 'sell' },
      costRef: { type: 'product', id: p.id },
      label: 'gate: product content',
    });
    await saveGateResult(services, { personaId: p.persona_id, subjectType: 'product', subjectId: p.id, stage: 'pre_publish', verdict: gate.verdict, checks: gate.checks });
    if (gate.verdict === 'red') {
      const reds = gate.checks.filter((c) => c.verdict === 'red').map((c) => `${c.rule}: ${c.message}${c.span ? ` ("${c.span}")` : ''}`);
      return await block(services, p, version, payload, `Compliance Gate red: ${reds.join(' | ')}`, qcReportId);
    }

    // Files.
    const prefix = `products/${p.persona_id}/${p.id}/v${version}`;
    const storage = services.providers.storage;
    const files: ProductFile[] = [];
    for (const r of renders) {
      const stored = await storage.put({ key: `${prefix}/${p.slug}-${r.size.toLowerCase()}.pdf`, data: r.pdfBytes, contentType: 'application/pdf' });
      files.push({ kind: 'pdf', label: `${doc.title} (${r.size === 'A4' ? 'A4' : 'US Letter'})`, pageSize: r.size, storageKey: stored.key, url: stored.url, pages: r.pdf.pages, bytes: stored.bytes });
    }
    const cover = await storage.put({ key: `public/${p.persona_slug}/products/${p.slug}/v${version}/cover.svg`, data: coverSvg(doc, kit.colors), contentType: 'image/svg+xml' });
    files.push({ kind: 'cover', label: `${doc.title} cover`, storageKey: cover.key, url: cover.url, bytes: cover.bytes });
    const wanted = hasTemplateContent(doc) ? wantedTemplates(loaded.format, loaded.templates) : [];
    for (const kind of wanted) {
      const spec = templateSpec(doc);
      const maker = kind === 'sheet' ? backends.sheets : backends.notion;
      const t = await maker.createTemplate(spec, { keyPrefix: prefix });
      files.push({ kind: kind === 'sheet' ? 'sheet_template' : 'notion_template', label: `${doc.title} (${kind === 'sheet' ? 'Google Sheets' : 'Notion'} template)`, url: t.url, ...(t.storageKey ? { storageKey: t.storageKey } : {}) });
      await db.query(
        `INSERT INTO product_template (product_id, persona_id, version, kind, provider, url, spec) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         ON CONFLICT (product_id, version, kind) DO UPDATE SET provider = EXCLUDED.provider, url = EXCLUDED.url, spec = EXCLUDED.spec`,
        [p.id, p.persona_id, version, kind, t.provider, t.url, json(spec)],
      );
    }

    // Material change (FR-9.3): later versions need approval only when the sections changed.
    const outline = outlineOf(doc);
    const prev = version > 1 ? await db.maybeOne<{ outline: string[] }>(`SELECT outline FROM product_version WHERE product_id = $1 AND version < $2 ORDER BY version DESC LIMIT 1`, [p.id, version]) : null;
    const material = firstVersion || !prev || JSON.stringify(prev.outline) !== JSON.stringify(outline);
    const versionStatus = !firstVersion && !material ? 'approved' : 'awaiting_approval';
    const contentHash = sha(JSON.stringify(doc));
    const a4 = files.find((f) => f.kind === 'pdf' && f.pageSize === 'A4')!;
    await db.query(
      `INSERT INTO product_version (product_id, persona_id, version, file_url, changelog, status, files, source, page_count, qc_report_id, content_hash, outline)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12::jsonb)
       ON CONFLICT (product_id, version) DO UPDATE SET file_url = EXCLUDED.file_url, changelog = EXCLUDED.changelog, status = EXCLUDED.status, files = EXCLUDED.files,
         source = EXCLUDED.source, page_count = EXCLUDED.page_count, qc_report_id = EXCLUDED.qc_report_id, content_hash = EXCLUDED.content_hash, outline = EXCLUDED.outline`,
      [p.id, p.persona_id, version, a4.url, version === 1 ? 'First version' : material ? 'Sections changed' : 'Content refresh (same sections)', versionStatus, json(files), payload.source, pages, qcReportId, contentHash, json(outline)],
    );

    let approvalId: string | undefined;
    let listingVerdict: string | null = null;
    if (firstVersion) {
      try {
        listingVerdict = (await buildListingPack(services, p.id)).verdict;
      } catch (err) {
        listingVerdict = `error: ${(err as Error).message.slice(0, 120)}`;
      }
      await db.query(`UPDATE product SET status = 'awaiting_approval', current_version = $2 WHERE id = $1 AND status IN ('building','qc','awaiting_approval')`, [p.id, version]);
      const open = await db.maybeOne<{ id: string }>(`SELECT id FROM approval WHERE kind = 'product_v1' AND subject_id = $1 AND status = 'pending'`, [p.id]);
      if (open) {
        await db.query(`UPDATE approval SET payload = payload || $2::jsonb WHERE id = $1`, [open.id, json({ version, files, qc_report_id: qcReportId, qp_score: qp.score, pages })]);
        approvalId = open.id;
      } else {
        const a = await propose(db, {
          studioId: p.studio_id,
          personaId: p.persona_id,
          kind: 'product_v1',
          title: `${p.name}: approve v1`,
          summary: `${pages}-page ${p.ladder_rung.replace('_', ' ')} (A4 + US Letter${wanted.length ? ` + ${wanted.join(' and ')} template` : ''}), ${p.price_cents ? `$${(p.price_cents / 100).toFixed(0)}` : 'free'}. QP ${qp.score}/100${fixLoops ? ` after ${fixLoops} fix loop${fixLoops > 1 ? 's' : ''}` : ''}, Gate ${gate.verdict}, listing pack ${listingVerdict ?? 'n/a'}. Spot-check the PDF before it goes on sale.`,
          payload: { version, files, qc_report_id: qcReportId, qp_score: qp.score, gate: gate.verdict, listing: listingVerdict, pages, source: payload.source },
          subjectType: 'product',
          subjectId: p.id,
          proposedBy: PRODUCT_BUILDER,
        });
        approvalId = a.id;
      }
    } else if (!material) {
      await db.query(`UPDATE product SET current_version = $2 WHERE id = $1`, [p.id, version]);
      // Paid files live in Lemon Squeezy (uploaded by hand): say so instead of promising buyers the new files.
      const delivery = p.price_cents > 0 ? 'Replace the file in Lemon Squeezy so buyers get it.' : 'The free download now serves it.';
      await notify(db, { studioId: p.studio_id, personaId: p.persona_id, kind: 'system', title: `${p.name} v${version} is ready`, body: `Same sections as before, so no approval needed (FR-9.3). ${delivery}`, link: `/products#${p.id}` });
    } else {
      // Material change (FR-9.3): an approval card for this version (the product_v1 kind with payload.version).
      const open = await db.maybeOne<{ id: string }>(`SELECT id FROM approval WHERE kind = 'product_v1' AND subject_id = $1 AND status = 'pending' AND (payload->>'version')::int = $2`, [p.id, version]);
      if (open) {
        approvalId = open.id;
      } else {
        const a = await propose(db, {
          studioId: p.studio_id,
          personaId: p.persona_id,
          kind: 'product_v1',
          title: `${p.name}: approve v${version} (sections changed)`,
          summary: `v${version} changed its sections, ${pages} pages, QP ${qp.score}/100, Gate ${gate.verdict}. Approving makes it the current version${p.price_cents > 0 ? '; then replace the file in Lemon Squeezy so buyers get it' : ''}.`,
          payload: { version, files, qc_report_id: qcReportId, qp_score: qp.score, gate: gate.verdict, pages, source: payload.source, outline },
          subjectType: 'product',
          subjectId: p.id,
          proposedBy: PRODUCT_BUILDER,
        });
        approvalId = a.id;
      }
      await notify(db, {
        studioId: p.studio_id,
        personaId: p.persona_id,
        kind: 'approval',
        severity: 'warn',
        title: `${p.name} v${version} changed its sections`,
        body: `A material change: approve it in Approvals before it becomes the current version.`,
        link: '/approvals',
      });
    }
    await setBuild(services, p.id, version, { status: 'passed' });
    if (payload.manuscriptKey) await db.query(`UPDATE product_manuscript SET status = 'built', product_id = $2 WHERE storage_key = $1`, [payload.manuscriptKey, p.id]);
    await audit(db, { studioId: p.studio_id, personaId: p.persona_id, actor: PRODUCT_BUILDER, action: 'product.built', entityType: 'product', entityId: p.id, data: { version, pages, qp: qp.score, fix_loops: fixLoops, gate: gate.verdict, source: payload.source } });
    return { status: 'passed', productId: p.id, version, qcReportId, approvalId, files, fixLoops, pages };
  } catch (err) {
    await setBuild(services, p.id, version, { status: 'failed', error: (err as Error).message.slice(0, 1000) }).catch(() => {});
    throw err;
  }
}

/** For previews without a database (the CLI's `render`): the fake writer's doc for a brief, with next step and credits. */
export function previewDoc(brief: ProductBrief, persona: { name: string; slug: string; niche: string }): ProductDoc {
  return withNextStepAndCredits(fakeDoc(brief, persona.name), { personaName: persona.name, personaSlug: persona.slug, niche: persona.niche, nextStep: brief.upsell_pairing });
}
