import { createHash } from 'node:crypto';
import { type Db, json } from '@ios/db';
import { audit } from './audit';
import { ApprovalError } from './errors';
import { notify } from './notifications';
import {
  type Actor,
  type ApprovalKind,
  type ApprovalMode,
  type ApprovalRow,
  type Autonomy,
  type GateVerdict,
  type StudioSettings,
} from './types';

/**
 * Approval policy (PRD §3.7).
 * - Owner-only kinds (kill/retire, spend above caps, plan upgrades, disclosure/legal text): explicit Owner
 *   approval, no timer, never auto-approved. Agents can only propose. The database enforces this too.
 * - Cards (persona launch, product v1): auto-approve after N hours (default 24) unless the studio switched it off.
 * - Posts: L0 = explicit; L1 = green auto after the veto window, amber explicit; L2 = green+amber after the veto
 *   window. Red never publishes. A post with no Gate verdict is explicit (never treated as green).
 */
export const OWNER_ONLY_KINDS: readonly ApprovalKind[] = [
  'persona_kill',
  'persona_retire',
  'spend_over_cap',
  'plan_upgrade',
  'disclosure_change',
  'legal_text_change',
];
export const CARD_KINDS: readonly ApprovalKind[] = ['persona_launch', 'product_v1'];

export const isOwnerOnly = (k: ApprovalKind) => OWNER_ONLY_KINDS.includes(k);

export interface PolicyContext {
  autonomy?: Autonomy;
  gate?: GateVerdict;
}

export function approvalPolicy(
  kind: ApprovalKind,
  settings: StudioSettings,
  ctx: PolicyContext = {},
): { mode: ApprovalMode; windowMs: number | null } {
  if (isOwnerOnly(kind)) return { mode: 'explicit', windowMs: null };
  if (CARD_KINDS.includes(kind)) {
    return settings.approvals.auto_approve_cards
      ? { mode: 'auto_after', windowMs: settings.approvals.auto_approve_hours * 3_600_000 }
      : { mode: 'explicit', windowMs: null };
  }
  // post
  const gate = ctx.gate;
  if (gate === 'red') throw new ApprovalError('Gate red: the post is blocked and can never be queued for publishing');
  // No verdict: fail closed (a human looks at it).
  if (!gate) return { mode: 'explicit', windowMs: null };
  const veto = { mode: 'veto_window' as const, windowMs: settings.approvals.post_veto_window_minutes * 60_000 };
  switch (ctx.autonomy ?? 'L0') {
    case 'L0':
      return { mode: 'explicit', windowMs: null };
    case 'L1':
      return gate === 'green' ? veto : { mode: 'explicit', windowMs: null };
    case 'L2':
      return veto;
  }
}

/** The latest Compliance Gate verdict recorded for a post (null when the Gate hasn't run). */
export async function latestPostGate(
  db: Db,
  postId: string,
): Promise<{ verdict: GateVerdict; released_by: string | null } | null> {
  return db.maybeOne<{ verdict: GateVerdict; released_by: string | null }>(
    `SELECT verdict, released_by FROM gate_result WHERE subject_type = 'post' AND subject_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [postId],
  );
}

/** Would this post still get a veto window under the persona's current autonomy and the current Gate verdict? */
export function postWindowAllowed(settings: StudioSettings, autonomy: Autonomy, gate: GateVerdict | null): boolean {
  if (!gate || gate === 'red') return false;
  return approvalPolicy('post', settings, { autonomy, gate }).mode === 'veto_window';
}

/** Turns a pending timed approval into an explicit one (it then waits for the Owner), with an audit entry. */
export async function makeExplicit(tx: Db, a: ApprovalRow, actor: Actor, action: string, data: Record<string, unknown>): Promise<void> {
  await tx.query(`UPDATE approval SET mode = 'explicit', auto_approve_at = NULL WHERE id = $1 AND status = 'pending'`, [a.id]);
  await audit(tx, { studioId: a.studio_id, personaId: a.persona_id, actor, action, entityType: 'approval', entityId: a.id, data });
}

/**
 * Re-applies the post policy to a persona's pending veto-window posts (after an autonomy change). Any post that
 * would no longer get a window (e.g. the persona dropped to L0) becomes explicit and waits for the Owner's tap.
 */
export async function reconcilePostApprovals(
  tx: Db,
  input: { personaId: string; settings: StudioSettings; actor: Actor },
): Promise<string[]> {
  const persona = await tx.one<{ autonomy: Autonomy }>('SELECT autonomy FROM persona WHERE id = $1', [input.personaId]);
  const rows = await tx.query<ApprovalRow>(
    `SELECT * FROM approval WHERE persona_id = $1 AND kind = 'post' AND status = 'pending' AND mode = 'veto_window'`,
    [input.personaId],
  );
  const changed: string[] = [];
  for (const a of rows) {
    const gate = a.subject_id ? ((await latestPostGate(tx, a.subject_id))?.verdict ?? null) : null;
    if (postWindowAllowed(input.settings, persona.autonomy, gate)) continue;
    await makeExplicit(tx, a, input.actor, 'approval.window_revoked', { autonomy: persona.autonomy, gate });
    await notify(tx, {
      studioId: a.studio_id,
      personaId: a.persona_id,
      kind: 'approval',
      severity: 'info',
      title: a.title,
      body: `Now needs your approval (autonomy ${persona.autonomy}, Gate ${gate ?? 'missing'}).`,
      link: '/approvals',
    });
    changed.push(a.id);
  }
  return changed;
}

/** Fingerprint of the payload the Owner saw on the card; decide() refuses if it changed since. */
export function payloadHash(payload: unknown): string {
  return createHash('sha256').update(json(payload ?? {})).digest('hex').slice(0, 32);
}
