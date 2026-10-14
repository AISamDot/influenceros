import { type Db, json } from '@ios/db';
import { audit } from './audit';
import { NotFoundError } from './errors';
import { type Actor, type Caps, DEFAULT_SETTINGS, type PersonaRow, type StudioSettings } from './types';

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
    gate: { ...DEFAULT_SETTINGS.gate, ...(v.gate ?? {}) },
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

/** Deep-merges a patch into studio settings and audits the change. Disclosure text changes go through approvals. */
export async function updateSettings(
  db: Db,
  studioId: string,
  patch: Partial<Omit<StudioSettings, 'disclosure_text'>>,
  actor: Actor,
): Promise<StudioSettings> {
  return db.transaction(async (tx) => {
    const current = await getSettings(tx, studioId);
    const next = mergeSettings({
      ...current,
      ...patch,
      caps: { ...current.caps, ...(patch.caps ?? {}) },
      persona_default_caps: { ...current.persona_default_caps, ...(patch.persona_default_caps ?? {}) },
      approvals: { ...current.approvals, ...(patch.approvals ?? {}) },
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

export async function updatePersonaControls(
  db: Db,
  personaId: string,
  patch: { autonomy?: PersonaRow['autonomy']; budget?: Partial<Caps> },
  actor: Actor,
): Promise<void> {
  await db.transaction(async (tx) => {
    const p = await getPersona(tx, personaId);
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
  });
}
