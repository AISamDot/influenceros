import type { Caller, ToolContext, ToolDef } from '@troupe/agents';
import { budgetStatus } from '@troupe/core';
import { rankActions } from './actions';
import { profitCard } from './card';
import { runWeeklyCycle } from './cycle';
import { forecastStudio, latestForecast, storeForecasts } from './forecast';
import { listLeverActions, runLevers } from './levers';
import { pnlWithTotals } from './pnl';
import { postWeeklyReport } from './report';
import type { PnlGrain } from './types';
import { addDays, isoDate, mondayOf, startOfMonth } from './util';

/**
 * Profit Engine tools (namespaces `profit.*`, `forecast.*`, `budget.*`). Read tools are open to the Studio Manager,
 * the Profit Engine, the Owner and the system; a Persona Manager may read its own persona only. Tools that act are
 * limited to studio-level callers, and none of them can raise a cap, kill a persona or touch disclosure: those are
 * proposals for the Owner (docs/IOS-2-CONTRACTS.md §5.2).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GRAINS: readonly PnlGrain[] = ['post', 'persona', 'format', 'product', 'platform'];
const PERIODS = ['mtd', 'last_week', 'last_7_days', 'last_30_days', 'last_90_days'] as const;
type Period = (typeof PERIODS)[number];

const READERS: readonly Caller[] = ['studio-manager', 'profit-engine', 'persona-manager', 'monetization-agent', 'owner', 'system'];
const ACTORS: readonly Caller[] = ['studio-manager', 'profit-engine', 'owner', 'system'];

function obj(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('input must be an object');
  return raw as Record<string, unknown>;
}
function only(o: Record<string, unknown>, keys: readonly string[]) {
  const extra = Object.keys(o).filter((k) => !keys.includes(k));
  if (extra.length) throw new Error(`unknown input keys: ${extra.join(', ')}`);
}
function optPersona(o: Record<string, unknown>): string | undefined {
  if (o.persona_id === undefined || o.persona_id === null) return undefined;
  if (typeof o.persona_id !== 'string' || !UUID_RE.test(o.persona_id)) throw new Error('persona_id must be a uuid');
  return o.persona_id;
}
function optLimit(o: Record<string, unknown>, max: number): number | undefined {
  if (o.limit === undefined) return undefined;
  const n = Number(o.limit);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`limit must be an integer from 1 to ${max}`);
  return n;
}
function optDate(o: Record<string, unknown>, key: string): Date | undefined {
  if (o[key] === undefined) return undefined;
  const d = new Date(String(o[key]));
  if (Number.isNaN(d.getTime())) throw new Error(`${key} must be an ISO date`);
  return d;
}

/** A Persona Manager only ever sees its own persona; studio-level callers choose. */
async function scopedPersona(ctx: ToolContext, requested: string | undefined): Promise<string | null> {
  if (ctx.personaId) {
    if (requested && requested !== ctx.personaId) throw new Error(`${ctx.caller} may only read its own persona`);
    return ctx.personaId;
  }
  if (requested) {
    const ok = await ctx.services.db.maybeOne('SELECT 1 FROM persona WHERE id = $1 AND studio_id = $2', [requested, ctx.studioId]);
    if (!ok) throw new Error(`persona ${requested} is not in this studio`);
  }
  return requested ?? null;
}

export function periodRange(period: Period, now: Date): { from: Date; to: Date } {
  switch (period) {
    case 'mtd':
      return { from: startOfMonth(now), to: now };
    case 'last_week': {
      const m = mondayOf(now);
      return { from: addDays(m, -7), to: m };
    }
    case 'last_7_days':
      return { from: addDays(now, -7), to: now };
    case 'last_30_days':
      return { from: addDays(now, -30), to: now };
    case 'last_90_days':
      return { from: addDays(now, -90), to: now };
  }
}

const personaProp = { persona_id: { type: 'string', description: 'Persona id (uuid). Omit for the whole studio.' } };

const pnlTool: ToolDef<{ grain: PnlGrain; period?: Period; from?: Date; to?: Date; persona_id?: string }> = {
  name: 'profit.pnl',
  description:
    'Profit and loss from the ledger by post, persona, format, product or platform: sales, fees, refunds, cost (LLM, media, Higgsfield credits), profit, revenue and cost per post, revenue per 1,000 views. Amounts in cents.',
  scope: 'studio',
  callers: READERS,
  inputSchema: {
    type: 'object',
    properties: {
      grain: { type: 'string', enum: GRAINS },
      period: { type: 'string', enum: PERIODS, description: 'Default mtd (month to date).' },
      from: { type: 'string', description: 'ISO start (inclusive); overrides period.' },
      to: { type: 'string', description: 'ISO end (exclusive).' },
      ...personaProp,
    },
    required: ['grain'],
    additionalProperties: false,
  },
  parse(raw) {
    const o = obj(raw);
    only(o, ['grain', 'period', 'from', 'to', 'persona_id']);
    if (!GRAINS.includes(o.grain as PnlGrain)) throw new Error(`grain must be one of ${GRAINS.join(', ')}`);
    if (o.period !== undefined && !PERIODS.includes(o.period as Period)) throw new Error(`period must be one of ${PERIODS.join(', ')}`);
    return { grain: o.grain as PnlGrain, period: o.period as Period | undefined, from: optDate(o, 'from'), to: optDate(o, 'to'), persona_id: optPersona(o) };
  },
  async run(ctx, i) {
    const now = ctx.services.now();
    const range = i.from ? { from: i.from, to: i.to ?? now } : periodRange(i.period ?? 'mtd', now);
    const personaId = await scopedPersona(ctx, i.persona_id);
    const { rows, totals } = await pnlWithTotals(ctx.services.db, { studioId: ctx.studioId, ...range, grain: i.grain, personaId: personaId ?? undefined });
    return { from: range.from.toISOString(), to: range.to.toISOString(), grain: i.grain, rows, totals };
  },
};

const moreProfitTool: ToolDef<{ limit?: number; persona_id?: string }> = {
  name: 'profit.more_profit',
  description:
    '"How do we make more profit?" Ranked actions with their expected monthly dollar impact: automatic levers (cadence, format mix, credits, model routing) and decisions that need the Owner (kills, cap raises). Use it whenever the Owner asks how to make more money.',
  scope: 'studio',
  callers: READERS,
  inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 20 }, ...personaProp }, additionalProperties: false },
  parse(raw) {
    const o = obj(raw);
    only(o, ['limit', 'persona_id']);
    return { limit: optLimit(o, 20), persona_id: optPersona(o) };
  },
  async run(ctx, i) {
    const personaId = await scopedPersona(ctx, i.persona_id);
    const now = ctx.services.now();
    const actions = await rankActions(ctx.services.db, ctx.studioId, now, { limit: i.limit ?? 10, personaId });
    return { generated_at: now.toISOString(), actions };
  },
};

const leverLogTool: ToolDef<{ limit?: number; persona_id?: string }> = {
  name: 'profit.lever_log',
  description: 'The Profit Engine lever log: every automatic change with its before/after, rationale, expected and measured monthly impact (cents).',
  scope: 'studio',
  callers: READERS,
  inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100 }, ...personaProp }, additionalProperties: false },
  parse(raw) {
    const o = obj(raw);
    only(o, ['limit', 'persona_id']);
    return { limit: optLimit(o, 100), persona_id: optPersona(o) };
  },
  async run(ctx, i) {
    const personaId = await scopedPersona(ctx, i.persona_id);
    return listLeverActions(ctx.services.db, ctx.studioId, { personaId, limit: i.limit ?? 20 });
  },
};

const cardTool: ToolDef<Record<string, never>> = {
  name: 'profit.card',
  description: "This month's profit vs forecast, the top three levers pulled and the top three opportunities (the Studio wall's Profit card).",
  scope: 'studio',
  callers: ['studio-manager', 'profit-engine', 'owner', 'system'],
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  parse(raw) {
    only(obj(raw), []);
    return {};
  },
  run: (ctx) => profitCard(ctx.services.db, ctx.studioId, ctx.services.now()),
};

const runLeversTool: ToolDef<Record<string, never>> = {
  name: 'profit.run_levers',
  description: 'Pulls every lever that is due now, within its bounds (cadence 7–21 a week, format mix, weekly credit split, model tier), and logs each one. Never raises caps or autonomy.',
  scope: 'studio',
  callers: ACTORS,
  mutates: true,
  ownerIntent: /\b(?:pull|run|apply)\b.*\blevers?\b/i,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  parse(raw) {
    only(obj(raw), []);
    return {};
  },
  run: (ctx) => runLevers(ctx.services.db, ctx.studioId, ctx.services.now()),
};

const weeklyCycleTool: ToolDef<Record<string, never>> = {
  name: 'profit.weekly_cycle',
  description: "Runs the Profit Engine's weekly cycle now: measure levers, refresh the forecast, pull levers, propose kill candidates (Owner approves), post the Weekly Profit Report.",
  scope: 'studio',
  callers: ACTORS,
  mutates: true,
  ownerIntent: /\b(?:run|start|kick\s+off|trigger)\b.*\b(?:profit|weekly)\s+(?:cycle|engine)\b/i,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  parse(raw) {
    only(obj(raw), []);
    return {};
  },
  run: (ctx) => runWeeklyCycle(ctx.services, ctx.studioId, ctx.services.now()),
};

const reportTool: ToolDef<Record<string, never>> = {
  name: 'profit.weekly_report',
  description: "Posts this week's Weekly Profit Report into the Studio chat if it hasn't been posted yet.",
  scope: 'studio',
  callers: ACTORS,
  mutates: true,
  ownerIntent: /\b(?:post|send|write|publish|share|make|generate)\b.*\breport\b/i,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  parse(raw) {
    only(obj(raw), []);
    return {};
  },
  async run(ctx) {
    const r = await postWeeklyReport(ctx.services, ctx.studioId, ctx.services.now());
    return r ? { posted: true, message_id: r.messageId } : { posted: false, reason: 'already posted this week' };
  },
};

const forecastGetTool: ToolDef<{ persona_id?: string }> = {
  name: 'forecast.get',
  description: '90-day Monte Carlo profit forecast (P10 / median / P90, weekly and total, cents) for the studio or one persona, plus how many weeks ahead are forecast to lose money.',
  scope: 'studio',
  callers: READERS,
  inputSchema: { type: 'object', properties: { ...personaProp }, additionalProperties: false },
  parse(raw) {
    const o = obj(raw);
    only(o, ['persona_id']);
    return { persona_id: optPersona(o) };
  },
  async run(ctx, i) {
    const personaId = await scopedPersona(ctx, i.persona_id);
    const now = ctx.services.now();
    const stored = await latestForecast(ctx.services.db, ctx.studioId, personaId);
    if (stored && isoDate(mondayOf(stored.generatedAt)) === isoDate(mondayOf(now))) return stored;
    const f = await forecastStudio(ctx.services.db, { studioId: ctx.studioId, now, personaId });
    return personaId ? (f.personas[0] ?? null) : f.studio;
  },
};

const forecastRunTool: ToolDef<Record<string, never>> = {
  name: 'forecast.run',
  description: 'Recomputes and stores this week\'s 90-day forecast for the studio and every active persona.',
  scope: 'studio',
  callers: ACTORS,
  mutates: true,
  ownerIntent: /\b(?:run|re-?run|refresh|recompute|update|redo)\b.*\bforecasts?\b/i,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  parse(raw) {
    only(obj(raw), []);
    return {};
  },
  async run(ctx) {
    const now = ctx.services.now();
    const f = await forecastStudio(ctx.services.db, { studioId: ctx.studioId, now });
    await storeForecasts(ctx.services.db, ctx.studioId, f, now);
    return { studio: f.studio, personas: f.personas };
  },
};

const budgetStatusTool: ToolDef<{ persona_id?: string }> = {
  name: 'budget.status',
  description: "Monthly LLM and Higgsfield-credit usage against caps (studio and persona), plus this and next week's credit allocation. Read only: raising a cap is the Owner's decision.",
  scope: 'studio',
  callers: READERS,
  inputSchema: { type: 'object', properties: { ...personaProp }, additionalProperties: false },
  parse(raw) {
    const o = obj(raw);
    only(o, ['persona_id']);
    return { persona_id: optPersona(o) };
  },
  async run(ctx, i) {
    const { db } = ctx.services;
    const personaId = await scopedPersona(ctx, i.persona_id);
    const now = ctx.services.now();
    const [llm, credits, allocation] = await Promise.all([
      budgetStatus(db, { studioId: ctx.studioId, personaId, unit: 'llm_usd', now }),
      budgetStatus(db, { studioId: ctx.studioId, personaId, unit: 'hf_credits', now }),
      db.query<{ persona_id: string | null; week_start: string; credits: number; llm_usd: number; clips: number; source: string }>(
        `SELECT persona_id, to_char(week_start, 'YYYY-MM-DD') AS week_start, credits, llm_usd, clips, source FROM budget_allocation
          WHERE studio_id = $1 AND week_start >= $2 AND ($3::uuid IS NULL OR persona_id = $3) ORDER BY week_start, persona_id NULLS LAST`,
        [ctx.studioId, isoDate(mondayOf(now)), personaId],
      ),
    ]);
    return { llm, credits, allocation };
  },
};

export const profitTools: ReadonlyArray<ToolDef<any, any>> = [
  pnlTool,
  moreProfitTool,
  leverLogTool,
  cardTool,
  runLeversTool,
  weeklyCycleTool,
  reportTool,
  forecastGetTool,
  forecastRunTool,
  budgetStatusTool,
];
