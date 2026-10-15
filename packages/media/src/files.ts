import { mkdir } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import type { StudioServices } from '@ios/agents';
import { json } from '@ios/db';
import type { MediaToolkit } from './toolkit';

/** Files between providers, the local toolkit and `providers.storage`, plus the `asset` rows that describe them. */

export const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};
export const contentTypeOf = (path: string): string => CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
export const extFor = (contentType: string): string => Object.entries(CONTENT_TYPES).find(([, t]) => t === contentType)?.[0] ?? '.bin';

const MEDIA_PREFIXES = ['/api/media/', '/api/public/media/'];

/** The storage key behind a dashboard URL, or null for an external URL. */
export function storageKeyOf(url: string): string | null {
  const p = MEDIA_PREFIXES.find((x) => url.startsWith(x));
  return p ? decodeURI(url.slice(p.length)) : null;
}

/** A local file for a provider result: stored media straight from storage, anything else through the toolkit. */
export async function materialize(
  services: StudioServices,
  toolkit: MediaToolkit,
  url: string,
  dest: string,
  hint: { kind: 'image' | 'video' | 'audio'; durationS?: number },
): Promise<string> {
  const key = storageKeyOf(url);
  if (key) {
    const p = await services.providers.storage.localPath(key);
    if (!p) throw new Error(`stored media missing: ${key}`);
    return p;
  }
  await mkdir(dirname(dest), { recursive: true });
  await toolkit.fetch(url, dest, hint);
  return dest;
}

/** A local path for a stored key (memory stores write a temp copy). */
export async function localOf(services: StudioServices, key: string): Promise<string> {
  const p = await services.providers.storage.localPath(key);
  if (!p) throw new Error(`stored media missing: ${key}`);
  return p;
}

export const workDir = (root: string, slotId: string) => join(root, slotId);

export type AssetType = 'image' | 'video' | 'audio' | 'carousel' | 'thumbnail';
export type AssetRole = 'final' | 'slide' | 'cover' | 'voice' | 'clip' | 'still' | 'reference' | 'look';

/** Stores a local file and writes its asset row (render_meta.storage_key; AI marker on every generated file). */
export async function storeAsset(
  services: StudioServices,
  a: {
    personaId: string;
    scriptId?: string | null;
    slotId?: string | null;
    key: string;
    file: string;
    contentType?: string;
    type: AssetType;
    role: AssetRole;
    provider?: string | null;
    credits?: number;
    usd?: number;
    meta?: Record<string, unknown>;
    tools?: readonly string[];
  },
): Promise<{ id: string; key: string; url: string; contentType: string }> {
  const contentType = a.contentType ?? contentTypeOf(a.key);
  const stored = await services.providers.storage.putFile({ key: a.key, filePath: a.file, contentType });
  const row = await services.db.one<{ id: string }>(
    `INSERT INTO asset (persona_id, script_id, slot_id, type, role, url, provider, credit_cost, usd_cost, render_meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb) RETURNING id`,
    [
      a.personaId,
      a.scriptId ?? null,
      a.slotId ?? null,
      a.type,
      a.role,
      stored.url,
      a.provider ?? null,
      Math.round(a.credits ?? 0),
      a.usd ?? 0,
      json({ storage_key: a.key, content_type: contentType, bytes: stored.bytes, ai: { generated: true, tools: [...(a.tools ?? [])] }, ...(a.meta ?? {}) }),
    ],
  );
  return { id: row.id, key: a.key, url: stored.url, contentType };
}
