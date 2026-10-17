import type { ProductFile } from '@troupe/agents';
import type { Db } from '@troupe/db';

/** Read model for the Products page and the persona panel (stream H). */
export interface ProductCardRow {
  id: string;
  persona_id: string;
  persona_name: string;
  persona_slug: string;
  name: string;
  slug: string;
  status: string;
  ladder_rung: string;
  price_cents: number;
  version: number | null;
  build_status: string | null;
  block_reason: string | null;
  fix_loops: number | null;
  source: string | null;
  updated_at: Date | null;
  qp_score: number | null;
  qp_pass: boolean | null;
  qp_checks: Array<{ check: string; pass: boolean; severity: string; message: string }> | null;
  pages: number | null;
  files: ProductFile[];
  version_status: string | null;
  approval_id: string | null;
  job_status: string | null;
  buildable: boolean;
}

export async function productCards(db: Db, opts: { studioId: string; personaId?: string }): Promise<ProductCardRow[]> {
  return db.query<ProductCardRow>(
    `SELECT pr.id, pr.persona_id, pe.name AS persona_name, pe.slug AS persona_slug, pr.name, pr.slug, pr.status, pr.ladder_rung, pr.price_cents,
            b.version, b.status AS build_status, b.block_reason, b.fix_loops, b.source, b.updated_at,
            q.score::float AS qp_score, q.pass AS qp_pass, q.details->'checks' AS qp_checks,
            v.page_count AS pages, COALESCE(v.files, '[]'::jsonb) AS files, v.status AS version_status,
            (SELECT a.id FROM approval a WHERE a.subject_id = pr.id AND a.kind = 'product_v1' AND a.status = 'pending' LIMIT 1) AS approval_id,
            EXISTS (SELECT 1 FROM product_brief pb WHERE pb.product_id = pr.id) AS buildable,
            (SELECT j.status FROM job j WHERE j.kind = 'product.build' AND j.payload->>'productId' = pr.id::text AND j.status IN ('queued','running') ORDER BY j.created_at DESC LIMIT 1) AS job_status
       FROM product pr
       JOIN persona pe ON pe.id = pr.persona_id
       LEFT JOIN LATERAL (SELECT * FROM product_build WHERE product_id = pr.id ORDER BY version DESC, updated_at DESC LIMIT 1) b ON true
       LEFT JOIN qc_report q ON q.id = b.qc_report_id
       LEFT JOIN product_version v ON v.product_id = pr.id AND v.version = b.version
      WHERE pe.studio_id = $1 AND ($2::uuid IS NULL OR pr.persona_id = $2) AND pr.status <> 'retired'
      ORDER BY pe.name, pr.created_at DESC`,
    [opts.studioId, opts.personaId ?? null],
  );
}

/** Owner download link for a stored product file (served by /api/products/files/…), else the file's own link. */
export function fileHref(f: ProductFile): string {
  return f.storageKey ? `/api/products/files/${f.storageKey}` : f.url;
}

export const FILE_LABEL: Record<string, string> = {
  pdf: 'PDF',
  cover: 'Cover',
  sheet_template: 'Sheets',
  notion_template: 'Notion',
  audio: 'Audio',
  image: 'Image',
};

/** One short line for where a product is in the pipeline. */
export function stageLine(r: ProductCardRow): { label: string; tone: 'ok' | 'warn' | 'danger' | 'muted' } {
  if (r.job_status === 'running') return { label: 'Building now', tone: 'warn' };
  if (r.job_status === 'queued') return { label: 'Queued to build', tone: 'muted' };
  if (r.build_status === 'blocked') return { label: 'Blocked by QC', tone: 'danger' };
  if (r.build_status === 'failed') return { label: 'Build failed', tone: 'danger' };
  if (r.status === 'awaiting_approval') return { label: 'Waiting for your v1 approval', tone: 'warn' };
  if (r.status === 'approved') return { label: 'Approved: listing next', tone: 'ok' };
  if (r.status === 'live') return { label: 'On sale', tone: 'ok' };
  if (r.status === 'brief') return { label: 'Briefed: build queued shortly', tone: 'muted' };
  if (r.status === 'idea') return { label: 'Idea: not briefed yet', tone: 'muted' };
  return { label: r.status.replace('_', ' '), tone: 'muted' };
}
