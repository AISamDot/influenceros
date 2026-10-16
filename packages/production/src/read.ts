import type { CameraStyle } from '@ios/agents';
import { loadPersonaContext } from '@ios/content';
import type { Db } from '@ios/db';
import { CAMERA_SPEC, cameraStylesFor } from './camera';
import { type IdentityRef, identityRefs, type LocationLock, locationLocks } from './store';

/** What the persona page and `production.overview` show: the identity references, locks, camera rotation and recent slots. */
export interface ProductionOverview {
  readonly cameraStyles: ReadonlyArray<{ readonly style: CameraStyle; readonly label: string }>;
  readonly identity: readonly IdentityRef[];
  readonly locations: readonly LocationLock[];
  readonly recent: ReadonlyArray<{ readonly slotId: string; readonly title: string; readonly format: string; readonly at: Date; readonly camera: string | null; readonly location: string | null; readonly chained: number; readonly locked: boolean }>;
  readonly counts: { readonly sheet: number; readonly identityStack: number; readonly core: number; readonly bopa: number; readonly lockedLocations: number };
}

export async function productionOverview(db: Db, personaId: string): Promise<ProductionOverview> {
  const ctx = await loadPersonaContext(db, personaId);
  const identity = await identityRefs(db, personaId);
  const locations = await locationLocks(db, personaId);
  const rows = await db.query<{ id: string; title: string; format: string; slot_at: Date; p: { camera?: string | null; location?: string | null; chain?: { from?: string[]; locked?: boolean } } }>(
    `SELECT id, title, format, slot_at, meta->'production' AS p FROM calendar_slot
      WHERE persona_id = $1 AND meta->'production' IS NOT NULL ORDER BY slot_at DESC LIMIT 12`,
    [personaId],
  );
  const active = identity.filter((r) => r.status === 'active');
  return {
    cameraStyles: cameraStylesFor(ctx.bible, personaId).map((s) => ({ style: s, label: CAMERA_SPEC[s].label })),
    identity,
    locations,
    recent: rows.map((r) => ({
      slotId: r.id,
      title: r.title,
      format: r.format,
      at: r.slot_at,
      camera: r.p?.camera ?? null,
      location: r.p?.location ?? null,
      chained: r.p?.chain?.from?.length ?? 0,
      locked: !!r.p?.chain?.locked,
    })),
    counts: {
      sheet: active.filter((r) => r.kind === 'sheet' || r.kind === 'detail_strip').length,
      identityStack: active.filter((r) => r.kind === 'face' || r.kind === 'full_body').length,
      core: active.filter((r) => r.kind === 'core').length,
      bopa: active.filter((r) => r.kind.startsWith('bopa_')).length,
      lockedLocations: locations.filter((l) => l.status === 'locked').length,
    },
  };
}
