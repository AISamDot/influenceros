import type { StudioServices } from '@ios/agents';
import { addMessage, BudgetExceededError, findThread, notify } from '@ios/core';
import { json } from '@ios/db';
import { rankActions } from './actions';
import { monthToDateProfit } from './card';
import { latestForecast } from './forecast';
import type { KillCandidate } from './kill';
import { listLeverActions } from './levers';
import { aggregate, isSyntheticRow, loadFacts, totals } from './pnl';
import type { LeverAction, PnlRow, PnlTotals, ProfitAction } from './types';
import { addDays, isoDate, mondayOf, sum } from './util';

/**
 * The Weekly Profit Report (PRD §3.11.6, FR-24.5), posted into the Studio chat as the Profit Engine
 * (`agent:profit-engine`, meta.kind 'profit_report'). The numbers are computed; the opening paragraph is written by
 * the profit-engine agent through the runtime (a deterministic summary in fake mode or when the budget refuses).
 * One report per studio per week.
 */

export interface ReportData {
  weekStart: string;
  lastWeek: { from: string; to: string; totals: PnlTotals; personas: PnlRow[] };
  previousWeek: PnlTotals;
  monthToDateCents: number;
  forecast: { p10: number; median: number; p90: number; negativeWeeks: number } | null;
  levers: LeverAction[];
  measured: LeverAction[];
  kills: KillCandidate[];
  actions: ProfitAction[];
}

const usd = (cents: number) => {
  const v = Math.round(cents / 100);
  return `${v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString('en-US')}`;
};
const signed = (cents: number) => `${cents >= 0 ? '+' : '−'}${usd(Math.abs(cents)).replace('−', '')}`;

export async function reportData(services: StudioServices, studioId: string, now: Date, kills: KillCandidate[] = []): Promise<ReportData> {
  const { db } = services;
  const monday = mondayOf(now);
  const lastFrom = addDays(monday, -7);
  const [last, prev, mtd, forecast, levers, measured, actions] = await Promise.all([
    loadFacts(db, { studioId, from: lastFrom, to: monday }),
    loadFacts(db, { studioId, from: addDays(monday, -14), to: lastFrom }),
    monthToDateProfit(db, studioId, now),
    latestForecast(db, studioId, null),
    listLeverActions(db, studioId, { since: addDays(now, -7), limit: 20 }),
    db.query<{ id: string }>(`SELECT id FROM profit_lever_action WHERE studio_id = $1 AND measured_at >= $2`, [studioId, addDays(now, -7)]),
    rankActions(db, studioId, now, { limit: 3 }),
  ]);
  const lastRows = aggregate(last, 'persona');
  const measuredRows = measured.length ? (await listLeverActions(db, studioId, { limit: 100 })).filter((l) => measured.some((m) => m.id === l.id)) : [];
  return {
    weekStart: isoDate(monday),
    lastWeek: { from: isoDate(lastFrom), to: isoDate(addDays(monday, -1)), totals: totals(lastRows), personas: lastRows.filter((r) => !isSyntheticRow(r)) },
    previousWeek: totals(aggregate(prev, 'persona')),
    monthToDateCents: mtd,
    forecast: forecast ? { ...forecast.totalCents, negativeWeeks: forecast.negativeWeeks } : null,
    levers: levers.filter((l) => l.status !== 'measured' || l.createdAt >= addDays(now, -7)),
    measured: measuredRows,
    kills: kills.filter((k) => k.approvalId),
    actions,
  };
}

/** Deterministic opening paragraph (fake mode, and the fallback when the runtime refuses). */
export function headline(d: ReportData): string {
  const t = d.lastWeek.totals;
  const delta = t.profitCents - d.previousWeek.profitCents;
  const best = [...d.lastWeek.personas].sort((a, b) => b.profitCents - a.profitCents)[0];
  const parts = [
    `Last week the studio made ${usd(t.profitCents)} profit on ${usd(t.revenueCents)} in sales (${signed(delta)} vs the week before).`,
    best && best.profitCents > 0 ? `${best.label} led with ${usd(best.profitCents)}.` : 'No persona was profitable yet.',
    d.forecast ? `The 90-day forecast is ${usd(d.forecast.median)} (P10 ${usd(d.forecast.p10)}, P90 ${usd(d.forecast.p90)}).` : '',
    d.levers.length ? `I pulled ${d.levers.length} lever${d.levers.length === 1 ? '' : 's'} this week, expected ${signed(sum(d.levers.map((l) => l.expectedImpactCents)))} a month.` : 'No levers needed pulling this week.',
  ];
  return parts.filter(Boolean).join(' ');
}

/** The report body below the opening paragraph: plain text, no tables (the chat renders text). */
export function reportBody(d: ReportData): string {
  const t = d.lastWeek.totals;
  const lines: string[] = [];
  lines.push(`Week of ${d.lastWeek.from} to ${d.lastWeek.to}`);
  lines.push(
    `Sales ${usd(t.revenueCents)} · fees and refunds ${usd(t.feesCents + t.refundsCents)} · costs ${usd(t.costCents)} · profit ${usd(t.profitCents)} · ${t.posts} posts · ${t.views.toLocaleString('en-US')} views`,
  );
  lines.push(`Month to date: ${usd(d.monthToDateCents)} profit.`);
  if (d.lastWeek.personas.length) {
    const ranked = [...d.lastWeek.personas].sort((a, b) => b.profitCents - a.profitCents);
    lines.push('', 'By persona:');
    for (const r of ranked.slice(0, 8)) {
      lines.push(`- ${r.label}: ${usd(r.profitCents)} profit (${usd(r.revenueCents)} sales, ${usd(r.costCents)} cost, ${r.posts} posts)`);
    }
  }
  if (d.levers.length) {
    lines.push('', 'Levers pulled (automatic, within bounds):');
    for (const l of d.levers) lines.push(`- ${l.rationale} Expected ${signed(l.expectedImpactCents)}/month.`);
  }
  if (d.measured.length) {
    lines.push('', 'Levers measured:');
    for (const l of d.measured) {
      lines.push(`- ${l.lever.replace('_', ' ')}: expected ${signed(l.expectedImpactCents)}/month, measured ${signed(l.measuredImpactCents ?? 0)}/month${l.status === 'reverted' ? ' (reverted)' : ''}.`);
    }
  }
  if (d.kills.length) {
    lines.push('', 'Needs your decision:');
    for (const k of d.kills) lines.push(`- ${k.action === 'kill' ? 'Kill' : 'Retire'} ${k.name}: forecast negative ${k.negativeWeeks} weeks in a row. The card is in Approvals; nothing happens until you decide.`);
  }
  if (d.actions.length) {
    lines.push('', 'To make more profit:');
    for (const a of d.actions) lines.push(`${a.rank}. ${a.title}: ${signed(a.expectedImpactCents)}/month${a.requiresOwner ? ' (your approval)' : ''}.`);
  }
  return lines.join('\n');
}

const REPORT_STYLE = [
  'You are the Profit Engine inside the Studio Manager of an AI influencer studio.',
  'Write the opening paragraph of the Weekly Profit Report for the Owner: 2 to 4 plain English sentences,',
  'numbers first, no greeting, no headings, no markdown tables. Mention profit vs the week before, the best persona,',
  'the forecast and any decision waiting for the Owner. Never invent numbers: use only the JSON you are given.',
].join(' ');

/** Posts this week's report into the Studio chat (once per week). Returns null when it was already posted. */
export async function postWeeklyReport(
  services: StudioServices,
  studioId: string,
  now: Date,
  kills: KillCandidate[] = [],
): Promise<{ messageId: string; body: string; runId: string | null; fake: boolean } | null> {
  const { db } = services;
  const weekStart = isoDate(mondayOf(now));
  if (await db.maybeOne('SELECT 1 FROM profit_report WHERE studio_id = $1 AND week_start = $2', [studioId, weekStart])) return null;
  const data = await reportData(services, studioId, now, kills);
  let opening = headline(data);
  let runId: string | null = null;
  let fake = true;
  try {
    const res = await services.runtime.run<string>({
      agent: 'profit-engine',
      scope: { studioId, personaId: null },
      label: `weekly profit report ${weekStart}`,
      system: 'Write the opening paragraph now.',
      cached: [{ key: 'profit-engine:report-style:v1', text: REPORT_STYLE }],
      prompt: JSON.stringify({
        lastWeek: data.lastWeek.totals,
        previousWeek: data.previousWeek,
        personas: data.lastWeek.personas.map((p) => ({ name: p.label, profitCents: p.profitCents, revenueCents: p.revenueCents, costCents: p.costCents, posts: p.posts })),
        monthToDateCents: data.monthToDateCents,
        forecast: data.forecast,
        levers: data.levers.map((l) => ({ lever: l.lever, rationale: l.rationale, expectedImpactCents: l.expectedImpactCents })),
        decisions: data.kills.map((k) => ({ persona: k.name, action: k.action, negativeWeeks: k.negativeWeeks })),
      }),
      maxTokens: 400,
      fake: () => headline(data),
      costRef: { type: 'studio', id: studioId },
    });
    opening = res.output.trim() || opening;
    runId = res.runId;
    fake = res.mode === 'fake';
  } catch (err) {
    // Over budget: the numbers still go out, with the deterministic opening.
    if (!(err instanceof BudgetExceededError)) throw err;
  }
  const body = `Weekly Profit Report\n\n${opening}\n\n${reportBody(data)}`;
  return db.transaction(async (tx) => {
    const claimed = await tx.maybeOne<{ id: string }>(
      `INSERT INTO profit_report (studio_id, week_start, body, data) VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (studio_id, week_start) DO NOTHING RETURNING id`,
      [studioId, weekStart, body, json({ ...data, runId })],
    );
    if (!claimed) return null;
    const thread = await findThread(tx, studioId, 'studio');
    const msg = await addMessage(tx, {
      threadId: thread.id,
      role: 'agent',
      author: 'agent:profit-engine',
      body,
      meta: { kind: 'profit_report', runId, fake, weekStart },
    });
    await tx.query('UPDATE profit_report SET message_id = $2 WHERE id = $1', [claimed.id, msg.id]);
    await notify(tx, {
      studioId,
      kind: 'digest',
      title: 'Weekly Profit Report',
      body: opening.slice(0, 280),
      link: '/money',
    });
    return { messageId: msg.id, body, runId, fake };
  });
}
