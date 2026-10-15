import { mkdirSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import type { MediaStore, StoredObject } from './types';

/**
 * Media storage (IOS-3/4, docs/IOS-34-CONTRACTS.md §5.3). Keys are validated the same way everywhere so a key can
 * never escape the store's root or reach a non-public file through the public route.
 */
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

export function isValidMediaKey(key: string): boolean {
  return key.length <= 300 && KEY_RE.test(key) && !key.split('/').some((p) => p === '.' || p === '..');
}

export function assertMediaKey(key: string): string {
  if (!isValidMediaKey(key)) throw new Error(`invalid media key: ${JSON.stringify(key).slice(0, 80)}`);
  return key;
}

/** Only `public/…` keys may be served without the Owner session (persona sites, lead-magnet covers). */
export const isPublicMediaKey = (key: string): boolean => isValidMediaKey(key) && key.startsWith('public/');

/** Dashboard URL for a key: Owner-only `/api/media/<key>`, or `/api/public/media/<key>` for public keys. */
export function mediaUrl(key: string): string {
  assertMediaKey(key);
  return isPublicMediaKey(key) ? `/api/public/media/${key}` : `/api/media/${key}`;
}

const toBytes = (data: Uint8Array | string): Uint8Array => (typeof data === 'string' ? new TextEncoder().encode(data) : data);

/** In-memory store: tests and the default fake. `localPath` writes a temp copy for tools that need a file. */
export class MemoryMediaStore implements MediaStore {
  readonly name = 'memory-media';
  readonly objects = new Map<string, { data: Uint8Array; contentType: string }>();
  async put(req: { key: string; data: Uint8Array | string; contentType: string }): Promise<StoredObject> {
    const data = toBytes(req.data);
    this.objects.set(assertMediaKey(req.key), { data, contentType: req.contentType });
    return { key: req.key, url: mediaUrl(req.key), bytes: data.byteLength, contentType: req.contentType };
  }
  async putFile(req: { key: string; filePath: string; contentType: string }): Promise<StoredObject> {
    return this.put({ key: req.key, data: new Uint8Array(await readFile(req.filePath)), contentType: req.contentType });
  }
  async get(key: string) {
    return isValidMediaKey(key) ? (this.objects.get(key) ?? null) : null;
  }
  async localPath(key: string): Promise<string | null> {
    const o = await this.get(key);
    if (!o) return null;
    const file = join(tmpdir(), 'ios-media', ...key.split('/'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, o.data);
    return file;
  }
  url(key: string): string {
    return mediaUrl(key);
  }
}

/** Files under a root directory (the Mac: `IOS_MEDIA_DIR`, default `<repo>/.data/media`). Content types sit beside each file. */
export class LocalMediaStore implements MediaStore {
  readonly name = 'local-media';
  readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  private file(key: string): string {
    const f = resolve(this.root, ...assertMediaKey(key).split('/'));
    if (!f.startsWith(this.root + sep)) throw new Error('media key escapes the store');
    return f;
  }
  async put(req: { key: string; data: Uint8Array | string; contentType: string }): Promise<StoredObject> {
    const f = this.file(req.key);
    const data = toBytes(req.data);
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, data);
    await writeFile(`${f}.type`, req.contentType);
    return { key: req.key, url: mediaUrl(req.key), bytes: data.byteLength, contentType: req.contentType };
  }
  async putFile(req: { key: string; filePath: string; contentType: string }): Promise<StoredObject> {
    const f = this.file(req.key);
    await mkdir(dirname(f), { recursive: true });
    await copyFile(req.filePath, f);
    await writeFile(`${f}.type`, req.contentType);
    return { key: req.key, url: mediaUrl(req.key), bytes: (await stat(f)).size, contentType: req.contentType };
  }
  async get(key: string) {
    if (!isValidMediaKey(key)) return null;
    try {
      const f = this.file(key);
      const [data, contentType] = await Promise.all([readFile(f), readFile(`${f}.type`, 'utf8').catch(() => 'application/octet-stream')]);
      return { data: new Uint8Array(data), contentType };
    } catch {
      return null;
    }
  }
  async localPath(key: string): Promise<string | null> {
    if (!isValidMediaKey(key)) return null;
    const f = this.file(key);
    try {
      await stat(f);
      return f;
    } catch {
      return null;
    }
  }
  url(key: string): string {
    return mediaUrl(key);
  }
}
