import { isPublicMediaKey, MemoryMediaStore } from '@troupe/providers';
import { beforeAll, describe, expect, it } from 'vitest';
import { keyFrom, serveMedia } from '../../../apps/web/app/api/media/serve';

// The route handlers are thin wrappers: /api/media checks the Owner session (requireOwner), /api/public/media checks
// isPublicMediaKey; both hand the key to serveMedia.
const store = new MemoryMediaStore();
const req = (headers: Record<string, string> = {}) => new Request('http://127.0.0.1:3100/x', { headers });

beforeAll(async () => {
  await store.put({ key: 'media/p1/s1/final-v1.mp4', data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), contentType: 'video/mp4' });
  await store.put({ key: 'media/p1/s1/cover-v1.svg', data: '<svg xmlns="http://www.w3.org/2000/svg"/>', contentType: 'image/svg+xml' });
});

describe('media file serving', () => {
  it('serves files with strict headers and byte ranges for video seeking', async () => {
    const full = await serveMedia(req(), store, 'media/p1/s1/final-v1.mp4', { public: false });
    expect(full.status).toBe(200);
    expect(full.headers.get('content-type')).toBe('video/mp4');
    expect(full.headers.get('x-content-type-options')).toBe('nosniff');
    expect(full.headers.get('cache-control')).toMatch(/^private/);
    const part = await serveMedia(req({ range: 'bytes=2-5' }), store, 'media/p1/s1/final-v1.mp4', { public: false });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 2-5/10');
    expect([...new Uint8Array(await part.arrayBuffer())]).toEqual([3, 4, 5, 6]);
    const tail = await serveMedia(req({ range: 'bytes=-3' }), store, 'media/p1/s1/final-v1.mp4', { public: false });
    expect([...new Uint8Array(await tail.arrayBuffer())]).toEqual([8, 9, 10]);
    expect((await serveMedia(req({ range: 'bytes=40-' }), store, 'media/p1/s1/final-v1.mp4', { public: false })).status).toBe(416);
    // SVG covers can't run script when opened directly.
    const svg = await serveMedia(req(), store, 'media/p1/s1/cover-v1.svg', { public: false });
    expect(svg.headers.get('content-security-policy')).toMatch(/sandbox/);
  });

  it('refuses traversal and missing keys; public serving is only for public/… keys', async () => {
    expect((await serveMedia(req(), store, keyFrom(['media', '..', 'secrets']), { public: false })).status).toBe(404);
    expect((await serveMedia(req(), store, 'media/p1/missing.mp4', { public: false })).status).toBe(404);
    expect(keyFrom(['media', 'p1', 'a%20b.mp4'])).toBe('media/p1/a b.mp4');
    expect(isPublicMediaKey('public/nora/cover.jpg')).toBe(true);
    expect(isPublicMediaKey('media/p1/s1/final-v1.mp4')).toBe(false);
    expect(isPublicMediaKey(keyFrom(['public', '..', 'media', 'x.mp4']))).toBe(false);
  });
});
