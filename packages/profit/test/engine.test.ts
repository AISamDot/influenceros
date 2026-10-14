import { ToolPermissionError } from '@ios/agents';
import { createTestStudio, makeTestPersona, type TestStudio } from '@ios/agents/testing';
import { OWNER, STUDIO_MANAGER } from '@ios/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createCadencePolicy, createRoutingPolicy, postWeeklyReport, profitCard, rankActions, runWeeklyCycle, tools } from '../src';
import { addDebit, addWeeklyHistory, daysAgo, NOW } from './fixtures';

let t: TestStudio | null = null;
afterEach(async () => {
  await t?.db.close();
  t = null;
});

async function studio() {
  const s = await createTestStudio({ tools, cadence: createCadencePolicy, routing: createRoutingPolicy, now: () => NOW });
  const win = await makeTestPersona(s, { name: 'Winner', state: 'MONETISING' });
  const lose = await makeTestPersona(s, { name: 'Loser' });
  await addWeeklyHistory(s.db, s.studioId, win.id, { weeks: 6, gross: 20_000, cost: 1_000, growth: 1.03 });
  await addWeeklyHistory(s.db, s.studioId, lose.id, { weeks: 6, gross: 0, cost: 4_000 });
  await s.db.query('UPDATE persona SET launched_at = $2 WHERE id = $1', [lose.id, daysAgo(60)]); // past the Day-30 checkpoint
  await addDebit(s.db, s.studioId, null, { amount: 3, at: daysAgo(1), refType: 'studio' });
  return { s, win, lose };
}

const ctx = (s: TestStudio, caller: 'studio-manager' | 'persona-manager' | 'owner' | 'system', personaId: string | null = null) => ({
  services: s.services,
  studioId: s.studioId,
  personaId,
  caller,
  actor: caller === 'owner' ? OWNER : caller === 'studio-manager' ? STUDIO_MANAGER : { type: 'agent' as const, id: caller },
});

describe('Weekly Profit Report', () => {
  it('posts once a week into the Studio chat as the profit engine, through the runtime', async () => {
    const r = await studio();
    t = r.s;
    const first = await postWeeklyReport(t.services, t.studioId, NOW);
    expect(first).not.toBeNull();
    expect(first!.fake).toBe(true);
    expect(first!.body).toMatch(/^Weekly Profit Report/);
    expect(first!.body).toContain('Winner');
    const msg = await t.db.one<{ author: string; role: string; meta: Record<string, unknown>; thread_kind: string }>(
      `SELECT m.author, m.role, m.meta, t.kind AS thread_kind FROM chat_message m JOIN chat_thread t ON t.id = m.thread_id WHERE m.id = $1`,
      [first!.messageId],
    );
    expect(msg).toMatchObject({ author: 'agent:profit-engine', role: 'agent', thread_kind: 'studio' });
    expect(msg.meta).toMatchObject({ kind: 'profit_report', fake: true, runId: first!.runId });
    const run = await t.db.one<{ agent: string; outcome: string }>('SELECT agent, outcome FROM agent_run WHERE id = $1', [first!.runId]);
    expect(run).toEqual({ agent: 'profit-engine', outcome: 'ok' });
    // Its LLM cost is attributed to the studio in the ledger.
    expect((await t.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM credit_ledger WHERE ref_type = 'studio' AND ref_id = $1 AND entry_type = 'debit'`, [t.studioId])).n).toBe(1);
    expect(await postWeeklyReport(t.services, t.studioId, NOW)).toBeNull();
    expect((await t.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM chat_message WHERE author = 'agent:profit-engine'`)).n).toBe(1);
  });

  it('still posts the numbers when the budget refuses the agent run', async () => {
    t = await createTestStudio({ settings: { caps: { llm_usd_month: 0, hf_credits_month: 8000 } }, now: () => NOW });
    await makeTestPersona(t, { name: 'Solo' });
    const r = await postWeeklyReport(t.services, t.studioId, NOW);
    expect(r).not.toBeNull();
    expect(r!.runId).toBeNull();
    expect(r!.body).toContain('Last week the studio made');
  });
});

describe('weekly cycle', () => {
  it('measures, forecasts, pulls levers, proposes the kill candidate and posts the report', async () => {
    const { s, lose } = await studio();
    t = s;
    const r = await runWeeklyCycle(t.services, t.studioId, NOW);
    expect(r.levers).toBeGreaterThan(0);
    expect(r.killProposals).toBe(1);
    expect(r.reportMessageId).toEqual(expect.any(String));
    expect((await t.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM profit_forecast`)).n).toBe(3);
    const kill = await t.db.one<{ persona_id: string; kind: string }>(`SELECT persona_id, kind FROM approval WHERE kind = 'persona_kill'`);
    expect(kill.persona_id).toBe(lose.id);
    const body = await t.db.one<{ body: string }>('SELECT body FROM chat_message WHERE id = $1', [r.reportMessageId]);
    expect(body.body).toContain('Needs your decision');
    expect(body.body).toContain('Levers pulled');
    // Re-running the same week is safe: no new levers, no second kill or report.
    const again = await runWeeklyCycle(t.services, t.studioId, NOW);
    expect(again).toMatchObject({ levers: 0, killProposals: 0, reportMessageId: null });
  });
});

describe('"how do we make more profit" and the Profit card', () => {
  it('ranks actions by expected monthly impact, flagging the ones that need the Owner', async () => {
    const { s, lose } = await studio();
    t = s;
    const actions = await rankActions(t.db, t.studioId, NOW);
    expect(actions.length).toBeGreaterThan(1);
    expect(actions.map((a) => a.rank)).toEqual(actions.map((_, i) => i + 1));
    const w = { high: 1, medium: 0.75, low: 0.5 } as const;
    const score = (a: (typeof actions)[number]) => a.expectedImpactCents * w[a.confidence];
    for (let i = 1; i < actions.length; i++) expect(score(actions[i - 1]!)).toBeGreaterThanOrEqual(score(actions[i]!));
    const kill = actions.find((a) => a.kind === 'kill_candidate')!;
    expect(kill).toMatchObject({ personaId: lose.id, requiresOwner: true });
    expect(kill.expectedImpactCents).toBeGreaterThan(0);
    expect(actions.some((a) => a.kind === 'cadence' && !a.requiresOwner)).toBe(true);
  });

  it('is a tool for the Studio Manager; Persona Managers only see their own persona and cannot act', async () => {
    const { s, win, lose } = await studio();
    t = s;
    const out = (await t.services.tools.invoke(ctx(t, 'studio-manager'), 'profit.more_profit', { limit: 3 })) as { actions: unknown[] };
    expect(out.actions.length).toBeLessThanOrEqual(3);
    const pnl = (await t.services.tools.invoke(ctx(t, 'persona-manager', win.id), 'profit.pnl', { grain: 'persona', period: 'last_30_days' })) as { rows: Array<{ key: string }> };
    expect(pnl.rows.map((r) => r.key)).toEqual([win.id]);
    await expect(t.services.tools.invoke(ctx(t, 'persona-manager', win.id), 'profit.pnl', { grain: 'persona', persona_id: lose.id })).rejects.toThrow(/own persona/);
    await expect(t.services.tools.invoke(ctx(t, 'persona-manager', win.id), 'profit.run_levers', {})).rejects.toBeInstanceOf(ToolPermissionError);
    await expect(t.services.tools.invoke(ctx(t, 'studio-manager'), 'profit.pnl', { grain: 'nope' })).rejects.toThrow(/grain/);
    const forecast = (await t.services.tools.invoke(ctx(t, 'studio-manager'), 'forecast.get', {})) as { totalCents: { p10: number; median: number; p90: number } };
    expect(forecast.totalCents.p10).toBeLessThanOrEqual(forecast.totalCents.p90);
    const budget = (await t.services.tools.invoke(ctx(t, 'system'), 'budget.status', { persona_id: win.id })) as { llm: { unit: string } };
    expect(budget.llm.unit).toBe('llm_usd');
    // Acting tools are audited.
    await t.services.tools.invoke(ctx(t, 'owner'), 'profit.run_levers', {});
    expect((await t.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'tool.profit.run_levers'`)).n).toBe(1);
  });

  it('builds the Profit card: month profit vs forecast, top levers, top opportunities', async () => {
    const { s } = await studio();
    t = s;
    await runWeeklyCycle(t.services, t.studioId, NOW);
    const card = await profitCard(t.db, t.studioId, NOW);
    expect(card.month).toBe('2026-10');
    expect(typeof card.profitCents).toBe('number');
    expect(card.forecastCents.p10).toBeLessThanOrEqual(card.forecastCents.median);
    expect(card.forecastCents.median).toBeLessThanOrEqual(card.forecastCents.p90);
    expect(card.topLevers.length).toBeGreaterThan(0);
    expect(card.topLevers.length).toBeLessThanOrEqual(3);
    expect(card.opportunities.length).toBeLessThanOrEqual(3);
  });
});
