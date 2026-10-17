import type { CameraStyle } from '@troupe/agents';
import { type Db, json } from '@troupe/db';

/**
 * Stream K's tables (migration 0019): identity references, location locks and the consistency chain, plus the
 * `calendar_slot.meta.production` record. Plain SQL helpers shared by the compiler (reads), @troupe/media (writes, after
 * each generation) and the dashboard.
 */

export type IdentityKind =
  | 'sheet'
  | 'detail_strip'
  | 'face'
  | 'full_body'
  | 'core'
  | 'bopa_background_grid'
  | 'bopa_background'
  | 'bopa_outfit'
  | 'bopa_pose_grid'
  | 'bopa_pose'
  | 'bopa_angle';

export interface IdentityRef {
  readonly id: string;
  readonly kind: IdentityKind;
  readonly label: string;
  readonly prompt: string;
  /** Provider URL (a generation can reference it). */
  readonly url: string;
  readonly assetKey: string | null;
  readonly status: 'active' | 'candidate' | 'rejected';
  readonly meta: Record<string, unknown>;
  readonly createdAt: Date;
}

interface IdentityRow {
  id: string;
  kind: IdentityKind;
  label: string;
  prompt: string;
  url: string;
  asset_key: string | null;
  status: IdentityRef['status'];
  meta: Record<string, unknown>;
  created_at: Date;
}
const toIdentity = (r: IdentityRow): IdentityRef => ({ id: r.id, kind: r.kind, label: r.label, prompt: r.prompt, url: r.url, assetKey: r.asset_key, status: r.status, meta: r.meta ?? {}, createdAt: r.created_at });

export async function identityRefs(db: Db, personaId: string, kinds?: readonly IdentityKind[]): Promise<IdentityRef[]> {
  const rows = await db.query<IdentityRow>(
    `SELECT * FROM production_identity WHERE persona_id = $1 AND status <> 'rejected' AND ($2::text[] IS NULL OR kind = ANY($2::text[])) ORDER BY kind, created_at`,
    [personaId, kinds ? [...kinds] : null],
  );
  return rows.map(toIdentity);
}

/** Upserts one reference (per persona, kind and label). */
export async function saveIdentityRef(
  db: Db,
  r: { personaId: string; kind: IdentityKind; label: string; prompt: string; url: string; assetKey?: string | null; status?: 'active' | 'candidate'; meta?: Record<string, unknown> },
): Promise<IdentityRef> {
  const row = await db.one<IdentityRow>(
    `INSERT INTO production_identity (persona_id, kind, label, prompt, url, asset_key, status, meta) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     ON CONFLICT (persona_id, kind, label) WHERE status <> 'rejected'
     DO UPDATE SET prompt = EXCLUDED.prompt, url = EXCLUDED.url, asset_key = EXCLUDED.asset_key, status = EXCLUDED.status, meta = production_identity.meta || EXCLUDED.meta
     RETURNING *`,
    [r.personaId, r.kind, r.label.slice(0, 200), r.prompt.slice(0, 4000), r.url, r.assetKey ?? null, r.status ?? 'active', json(r.meta ?? {})],
  );
  return toIdentity(row);
}

/**
 * The identity stack every persona generation carries (PRD §3.15.2): the face close-up and the two full-body shots;
 * before they exist, the 5-view sheet. The persona's own generations only.
 */
export async function identityStackUrls(db: Db, personaId: string): Promise<string[]> {
  const refs = await identityRefs(db, personaId, ['face', 'full_body', 'sheet']);
  const active = refs.filter((r) => r.status === 'active');
  const face = active.filter((r) => r.kind === 'face').slice(0, 1);
  const body = active.filter((r) => r.kind === 'full_body').slice(0, 2);
  const stack = [...face, ...body];
  if (!face.length) stack.unshift(...active.filter((r) => r.kind === 'sheet').slice(0, 1));
  return [...new Set(stack.map((r) => r.url))];
}

// ───────────────────────────── Location lock ─────────────────────────────

/** "The Kitchen " → "kitchen" (lookup key for a place). */
export const placeKey = (place: string): string =>
  place
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/^\s*(?:a|an|the|my|her|his)\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);

export interface LocationRef {
  readonly url: string;
  readonly assetKey: string | null;
  readonly angle: string;
}

export interface LocationLock {
  readonly id: string;
  readonly place: string;
  readonly placeKey: string;
  readonly description: string;
  readonly status: 'pending' | 'locked' | 'retired';
  readonly refs: readonly LocationRef[];
  readonly candidates: ReadonlyArray<{ label: string; prompt: string; url: string; assetKey: string | null }>;
  readonly chosen: number | null;
  readonly source: 'bible' | 'world' | 'owner';
  readonly lockedAt: Date | null;
}

interface LockRow {
  id: string;
  place: string;
  place_key: string;
  description: string;
  status: LocationLock['status'];
  refs: LocationRef[];
  candidates: LocationLock['candidates'];
  chosen: number | null;
  source: LocationLock['source'];
  locked_at: Date | null;
}
const toLock = (r: LockRow): LocationLock => ({
  id: r.id,
  place: r.place,
  placeKey: r.place_key,
  description: r.description,
  status: r.status,
  refs: r.refs ?? [],
  candidates: r.candidates ?? [],
  chosen: r.chosen,
  source: r.source,
  lockedAt: r.locked_at,
});

export async function locationLocks(db: Db, personaId: string): Promise<LocationLock[]> {
  return (await db.query<LockRow>(`SELECT * FROM location_lock WHERE persona_id = $1 AND status <> 'retired' ORDER BY created_at`, [personaId])).map(toLock);
}

/** Registers the places a persona lives in (idempotent): each becomes a pending lock until its anchor frames exist. */
export async function ensureLocations(db: Db, personaId: string, places: ReadonlyArray<{ place: string; description?: string; source?: 'bible' | 'world' | 'owner' }>): Promise<number> {
  let added = 0;
  for (const p of places) {
    const key = placeKey(p.place);
    if (!key) continue;
    const r = await db.maybeOne<{ id: string }>(
      `INSERT INTO location_lock (persona_id, place, place_key, description, source) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (persona_id, place_key) DO NOTHING RETURNING id`,
      [personaId, p.place.slice(0, 200), key, (p.description ?? p.place).slice(0, 600), p.source ?? 'bible'],
    );
    if (r) added += 1;
  }
  return added;
}

/** Locks a place: its anchor frames (the chosen candidate plus its angles) become the reference set. */
export async function lockLocation(
  db: Db,
  personaId: string,
  key: string,
  l: { refs: readonly LocationRef[]; candidates: LocationLock['candidates']; chosen: number; at: Date },
): Promise<LocationLock> {
  const row = await db.one<LockRow>(
    `UPDATE location_lock SET status = 'locked', refs = $3::jsonb, candidates = $4::jsonb, chosen = $5, locked_at = $6, updated_at = now()
      WHERE persona_id = $1 AND place_key = $2 RETURNING *`,
    [personaId, key, json(l.refs), json(l.candidates), l.chosen, l.at],
  );
  return toLock(row);
}

/** The locked reference set for a place (by name or key), or null when the place isn't locked yet. */
export async function lockedLocation(db: Db, personaId: string, place: string | null | undefined): Promise<LocationLock | null> {
  if (!place) return null;
  const row = await db.maybeOne<LockRow>(`SELECT * FROM location_lock WHERE persona_id = $1 AND place_key = $2 AND status = 'locked'`, [personaId, placeKey(place)]);
  return row ? toLock(row) : null;
}

// ───────────────────────────── Consistency chain ─────────────────────────────

export interface ChainFrame {
  readonly id: string;
  readonly url: string;
  readonly genKey: string;
  readonly slotId: string | null;
}

export async function recordFrame(
  db: Db,
  f: { personaId: string; slotId: string | null; genKey: string; location: string | null; camera: string | null; url: string; assetKey?: string | null; chainedFrom?: string | null },
): Promise<string> {
  const row = await db.one<{ id: string }>(
    `INSERT INTO production_frame (persona_id, slot_id, gen_key, location, camera, url, asset_key, chained_from) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [f.personaId, f.slotId, f.genKey, f.location ? placeKey(f.location) : null, f.camera, f.url, f.assetKey ?? null, f.chainedFrom ?? null],
  );
  return row.id;
}

/** QC's verdict on a slot's frames: approved frames can be chained from; rejected ones never are. */
export async function setFrameStatus(db: Db, slotId: string, status: 'approved' | 'rejected', genKeys?: readonly string[]): Promise<number> {
  const rows = await db.query<{ id: string }>(
    `UPDATE production_frame SET status = $2, updated_at = now()
      WHERE slot_id = $1 AND status <> 'rejected' AND ($3::text[] IS NULL OR gen_key = ANY($3::text[])) RETURNING id`,
    [slotId, status, genKeys ? [...genKeys] : null],
  );
  return rows.length;
}

/** The nearest approved frame at a place (the newest), to chain the next still from. Never a rejected or pending one. */
export async function chainFrame(db: Db, personaId: string, location: string | null | undefined, o: { excludeSlotId?: string | null } = {}): Promise<ChainFrame | null> {
  if (!location) return null;
  const row = await db.maybeOne<{ id: string; url: string; gen_key: string; slot_id: string | null }>(
    `SELECT id, url, gen_key, slot_id FROM production_frame
      WHERE persona_id = $1 AND location = $2 AND status = 'approved' AND (slot_id IS DISTINCT FROM $3::uuid OR $3::uuid IS NULL)
      ORDER BY updated_at DESC, created_at DESC LIMIT 1`,
    [personaId, placeKey(location), o.excludeSlotId ?? null],
  );
  return row ? { id: row.id, url: row.url, genKey: row.gen_key, slotId: row.slot_id } : null;
}

// ───────────────────────────── calendar_slot.meta.production ─────────────────────────────

/** What production chose for a slot (docs/IOS-5-CONTRACTS.md §5.6): camera style, location, chain refs. */
export interface SlotProduction {
  readonly camera: CameraStyle | null;
  readonly location: string | null;
  /** Frames this slot's stills were chained from (provider URLs), and whether the place was locked. */
  readonly chain: { readonly from: readonly string[]; readonly locked: boolean };
  readonly format?: string;
  readonly at?: string;
}

/** Writes `calendar_slot.meta.production` only (the other meta keys belong to other streams). */
export async function recordSlotProduction(db: Db, slotId: string, p: SlotProduction): Promise<void> {
  await db.query(`UPDATE calendar_slot SET meta = jsonb_set(COALESCE(meta, '{}'::jsonb), '{production}', $2::jsonb, true) WHERE id = $1`, [slotId, json(p)]);
}

export async function slotProduction(db: Db, slotId: string): Promise<SlotProduction | null> {
  const r = await db.maybeOne<{ p: SlotProduction | null }>(`SELECT meta->'production' AS p FROM calendar_slot WHERE id = $1`, [slotId]);
  return r?.p ?? null;
}

/** The persona's most recent camera styles (newest first), for the rotation. */
export async function recentCameras(db: Db, personaId: string, limit = 4): Promise<string[]> {
  const rows = await db.query<{ camera: string | null }>(
    `SELECT meta->'production'->>'camera' AS camera FROM calendar_slot
      WHERE persona_id = $1 AND meta->'production' IS NOT NULL ORDER BY slot_at DESC LIMIT $2`,
    [personaId, limit],
  );
  return rows.map((r) => r.camera).filter((c): c is string => !!c);
}

// ───────────────────────────── The places a persona lives in ─────────────────────────────

/** Max places locked per persona (PRD §3.15.3: one prompt across 5 settings). */
export const MAX_LOCKED_PLACES = 5;

function placesIn(v: unknown, depth = 0, key = ''): Array<{ place: string; description: string }> {
  if (depth > 4 || v === null || v === undefined) return [];
  if (Array.isArray(v)) {
    if (!/place|location|spot|setting|haunt|room/i.test(key)) return v.flatMap((x) => placesIn(x, depth + 1, ''));
    return v.flatMap((x) => {
      if (typeof x === 'string' && x.trim()) return [{ place: x.trim(), description: x.trim() }];
      if (x && typeof x === 'object') {
        const r = x as Record<string, unknown>;
        const name = [r.name, r.title, r.place, r.label].find((n): n is string => typeof n === 'string' && !!n.trim());
        if (name) return [{ place: name.trim(), description: [r.description, r.details, r.look].find((d): d is string => typeof d === 'string' && !!d.trim())?.trim() ?? name.trim() }];
      }
      return [];
    });
  }
  if (typeof v === 'object') return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => placesIn(x, depth + 1, k));
  return [];
}

/**
 * The recurring places to lock: the World Bible's places when the persona was launched from the Persona Generator
 * (best effort over stream J's draft shape, read from the launched draft), then the bible's look settings.
 */
export async function personaPlaces(db: Db, personaId: string, settings: readonly string[]): Promise<Array<{ place: string; description: string; source: 'world' | 'bible' }>> {
  const draft = await db.maybeOne<{ world: unknown }>(
    `SELECT state->'world' AS world FROM persona_draft WHERE persona_id = $1 ORDER BY updated_at DESC LIMIT 1`,
    [personaId],
  ).catch(() => null);
  const world = placesIn((draft?.world as { bible?: unknown } | null)?.bible ?? null).map((p) => ({ ...p, source: 'world' as const }));
  const bible = settings.map((s) => ({ place: s, description: s, source: 'bible' as const }));
  const out: Array<{ place: string; description: string; source: 'world' | 'bible' }> = [];
  for (const p of [...world, ...bible]) {
    if (out.length >= MAX_LOCKED_PLACES) break;
    if (!out.some((o) => placeKey(o.place) === placeKey(p.place))) out.push({ ...p, description: p.description.slice(0, 600) });
  }
  return out;
}
