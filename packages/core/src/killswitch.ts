import type { Db } from '@troupe/db';
import { audit } from './audit';
import { ForbiddenError, PublishBlockedError } from './errors';
import { PUBLISHING_STATES } from './lifecycle';
import { notify } from './notifications';
import { type Actor, actorRef, type PersonaState, type Platform } from './types';

/** Kill switches (FR-7.5, FR-17.2): global, per persona, per platform. All are checked before any publish. */
export type KillScope =
  | { scope: 'global' }
  | { scope: 'persona'; personaId: string }
  | { scope: 'platform'; platform: Platform };

export interface KillSwitchRow {
  id: string;
  studio_id: string;
  scope: 'global' | 'persona' | 'platform';
  persona_id: string | null;
  platform: string | null;
  active: boolean;
  reason: string | null;
  set_by: string;
  set_at: Date;
}

const target = (s: KillScope) => ({
  personaId: s.scope === 'persona' ? s.personaId : null,
  platform: s.scope === 'platform' ? s.platform : null,
});

/** Turns a switch on (idempotent). Anyone may pull a kill switch; only clearing is audited as a resume. */
export async function setKillSwitch(db: Db, studioId: string, s: KillScope, actor: Actor, reason?: string): Promise<void> {
  const { personaId, platform } = target(s);
  await db.transaction(async (tx) => {
    const existing = await tx.maybeOne(
      `SELECT 1 FROM kill_switch WHERE studio_id = $1 AND scope = $2 AND active
         AND persona_id IS NOT DISTINCT FROM $3 AND platform IS NOT DISTINCT FROM $4`,
      [studioId, s.scope, personaId, platform],
    );
    if (existing) return;
    await tx.query(
      `INSERT INTO kill_switch (studio_id, scope, persona_id, platform, reason, set_by) VALUES ($1, $2, $3, $4, $5, $6)`,
      [studioId, s.scope, personaId, platform, reason ?? null, actorRef(actor)],
    );
    await audit(tx, { studioId, personaId, actor, action: 'kill_switch.set', entityType: 'kill_switch', entityId: `${s.scope}:${personaId ?? platform ?? 'all'}`, data: { reason: reason ?? null } });
    await notify(tx, {
      studioId,
      personaId,
      kind: 'system',
      severity: 'warn',
      title: `Posting paused: ${s.scope === 'global' ? 'all personas' : s.scope === 'platform' ? platform : 'persona'}`,
      body: reason,
      link: '/settings',
    });
  });
}

/** Resuming posting is the Owner's call: agents and the system can pause but never un-pause. */
export async function clearKillSwitch(db: Db, studioId: string, s: KillScope, actor: Actor): Promise<void> {
  if (actor.type !== 'owner') throw new ForbiddenError(`${actorRef(actor)} cannot clear a kill switch: only the Owner can resume posting`);
  const { personaId, platform } = target(s);
  await db.transaction(async (tx) => {
    const rows = await tx.query(
      `UPDATE kill_switch SET active = false, cleared_by = $5, cleared_at = now()
        WHERE studio_id = $1 AND scope = $2 AND active
          AND persona_id IS NOT DISTINCT FROM $3 AND platform IS NOT DISTINCT FROM $4 RETURNING id`,
      [studioId, s.scope, personaId, platform, actorRef(actor)],
    );
    if (rows.length) {
      await audit(tx, { studioId, personaId, actor, action: 'kill_switch.cleared', entityType: 'kill_switch', entityId: `${s.scope}:${personaId ?? platform ?? 'all'}` });
    }
  });
}

export async function activeKillSwitches(db: Db, studioId: string): Promise<KillSwitchRow[]> {
  return db.query<KillSwitchRow>('SELECT * FROM kill_switch WHERE studio_id = $1 AND active ORDER BY set_at', [studioId]);
}

/** Every reason this persona can't publish to this platform right now (empty = clear to publish). */
export async function publishBlockers(db: Db, personaId: string, platform: Platform): Promise<string[]> {
  const p = await db.one<{ studio_id: string; name: string; state: PersonaState }>(
    'SELECT studio_id, name, state FROM persona WHERE id = $1',
    [personaId],
  );
  const reasons: string[] = [];
  const switches = await activeKillSwitches(db, p.studio_id);
  for (const k of switches) {
    if (k.scope === 'global') reasons.push('global kill switch is on');
    if (k.scope === 'persona' && k.persona_id === personaId) reasons.push(`${p.name} is paused`);
    if (k.scope === 'platform' && k.platform === platform) reasons.push(`${platform} is paused`);
  }
  if (!PUBLISHING_STATES.includes(p.state)) reasons.push(`${p.name} is ${p.state}`);
  return reasons;
}

export async function assertCanPublish(db: Db, personaId: string, platform: Platform): Promise<void> {
  const reasons = await publishBlockers(db, personaId, platform);
  if (reasons.length) throw new PublishBlockedError(reasons);
}
