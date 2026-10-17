import type { StudioServices } from '@troupe/agents';
import { notify } from '@troupe/core';
import { forecastStudio, storeForecasts } from './forecast';
import { proposeKillCandidates } from './kill';
import { measureLevers, runLevers } from './levers';
import { postWeeklyReport } from './report';
import { sum } from './util';

/**
 * The Profit Engine's weekly cycle (run by the `profit.weekly_cycle` job): measure the levers whose review window
 * passed, refresh the 90-day forecast, pull this week's levers, propose kill candidates, then post the Weekly
 * Profit Report into the Studio chat. Every step is idempotent within a week, so a retried job is safe.
 */
export interface CycleResult {
  measured: number;
  reverted: number;
  levers: number;
  expectedImpactCents: number;
  forecastMedianCents: number;
  killProposals: number;
  reportMessageId: string | null;
}

export async function runWeeklyCycle(
  services: StudioServices,
  studioId: string,
  now: Date = services.now(),
  heartbeat: () => Promise<boolean> = async () => true,
): Promise<CycleResult> {
  const { db } = services;
  const lost = async () => !(await heartbeat());

  const m = await measureLevers(db, studioId, now);
  if (await lost()) throw new Error('lease lost after measuring levers');

  const forecast = await forecastStudio(db, { studioId, now });
  await storeForecasts(db, studioId, forecast, now);
  if (await lost()) throw new Error('lease lost after the forecast');

  const levers = await runLevers(db, studioId, now);
  if (levers.length) {
    // Persona creative and cadence decisions are delegated: notify the Owner, no approval needed.
    await notify(db, {
      studioId,
      kind: 'digest',
      title: `Profit Engine pulled ${levers.length} lever${levers.length === 1 ? '' : 's'}`,
      body: levers.map((l) => l.rationale).join(' ').slice(0, 600),
      link: '/money',
    });
  }
  if (await lost()) throw new Error('lease lost after the levers');

  const kills = await proposeKillCandidates(db, studioId, forecast.personas, now);
  const report = await postWeeklyReport(services, studioId, now, kills);
  return {
    measured: m.measured.length,
    reverted: m.reverted.length,
    levers: levers.length,
    expectedImpactCents: sum(levers.map((l) => l.expectedImpactCents)),
    forecastMedianCents: forecast.studio.totalCents.median,
    killProposals: kills.filter((k) => k.approvalId).length,
    reportMessageId: report?.messageId ?? null,
  };
}
