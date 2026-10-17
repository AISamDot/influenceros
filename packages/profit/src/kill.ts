import { addMessage, canTransition, findThread, type PersonaState, proposeKill, STUDIO_MANAGER } from '@troupe/core';
import type { Db } from '@troupe/db';
import { getProfitSettings } from './settings';
import type { Forecast } from './types';
import { addDays } from './util';

/**
 * Kill candidates (PRD §3.11.4, FR-24.4): a persona whose forecast median profit is negative for 4+ consecutive
 * weeks becomes a kill proposal from the Studio Manager (the Profit Engine lives inside it). It is only ever a
 * proposal: the Owner approves kills explicitly in the approval engine, with no timer.
 *
 * Guards: the persona needs a few full weeks of history (a brand-new persona always forecasts a loss); there is
 * at most one pending kill/retire per persona (also a unique index); after the Owner rejects a profit-engine kill,
 * it waits `killCooldownDays` before proposing again. A BRAND persona can't be killed, so it is proposed for
 * retirement instead.
 */

/** A TESTING persona is judged by the Day-30 checkpoint (≥ 1 sale) before the Profit Engine may propose a kill. */
export const MIN_DAYS_LIVE = 30;

export interface KillCandidate {
  personaId: string;
  name: string;
  action: 'kill' | 'retire';
  negativeWeeks: number;
  forecastTotalCents: number;
  approvalId: string | null;
  proposalId: string | null;
  skipped?: string;
}

export async function proposeKillCandidates(db: Db, studioId: string, forecasts: readonly Forecast[], now: Date): Promise<KillCandidate[]> {
  const settings = await getProfitSettings(db, studioId);
  const out: KillCandidate[] = [];
  for (const f of forecasts) {
    if (!f.personaId || f.negativeWeeks < settings.killNegativeWeeks) continue;
    const p = await db.maybeOne<{ id: string; name: string; state: PersonaState; launched_at: Date | null; created_at: Date }>(
      'SELECT id, name, state, launched_at, created_at FROM persona WHERE id = $1 AND studio_id = $2',
      [f.personaId, studioId],
    );
    if (!p) continue;
    const action: 'kill' | 'retire' | null = canTransition(p.state, 'KILLED') ? 'kill' : canTransition(p.state, 'RETIRED') ? 'retire' : null;
    const base: KillCandidate = { personaId: p.id, name: p.name, action: action ?? 'kill', negativeWeeks: f.negativeWeeks, forecastTotalCents: f.totalCents.median, approvalId: null, proposalId: null };
    if (!action) {
      out.push({ ...base, skipped: `${p.state} can't be killed or retired` });
      continue;
    }
    // Not launched yet, or still before the PRD's Day-30 checkpoint: the lifecycle checkpoints judge young personas.
    if (p.state === 'SETUP') {
      out.push({ ...base, skipped: 'not launched yet (SETUP)' });
      continue;
    }
    const daysLive = Math.floor((now.getTime() - new Date(p.launched_at ?? p.created_at).getTime()) / 86_400_000);
    if (p.state === 'TESTING' && daysLive < MIN_DAYS_LIVE) {
      out.push({ ...base, skipped: `only ${daysLive} days live (the Day-30 checkpoint decides first)` });
      continue;
    }
    if ((f.weeksOfHistory ?? 0) < settings.minWeeksBeforeKill) {
      out.push({ ...base, skipped: `only ${f.weeksOfHistory ?? 0} full weeks of history` });
      continue;
    }
    const pending = await db.maybeOne(
      `SELECT 1 FROM approval WHERE persona_id = $1 AND status = 'pending' AND kind IN ('persona_kill','persona_retire')`,
      [p.id],
    );
    if (pending) {
      out.push({ ...base, skipped: 'a kill or retire is already pending' });
      continue;
    }
    const rejected = await db.maybeOne(
      `SELECT 1 FROM approval WHERE persona_id = $1 AND kind IN ('persona_kill','persona_retire') AND status = 'rejected'
          AND payload->'evidence'->>'source' = 'profit-engine' AND decided_at > $2`,
      [p.id, addDays(now, -settings.killCooldownDays)],
    );
    if (rejected) {
      out.push({ ...base, skipped: 'the Owner rejected a recent profit-engine proposal' });
      continue;
    }
    const total = (f.totalCents.median / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
    const rationale = `Profit Engine: ${p.name}'s 90-day forecast is negative for ${f.negativeWeeks} straight weeks (median ${total} over 90 days). ${
      action === 'kill' ? 'Proposing a kill' : 'Proposing retirement'
    }; it keeps running until you decide.`;
    try {
      const { approval, proposalId } = await proposeKill(db, {
        personaId: p.id,
        rationale,
        action,
        proposedBy: STUDIO_MANAGER,
        score: Math.max(0, Math.min(100, Math.round(f.negativeWeeks * (100 / 13)))),
        evidence: {
          source: 'profit-engine',
          negative_weeks: f.negativeWeeks,
          weeks_of_history: f.weeksOfHistory ?? 0,
          forecast_total_cents: f.totalCents,
          forecast_weeks: f.weekly.slice(0, 6),
          generated_at: f.generatedAt.toISOString(),
        },
        now,
      });
      // The kill card also shows inline in the Studio chat (PRD 3.9), like a Studio Manager tool proposal.
      const thread = await findThread(db, studioId, 'studio');
      await addMessage(db, {
        threadId: thread.id,
        role: 'agent',
        author: 'agent:studio-manager',
        body: `${approval.title}: ${rationale}`,
        personaId: p.id,
        meta: { kind: 'approval_card', approvalId: approval.id, source: 'profit-engine' },
      });
      out.push({ ...base, approvalId: approval.id, proposalId });
    } catch (err) {
      // A concurrent proposal hit the one-pending-per-persona index: someone else already proposed it.
      if (/approval_one_pending_lifecycle_idx|duplicate key/i.test(String((err as Error).message))) {
        out.push({ ...base, skipped: 'a kill or retire is already pending' });
        continue;
      }
      throw err;
    }
  }
  return out;
}
