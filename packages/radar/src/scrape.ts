import { ApifyWeeklyCapError, meteredApify, type ServiceBase } from '@ios/agents';
import { BudgetExceededError } from '@ios/core';
import { json } from '@ios/db';
import { estimateUsd, type RadarConfig, type ScraperKind } from './config';
import { installFakeFixtures } from './fixtures';

const DAY = 86_400_000;

/** Monday 00:00 UTC of the week holding `d`. */
export function weekStartOf(d: Date): Date {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (x.getUTCDay() + 6) % 7;
  return new Date(x.getTime() - dow * DAY);
}
export const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * One Apify scraper run for the Radar: always through `meteredApify` (governor + the studio's weekly cap, ledger
 * provider 'apify', ref = the studio), logged in `radar_run` whatever happens. Over the cap it throws
 * ApifyWeeklyCapError (the job defers until the week rolls over); it never raises a cap. In fake mode the demo
 * datasets are installed first (test fixtures win).
 */
export async function runScrape(
  services: Pick<ServiceBase, 'db' | 'providers' | 'now'>,
  q: { studioId: string; niche: string | null; kind: ScraperKind; input: Record<string, unknown>; maxItems: number; cfg: RadarConfig },
): Promise<unknown[]> {
  installFakeFixtures(services.providers, q.cfg, services.now);
  const actor = q.cfg.actors[q.kind];
  const maxItems = Math.max(1, Math.floor(q.maxItems));
  const est = estimateUsd(q.cfg, q.kind, maxItems);
  const log = (status: 'ok' | 'capped' | 'failed', items: number, cost: number, error: string | null) =>
    services.db.query(
      `INSERT INTO radar_run (studio_id, kind, actor, niche, input, max_items, items, cost_usd, status, error, week_start)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11)`,
      [q.studioId, q.kind, actor.id, q.niche, json(q.input), maxItems, items, cost, status, error, isoDate(weekStartOf(services.now()))],
    );
  try {
    const r = await meteredApify(services, {
      studioId: q.studioId,
      agent: 'trend-scout',
      ref: { type: 'studio', id: q.studioId },
      actor: actor.id,
      input: q.input,
      maxItems,
      estimateUsd: est,
      operation: `radar.${q.kind}`,
    });
    await log('ok', r.items.length, r.costUsd, null);
    return r.items;
  } catch (err) {
    const capped = err instanceof ApifyWeeklyCapError || err instanceof BudgetExceededError;
    await log(capped ? 'capped' : 'failed', 0, 0, (err as Error).message.slice(0, 300)).catch(() => undefined);
    throw err;
  }
}
