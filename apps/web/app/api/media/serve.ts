import type { MediaStore } from '@troupe/providers';
import { isValidMediaKey } from '@troupe/providers';

/**
 * Serves one stored media file (stream E): byte ranges for video seeking, a strict content type, no sniffing, and
 * private caching for Owner files. Keys are validated before the store is touched.
 */
export async function serveMedia(req: Request, store: MediaStore, key: string, opts: { public: boolean }): Promise<Response> {
  if (!isValidMediaKey(key)) return new Response('not found', { status: 404 });
  const obj = await store.get(key);
  if (!obj) return new Response('not found', { status: 404 });
  const size = obj.data.byteLength;
  const headers: Record<string, string> = {
    'Content-Type': obj.contentType,
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': opts.public ? 'public, max-age=3600' : 'private, max-age=300',
    // SVG covers render as images only; never as a document that could run script.
    'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') ?? '');
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    let end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
    start = Math.max(0, start);
    end = Math.max(start, end);
    return new Response(new Blob([obj.data.slice(start, end + 1) as Uint8Array<ArrayBuffer>]), { status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) } });
  }
  return new Response(new Blob([obj.data as Uint8Array<ArrayBuffer>]), { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
}

export const keyFrom = (parts: readonly string[]): string => parts.map((p) => decodeURIComponent(p)).join('/');
