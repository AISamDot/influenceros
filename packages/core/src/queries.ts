import type { Db } from '@ios/db';
import { budgetStatus, type BudgetStatus } from './governor';
import type { PersonaRow, PostFormat, PostPurpose } from './types';

/** Read models for the dashboard. */

export interface DaySeries {
  days: string[]; // YYYY-MM-DD, oldest first
  views: number[];
  followers: number[];
  revenueCents: number[];
}

export interface SlotView {
  id: string;
  slot_at: Date;
  format: PostFormat;
  purpose: PostPurpose;
  pillar: string | null;
  title: string;
  status: string;
  thumbnail_url: string | null;
}

export interface PersonaCard {
  persona: PersonaRow;
  accounts: Array<{ platform: string; handle: string; status: string }>;
  series: DaySeries;
  next: SlotView[];
  killProposed: boolean;
  totals: { views7d: number; followers: number; revenue7dCents: number };
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

export function lastNDays(now: Date, n: number): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(dayKey(new Date(now.getTime() - i * 86_400_000)));
  return out;
}

async function seriesFor(db: Db, personaIds: string[], now: Date, n = 7): Promise<Map<string, DaySeries>> {
  const days = lastNDays(now, n);
  const from = days[0]!;
  const metrics = await db.query<{ persona_id: string; day: string; views: number; followers: number }>(
    `SELECT persona_id, to_char(captured_on, 'YYYY-MM-DD') AS day, SUM(views)::int AS views, SUM(COALESCE(followers,0))::int AS followers
       FROM metric_snapshot WHERE post_id IS NULL AND persona_id = ANY($1::uuid[]) AND captured_on >= $2::date
      GROUP BY persona_id, captured_on`,
    [personaIds, from],
  );
  const revenue = await db.query<{ persona_id: string; day: string; cents: number }>(
    `SELECT persona_id, to_char(ordered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, SUM(amount_cents)::int AS cents
       FROM orders WHERE persona_id = ANY($1::uuid[]) AND ordered_at >= $2::date AND status <> 'refunded'
      GROUP BY 1, 2`,
    [personaIds, from],
  );
  const out = new Map<string, DaySeries>();
  for (const id of personaIds) {
    out.set(id, { days, views: days.map(() => 0), followers: days.map(() => 0), revenueCents: days.map(() => 0) });
  }
  for (const m of metrics) {
    const s = out.get(m.persona_id);
    const i = days.indexOf(m.day);
    if (s && i >= 0) {
      s.views[i] = m.views;
      s.followers[i] = m.followers;
    }
  }
  for (const r of revenue) {
    const s = out.get(r.persona_id);
    const i = days.indexOf(r.day);
    if (s && i >= 0) s.revenueCents[i] = r.cents;
  }
  // Followers is a level, not a flow: carry the last known value forward over gaps.
  for (const s of out.values()) for (let i = 1; i < s.followers.length; i++) if (!s.followers[i]) s.followers[i] = s.followers[i - 1]!;
  return out;
}

export async function studioWall(db: Db, studioId: string, now = new Date()): Promise<PersonaCard[]> {
  const personas = await db.query<PersonaRow>(
    `SELECT * FROM persona WHERE studio_id = $1
      ORDER BY CASE state WHEN 'SCALING' THEN 0 WHEN 'BRAND' THEN 0 WHEN 'MONETISING' THEN 1 WHEN 'TESTING' THEN 2
                          WHEN 'RE_ANGLE' THEN 2 WHEN 'SETUP' THEN 3 WHEN 'PROPOSED' THEN 4 ELSE 5 END, name`,
    [studioId],
  );
  const ids = personas.map((p) => p.id);
  if (!ids.length) return [];
  const [series, accounts, slots, kills] = await Promise.all([
    seriesFor(db, ids, now),
    db.query<{ persona_id: string; platform: string; handle: string; status: string }>(
      `SELECT persona_id, platform, handle, status FROM account WHERE persona_id = ANY($1::uuid[]) ORDER BY platform`,
      [ids],
    ),
    db.query<SlotView & { persona_id: string; rn: number }>(
      `SELECT * FROM (
         SELECT s.*, row_number() OVER (PARTITION BY persona_id ORDER BY slot_at) AS rn
           FROM calendar_slot s WHERE persona_id = ANY($1::uuid[]) AND slot_at >= $2 AND status <> 'skipped'
       ) x WHERE rn <= 3 ORDER BY slot_at`,
      [ids, now],
    ),
    db.query<{ persona_id: string }>(
      `SELECT DISTINCT persona_id FROM approval WHERE persona_id = ANY($1::uuid[]) AND status = 'pending' AND kind IN ('persona_kill','persona_retire')`,
      [ids],
    ),
  ]);
  const killSet = new Set(kills.map((k) => k.persona_id));
  return personas.map((persona) => {
    const s = series.get(persona.id)!;
    return {
      persona,
      accounts: accounts.filter((a) => a.persona_id === persona.id),
      series: s,
      next: slots.filter((x) => x.persona_id === persona.id),
      killProposed: killSet.has(persona.id),
      totals: {
        views7d: s.views.reduce((a, b) => a + b, 0),
        followers: s.followers.at(-1) ?? 0,
        revenue7dCents: s.revenueCents.reduce((a, b) => a + b, 0),
      },
    };
  });
}

export async function studioTotals(db: Db, studioId: string): Promise<{ active: number; pending: number; kills: number; unread: number }> {
  return db.one(
    `SELECT (SELECT count(*) FROM persona WHERE studio_id = $1 AND state NOT IN ('KILLED','RETIRED'))::int AS active,
            (SELECT count(*) FROM approval WHERE studio_id = $1 AND status = 'pending')::int AS pending,
            (SELECT count(*) FROM approval WHERE studio_id = $1 AND status = 'pending' AND kind IN ('persona_kill','persona_retire'))::int AS kills,
            (SELECT count(*) FROM notification WHERE studio_id = $1 AND read_at IS NULL)::int AS unread`,
    [studioId],
  );
}

/** Monday 00:00 UTC of the week containing `now`. */
export function weekStart(now: Date): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d;
}

export interface PersonaPage {
  card: PersonaCard;
  bible: { version: number; status: string; content: Record<string, unknown>; approved_at: Date | null } | null;
  week: { start: Date; days: Array<{ date: string; slots: SlotView[] }> };
  posts: Array<{ id: string; platform: string; format: PostFormat; caption: string | null; thumbnail_url: string | null; published_at: Date | null; url: string | null; status: string; views: number; likes: number; saves: number; shares: number }>;
  products: Array<{ id: string; name: string; ladder_rung: string; status: string; price_cents: number; cover_url: string | null; orders: number; revenue_cents: number }>;
  plan: { content: Record<string, unknown>; period_start: string | null; period_end: string | null } | null;
  community: { subscribers: number; members: number; comments7d: number; openEscalations: number };
  budget: { llm: BudgetStatus; credits: BudgetStatus };
}

export async function personaPage(db: Db, slug: string, now = new Date()): Promise<PersonaPage | null> {
  const persona = await db.maybeOne<PersonaRow>('SELECT * FROM persona WHERE slug = $1', [slug]);
  if (!persona) return null;
  const card = (await studioWall(db, persona.studio_id, now)).find((c) => c.persona.id === persona.id)!;
  const start = weekStart(now);
  const end = new Date(start.getTime() + 7 * 86_400_000);
  const [bible, slots, posts, products, plan, community, llm, credits] = await Promise.all([
    db.maybeOne<PersonaPage['bible']>(
      `SELECT version, status, content, approved_at FROM persona_bible WHERE persona_id = $1 ORDER BY version DESC LIMIT 1`,
      [persona.id],
    ),
    db.query<SlotView>(`SELECT * FROM calendar_slot WHERE persona_id = $1 AND slot_at >= $2 AND slot_at < $3 ORDER BY slot_at`, [persona.id, start, end]),
    db.query<PersonaPage['posts'][number]>(
      `SELECT p.id, p.platform, p.format, p.caption, p.thumbnail_url, p.published_at, p.url, p.status,
              COALESCE(m.views,0)::int AS views, COALESCE(m.likes,0)::int AS likes, COALESCE(m.saves,0)::int AS saves, COALESCE(m.shares,0)::int AS shares
         FROM post p
         LEFT JOIN LATERAL (SELECT views, likes, saves, shares FROM metric_snapshot ms WHERE ms.post_id = p.id ORDER BY captured_on DESC LIMIT 1) m ON true
        WHERE p.persona_id = $1 AND p.status IN ('live','failed')
        ORDER BY p.published_at DESC NULLS LAST LIMIT 12`,
      [persona.id],
    ),
    db.query<PersonaPage['products'][number]>(
      `SELECT pr.id, pr.name, pr.ladder_rung, pr.status, pr.price_cents, pr.cover_url,
              COUNT(o.id)::int AS orders, COALESCE(SUM(o.amount_cents),0)::int AS revenue_cents
         FROM product pr LEFT JOIN orders o ON o.product_id = pr.id
        WHERE pr.persona_id = $1 GROUP BY pr.id ORDER BY pr.price_cents`,
      [persona.id],
    ),
    db.maybeOne<NonNullable<PersonaPage['plan']>>(
      `SELECT content, to_char(period_start,'YYYY-MM-DD') AS period_start, to_char(period_end,'YYYY-MM-DD') AS period_end
         FROM plan WHERE persona_id = $1 AND kind = 'timeline' ORDER BY version DESC LIMIT 1`,
      [persona.id],
    ),
    db.one<PersonaPage['community']>(
      `SELECT (SELECT count(*) FROM subscriber WHERE persona_id = $1 AND status = 'active')::int AS subscribers,
              (SELECT count(*) FROM membership WHERE persona_id = $1 AND status = 'active')::int AS members,
              (SELECT count(*) FROM comment WHERE persona_id = $1 AND created_at > now() - interval '7 days')::int AS "comments7d",
              (SELECT count(*) FROM escalation WHERE persona_id = $1 AND status <> 'resolved')::int AS "openEscalations"`,
      [persona.id],
    ),
    budgetStatus(db, { studioId: persona.studio_id, personaId: persona.id, unit: 'llm_usd', now }),
    budgetStatus(db, { studioId: persona.studio_id, personaId: persona.id, unit: 'hf_credits', now }),
  ]);
  const days = Array.from({ length: 7 }, (_, i) => {
    const date = dayKey(new Date(start.getTime() + i * 86_400_000));
    return { date, slots: slots.filter((s) => dayKey(new Date(s.slot_at)) === date) };
  });
  return { card, bible, week: { start, days }, posts, products, plan, community, budget: { llm, credits } };
}

export interface LedgerRow {
  persona_id: string | null;
  name: string | null;
  unit: string;
  debits: number;
  grants: number;
}

export async function ledgerSummary(db: Db, studioId: string, period: string): Promise<LedgerRow[]> {
  return db.query<LedgerRow>(
    `SELECT l.persona_id, p.name, l.unit,
            SUM(l.amount) FILTER (WHERE entry_type = 'debit') AS debits,
            SUM(l.amount) FILTER (WHERE entry_type = 'grant') AS grants
       FROM credit_ledger l LEFT JOIN persona p ON p.id = l.persona_id
      WHERE l.studio_id = $1 AND l.period = $2
      GROUP BY l.persona_id, p.name, l.unit ORDER BY p.name NULLS FIRST, l.unit`,
    [studioId, period],
  );
}
