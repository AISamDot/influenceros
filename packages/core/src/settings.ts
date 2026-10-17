import { type Db, json } from '@troupe/db';
import { audit } from './audit';
import { ForbiddenError, NotFoundError } from './errors';
import { reconcilePostApprovals } from './policy';
import { type Actor, actorRef, type Autonomy, type Caps, DEFAULT_SETTINGS, type PersonaRow, type StudioSettings } from './types';

const AUTONOMY_RANK: Record<Autonomy, number> = { L0: 0, L1: 1, L2: 2 };

export interface StudioRow {
  id: string;
  slug: string;
  name: string;
  settings: Partial<StudioSettings>;
}

export function mergeSettings(s: Partial<StudioSettings> | null | undefined): StudioSettings {
  const v = s ?? {};
  return {
    ...DEFAULT_SETTINGS,
    ...v,
    caps: { ...DEFAULT_SETTINGS.caps, ...(v.caps ?? {}) },
    persona_default_caps: { ...DEFAULT_SETTINGS.persona_default_caps, ...(v.persona_default_caps ?? {}) },
    approvals: { ...DEFAULT_SETTINGS.approvals, ...(v.approvals ?? {}) },
    // The Gate's lines are PRD-derived, not Owner settings: a stored copy never outlives a rule change.
    gate: DEFAULT_SETTINGS.gate,
    formats: { ...DEFAULT_SETTINGS.formats, ...(v.formats ?? {}) },
  };
}

/** The (single) studio. IOS-1 runs one studio; the schema allows more. */
export async function getStudio(db: Db, studioId?: string): Promise<StudioRow & { resolved: StudioSettings }> {
  const row = studioId
    ? await db.maybeOne<StudioRow>('SELECT id, slug, name, settings FROM studio WHERE id = $1', [studioId])
    : await db.maybeOne<StudioRow>('SELECT id, slug, name, settings FROM studio ORDER BY created_at LIMIT 1');
  if (!row) throw new NotFoundError('no studio: run `pnpm db:seed`');
  return { ...row, resolved: mergeSettings(row.settings) };
}

export async function getSettings(db: Db, studioId: string): Promise<StudioSettings> {
  return (await getStudio(db, studioId)).resolved;
}

/**
 * Deep-merges a patch into studio settings and audits the change. Owner only: caps, approval toggles, autonomy
 * defaults and Gate rules are the Owner's (agents ask for headroom with a spend_over_cap approval).
 * Disclosure text changes go through approvals.
 */
export async function updateSettings(
  db: Db,
  studioId: string,
  patch: Partial<Omit<StudioSettings, 'disclosure_text'>>,
  actor: Actor,
): Promise<StudioSettings> {
  if (actor.type !== 'owner') throw new ForbiddenError(`${actorRef(actor)} cannot change studio settings: only the Owner can`);
  return db.transaction(async (tx) => {
    const current = await getSettings(tx, studioId);
    const next = mergeSettings({
      ...current,
      ...patch,
      caps: { ...current.caps, ...(patch.caps ?? {}) },
      persona_default_caps: { ...current.persona_default_caps, ...(patch.persona_default_caps ?? {}) },
      approvals: { ...current.approvals, ...(patch.approvals ?? {}) },
      formats: { ...current.formats, ...(patch.formats ?? {}) },
      disclosure_text: current.disclosure_text,
    });
    await tx.query('UPDATE studio SET settings = $2::jsonb, updated_at = now() WHERE id = $1', [studioId, json(next)]);
    await audit(tx, { studioId, actor, action: 'settings.updated', entityType: 'studio', entityId: studioId, data: { patch } });
    return next;
  });
}

export async function getPersona(db: Db, idOrSlug: string): Promise<PersonaRow> {
  const isUuid = /^[0-9a-f-]{36}$/i.test(idOrSlug);
  const row = await db.maybeOne<PersonaRow>(
    `SELECT * FROM persona WHERE ${isUuid ? 'id = $1' : 'slug = $1'}`,
    [idOrSlug],
  );
  if (!row) throw new NotFoundError(`persona not found: ${idOrSlug}`);
  return row;
}

export function personaCaps(persona: Pick<PersonaRow, 'budget'>, settings: StudioSettings): Caps {
  return { ...settings.persona_default_caps, ...(persona.budget ?? {}) };
}

/**
 * Sets a persona's autonomy and monthly caps. The Owner can change anything; agents and the system can only
 * lower them (circuit breakers, FR-17.2). Pending veto-window posts that the new level no longer allows become
 * explicit, so dropping to L0 means every queued post waits for a tap.
 */
export async function updatePersonaControls(
  db: Db,
  personaId: string,
  patch: { autonomy?: PersonaRow['autonomy']; budget?: Partial<Caps> },
  actor: Actor,
): Promise<void> {
  await db.transaction(async (tx) => {
    const p = await getPersona(tx, personaId);
    const settings = await getSettings(tx, p.studio_id);
    if (actor.type !== 'owner') {
      const raisesAutonomy = patch.autonomy !== undefined && AUTONOMY_RANK[patch.autonomy] > AUTONOMY_RANK[p.autonomy];
      const current = personaCaps(p, settings);
      const raisesBudget = Object.entries(patch.budget ?? {}).some(
        ([k, v]) => v !== undefined && !(Number(v) <= current[k as keyof Caps]),
      );
      if (raisesAutonomy || raisesBudget) {
        throw new ForbiddenError(`${actorRef(actor)} can only lower a persona's autonomy or caps: raising them is the Owner's call`);
      }
    }
    const budget = { ...(p.budget ?? {}), ...(patch.budget ?? {}) };
    await tx.query(
      `UPDATE persona SET autonomy = COALESCE($2, autonomy), budget = $3::jsonb, updated_at = now() WHERE id = $1`,
      [personaId, patch.autonomy ?? null, json(budget)],
    );
    await audit(tx, {
      studioId: p.studio_id,
      personaId,
      actor,
      action: 'persona.controls_updated',
      entityType: 'persona',
      entityId: personaId,
      data: { from: { autonomy: p.autonomy, budget: p.budget }, to: { autonomy: patch.autonomy ?? p.autonomy, budget } },
    });
    if (patch.autonomy && patch.autonomy !== p.autonomy) {
      await reconcilePostApprovals(tx, { personaId, settings, actor });
    }
  });
}
