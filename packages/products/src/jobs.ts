import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { enqueueOnceFor, type JobContext, type JobHandlerMap, PRODUCT_BUILD_JOB, type ScheduledTask, type StudioServices } from '@troupe/agents';
import { BudgetExceededError, DeferJob } from '@troupe/core';
import { type BuildPayload, buildProduct } from './build';
import { listInbox, manuscriptsDir, scanInbox } from './inbox';
import { PdfRendererUnavailableError } from './pdf';

/**
 * Queue handlers and schedules (namespace `product.*`). Schedules only enqueue; handlers are idempotent per
 * product version and defer (without spending an attempt) on a capped budget or a machine without Chrome.
 */
export const PRODUCT_JOBS = { build: PRODUCT_BUILD_JOB, scanInbox: 'product.scan_inbox' } as const;

const BUDGET_DEFER_MS = 6 * 3_600_000;
const NO_CHROME_DEFER_MS = 15 * 60_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function payloadOf(raw: Record<string, unknown>): BuildPayload {
  const productId = String(raw.productId ?? '');
  const personaId = String(raw.personaId ?? '');
  if (!UUID_RE.test(productId) || !UUID_RE.test(personaId)) throw new Error('product.build needs productId and personaId');
  const source = raw.source === 'manuscript' ? 'manuscript' : 'brief';
  return {
    productId,
    personaId,
    source,
    ...(typeof raw.manuscriptKey === 'string' ? { manuscriptKey: raw.manuscriptKey } : {}),
    ...(Number.isInteger(raw.version) ? { version: raw.version as number } : {}),
    ...(raw.force === true ? { force: true } : {}),
  };
}

export const productJobs: JobHandlerMap = {
  async [PRODUCT_BUILD_JOB](ctx: JobContext) {
    const payload = payloadOf(ctx.job.payload);
    try {
      return await buildProduct(ctx.services, payload, { heartbeat: () => ctx.heartbeat() });
    } catch (err) {
      if (err instanceof BudgetExceededError) throw new DeferJob(BUDGET_DEFER_MS, `budget: ${err.message}`);
      if (err instanceof PdfRendererUnavailableError) throw new DeferJob(NO_CHROME_DEFER_MS, err.message);
      throw err;
    }
  },
  async [PRODUCT_JOBS.scanInbox](ctx: JobContext) {
    const r = await scanInbox(ctx.services);
    return { imported: r.imported.length, skipped: r.skipped, errors: r.errors };
  },
};

/** Enqueues a v1 build for every product the Monetization Agent briefed that has no version and no open build. */
export async function sweepBriefs(services: StudioServices): Promise<number> {
  const rows = await services.db.query<{ id: string; persona_id: string; studio_id: string }>(
    `SELECT pr.id, pr.persona_id, pe.studio_id
       FROM product pr JOIN persona pe ON pe.id = pr.persona_id
      WHERE pr.status IN ('brief','building','qc')
        AND pe.state NOT IN ('KILLED','RETIRED','ARCHIVED')
        AND EXISTS (SELECT 1 FROM product_brief b WHERE b.product_id = pr.id AND b.source = 'monetization')
        AND NOT EXISTS (SELECT 1 FROM product_manuscript m WHERE m.product_id = pr.id)
        AND NOT EXISTS (SELECT 1 FROM product_version v WHERE v.product_id = pr.id)
        AND NOT EXISTS (SELECT 1 FROM product_build pb WHERE pb.product_id = pr.id AND pb.status = 'blocked')
      ORDER BY pr.created_at LIMIT 50`,
  );
  let n = 0;
  for (const r of rows) {
    const job = await enqueueOnceFor(
      services.db,
      { kind: PRODUCT_BUILD_JOB, key: `product:${r.id}:v1`, payload: { productId: r.id, personaId: r.persona_id, source: 'brief', version: 1 }, studioId: r.studio_id, personaId: r.persona_id, priority: 80 },
      { ever: true },
    );
    if (job) n += 1;
  }
  return n;
}

const every = (ms: number) => (now: Date, last: Date | null) => !last || now.getTime() - last.getTime() >= ms;

export const productSchedules: readonly ScheduledTask[] = [
  {
    name: 'product.sweep',
    due: every(5 * 60_000),
    run: (services) => sweepBriefs(services),
  },
  {
    name: 'product.inbox',
    due: every(2 * 60_000),
    async run(services) {
      const dir = manuscriptsDir();
      if (!existsSync(dir)) return 0;
      // Only when a file with unseen content is waiting (hashing a few markdown files is cheap).
      let fresh = false;
      for (const f of listInbox(dir)) {
        const hash = createHash('sha256').update(readFileSync(f.path, 'utf8')).digest('hex');
        if (!(await services.db.maybeOne(`SELECT 1 FROM product_manuscript WHERE sha256 = $1 AND product_id IS NOT NULL LIMIT 1`, [hash]))) {
          fresh = true;
          break;
        }
      }
      if (!fresh) return 0;
      const job = await enqueueOnceFor(services.db, { kind: PRODUCT_JOBS.scanInbox, key: 'inbox', payload: {}, priority: 90 });
      return job ? 1 : 0;
    },
  },
];
