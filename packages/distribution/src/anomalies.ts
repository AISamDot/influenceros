import type { StudioServices } from '@ios/agents';
import { audit, notify, PUBLISHING_STATES, setKillSwitch, updatePersonaControls } from '@ios/core';
import { json } from '@ios/db';
import type { Platform } from '@ios/providers';
import { DAY_MS, HOUR_MS, SYSTEM_PUBLISHER } from './util';

/**
 * Anomaly alerts and circuit breakers (FR-13.4, FR-17.2).
 * - A takedown (a live post the platform removed or rejected), a strike or a report spike trips the persona's circuit
 *   breaker: its kill switch is set and its autonomy drops to L0 (both are allowed for the system: only raising them,
 *   or clearing a switch, is the Owner's call), and the Owner gets an S1 alert.
 * - Views collapsing (possible shadow-ban), a refund spike and a cost spike raise warnings once a day per persona.
 */

export const ANOMALY = {
  /** Latest posts compared with the persona's median 24 h views. */
  recentPosts: 3,
  baselinePosts: 10,
  /** Each of the latest posts below this share of the median = collapse. */
  collapseShare: 0.2,
  /** The median must be at least this many views to judge a collapse. */
  minMedianViews: 200,
  refundRate: 0.2,
  minOrders: 5,
  /** Today's spend over this multiple of the trailing 7-day daily average (and at least minSpendUsd). */
  costMultiple: 3,
  minSpendUsd: 5,
} as const;

/** Trips the circuit breaker for one persona: kill switch + autonomy L0 + an S1 alert. Idempotent per reason. */
export async function tripCircuitBreaker(services: StudioServices, b: { personaId: string; platform?: Platform | null; kind: 'takedown' | 'strike' | 'report_spike'; detail: string }): Promise<void> {
  const { db } = services;
  const p = await db.one<{ studio_id: string; name: string; autonomy: string }>('SELECT studio_id, name, autonomy FROM persona WHERE id = $1', [b.personaId]);
  const reason = `${b.kind.replace('_', ' ')}${b.platform ? ` on ${b.platform}` : ''}: ${b.detail}`.slice(0, 400);
  await setKillSwitch(db, p.studio_id, { scope: 'persona', personaId: b.personaId }, SYSTEM_PUBLISHER, `Circuit breaker: ${reason}`);
  if (p.autonomy !== 'L0') await updatePersonaControls(db, b.personaId, { autonomy: 'L0' }, SYSTEM_PUBLISHER);
  await notify(db, {
    studioId: p.studio_id,
    personaId: b.personaId,
    kind: 'system',
    severity: 'critical',
    title: `S1 · ${p.name}: posting paused (${b.kind.replace('_', ' ')})`.slice(0, 160),
    body: `${reason}. The persona's kill switch is on and autonomy is L0; only you can resume it (Settings).`,
    link: '/settings',
  });
  await audit(db, { studioId: p.studio_id, personaId: b.personaId, actor: SYSTEM_PUBLISHER, action: 'circuit_breaker.tripped', entityType: 'persona', entityId: b.personaId, data: { kind: b.kind, platform: b.platform ?? null, detail: b.detail } });
}

/**
 * A live post the platform took down (Zernio post.failed / rejected / removed after it went live): mark it and trip the
 * breaker. Returns true when it was a takedown.
 */
export async function recordTakedown(services: StudioServices, externalId: string, detail = 'the platform removed or rejected a live post'): Promise<boolean> {
  const post = await services.db.maybeOne<{ id: string; persona_id: string; platform: Platform }>(`SELECT id, persona_id, platform FROM post WHERE external_id = $1 AND status = 'live'`, [externalId]);
  if (!post) return false;
  await services.db.query(`UPDATE post SET status = 'failed', meta = meta || $2::jsonb, updated_at = now() WHERE id = $1`, [post.id, json({ taken_down_at: services.now().toISOString(), takedown: detail })]);
  await tripCircuitBreaker(services, { personaId: post.persona_id, platform: post.platform, kind: 'takedown', detail });
  return true;
}

async function alertOnce(services: StudioServices, a: { studioId: string; personaId: string; key: string; title: string; body: string }): Promise<boolean> {
  // Notifications are stamped by the database clock, so the day is measured on it too.
  const seen = await services.db.maybeOne(`SELECT 1 FROM notification WHERE persona_id = $1 AND kind = 'system' AND title = $2 AND created_at > now() - interval '24 hours' LIMIT 1`, [a.personaId, a.title]);
  if (seen) return false;
  await notify(services.db, { studioId: a.studioId, personaId: a.personaId, kind: 'system', severity: 'warn', title: a.title, body: a.body, link: '/profit' });
  return true;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export interface AnomalyFinding {
  personaId: string;
  kind: 'views_collapse' | 'refund_spike' | 'cost_spike';
  detail: string;
}

/** analytics.anomalies: views collapse, refund spike, cost spike per publishing persona (warnings, once a day). */
export async function detectAnomalies(services: StudioServices, now: Date = services.now()): Promise<AnomalyFinding[]> {
  const { db } = services;
  const personas = await db.query<{ id: string; name: string; studio_id: string }>(`SELECT id, name, studio_id FROM persona WHERE state = ANY($1::text[])`, [PUBLISHING_STATES]);
  const out: AnomalyFinding[] = [];
  for (const p of personas) {
    // Views collapse / possible shadow-ban: each of the latest posts far below the persona's median at 24 h.
    const rows = await db.query<{ views: number }>(
      `SELECT m.views FROM metric_snapshot m JOIN post po ON po.id = m.post_id
        WHERE po.persona_id = $1 AND m."window" = '24h' ORDER BY po.published_at DESC NULLS LAST LIMIT $2`,
      [p.id, ANOMALY.recentPosts + ANOMALY.baselinePosts],
    );
    if (rows.length >= ANOMALY.recentPosts + 3) {
      const recent = rows.slice(0, ANOMALY.recentPosts).map((r) => Number(r.views));
      const base = median(rows.slice(ANOMALY.recentPosts).map((r) => Number(r.views)));
      if (base >= ANOMALY.minMedianViews && recent.every((v) => v < base * ANOMALY.collapseShare)) {
        const detail = `the last ${recent.length} posts got ${recent.join(', ')} views at 24 h against a median of ${Math.round(base)}`;
        out.push({ personaId: p.id, kind: 'views_collapse', detail });
        await alertOnce(services, { studioId: p.studio_id, personaId: p.id, key: 'views', title: `${p.name}: views collapsed (possible shadow-ban)`, body: `${detail}. Check the accounts for warnings before the next post.` });
      }
    }
    // Refund spike (7 days).
    const r = await db.one<{ orders: number; refunds: number }>(
      `SELECT (SELECT count(*)::int FROM orders WHERE persona_id = $1 AND ordered_at > $2) AS orders,
              (SELECT count(*)::int FROM refund WHERE persona_id = $1 AND created_at > $2 AND status IN ('approved','refunded')) AS refunds`,
      [p.id, new Date(now.getTime() - 7 * DAY_MS)],
    );
    if (r.orders >= ANOMALY.minOrders && r.refunds / r.orders >= ANOMALY.refundRate) {
      const detail = `${r.refunds} refunds on ${r.orders} orders in 7 days`;
      out.push({ personaId: p.id, kind: 'refund_spike', detail });
      await alertOnce(services, { studioId: p.studio_id, personaId: p.id, key: 'refunds', title: `${p.name}: refund spike`, body: `${detail}. Check the product and the posts that sold it.` });
    }
    // Cost spike: USD spend in the last 24 h against the trailing 7-day daily average.
    const c = await db.one<{ today: string; week: string }>(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE created_at > $2), 0) AS today,
              COALESCE(SUM(amount) FILTER (WHERE created_at <= $2 AND created_at > $3), 0) AS week
         FROM credit_ledger WHERE persona_id = $1 AND entry_type = 'debit' AND unit IN ('llm_usd','media_usd')`,
      [p.id, new Date(now.getTime() - DAY_MS), new Date(now.getTime() - 8 * DAY_MS)],
    );
    const today = Number(c.today);
    const avg = Number(c.week) / 7;
    if (today >= ANOMALY.minSpendUsd && today > ANOMALY.costMultiple * Math.max(avg, 0.01)) {
      const detail = `$${today.toFixed(2)} in 24 h against a $${avg.toFixed(2)} daily average`;
      out.push({ personaId: p.id, kind: 'cost_spike', detail });
      await alertOnce(services, { studioId: p.studio_id, personaId: p.id, key: 'cost', title: `${p.name}: cost spike`, body: `${detail}. The caps still apply; check what is spending.` });
    }
  }
  return out;
}

export const ANOMALY_SCHEDULE_MS = HOUR_MS;
