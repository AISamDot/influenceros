import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AI_FLAG_FIELDS, createFakeProviders, FAKE_WEBHOOK_SECRET, isPublicMediaKey, isValidMediaKey, LocalMediaStore, MemoryMediaStore, mediaUrl } from '../src';

describe('IOS-3/4 provider contracts', () => {
  it('validates media keys and serves only public/ keys publicly', () => {
    expect(isValidMediaKey('media/p1/s1/final.mp4')).toBe(true);
    for (const bad of ['../x', 'a/../b', '/abs', 'a//b', 'a/./b', '', 'a b', 'a\\b']) expect(isValidMediaKey(bad)).toBe(false);
    expect(isPublicMediaKey('public/rosa/cover.jpg')).toBe(true);
    expect(isPublicMediaKey('media/p1/final.mp4')).toBe(false);
    expect(mediaUrl('media/p1/final.mp4')).toBe('/api/media/media/p1/final.mp4');
    expect(mediaUrl('public/rosa/cover.jpg')).toBe('/api/public/media/public/rosa/cover.jpg');
  });

  it('stores media in memory and on disk', async () => {
    const mem = new MemoryMediaStore();
    const o = await mem.put({ key: 'media/p1/a.txt', data: 'hello', contentType: 'text/plain' });
    expect(o).toMatchObject({ key: 'media/p1/a.txt', bytes: 5, contentType: 'text/plain' });
    const path = await mem.localPath('media/p1/a.txt');
    expect(path && readFileSync(path, 'utf8')).toBe('hello');
    expect(await mem.get('nope')).toBeNull();

    const dir = mkdtempSync(join(tmpdir(), 'troupe-store-'));
    try {
      const disk = new LocalMediaStore(dir);
      const src = join(dir, 'src.bin');
      writeFileSync(src, Buffer.from([1, 2, 3]));
      await disk.putFile({ key: 'products/p1/v1/a4.pdf', filePath: src, contentType: 'application/pdf' });
      expect(await disk.get('products/p1/v1/a4.pdf')).toEqual({ data: new Uint8Array([1, 2, 3]), contentType: 'application/pdf' });
      expect(await disk.localPath('products/p1/v1/a4.pdf')).toBe(join(dir, 'products', 'p1', 'v1', 'a4.pdf'));
      await expect(disk.put({ key: '../escape', data: 'x', contentType: 'text/plain' })).rejects.toThrow(/invalid media key/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fakes cover the new members: uploads, comments, DMs, metrics, webhooks, stores, audiences', async () => {
    const p = createFakeProviders();
    expect(AI_FLAG_FIELDS).toMatchObject({ tiktok: 'video_made_with_ai', instagram: 'is_ai_generated', youtube: 'containsSyntheticMedia' });
    expect((await p.imageVideo.upload({ filePath: '/tmp/x.png' })).url).toMatch(/^https:\/\/fake\.higgsfield\.local\/uploads\//);
    expect((await p.publish.uploadMedia({ filePath: '/tmp/x.mp4', contentType: 'video/mp4' })).mediaUrl).toMatch(/fake\.zernio/);
    expect(await p.publish.hideComment({ externalId: 'e1', commentId: 'c1' })).toEqual({ ok: true });
    const m1 = await p.publish.fetchMetrics({ externalId: 'e1', platform: 'tiktok' });
    expect(m1).toEqual(await p.publish.fetchMetrics({ externalId: 'e1', platform: 'tiktok' }));
    expect(m1.views).toBeGreaterThan(0);
    const body = JSON.stringify({ type: 'post_status', externalId: 'e1', status: 'live', url: null });
    expect(p.publish.verifyWebhook(body, p.publish.sign(body))).toBe(true);
    expect(p.publish.verifyWebhook(body, 'zz')).toBe(false);
    expect(p.publish.parseWebhook(body)).toHaveLength(1);
    expect((await p.store.createCheckout({ storeId: 's1', variantId: 'v1', customData: { post_id: 'x' } })).url).toMatch(/checkout/);
    expect(await p.store.createDiscount({ storeId: 's1', code: 'ROSA10', percent: 10 })).toMatchObject({ code: 'ROSA10' });
    const a = await p.audience.ensureAudience({ name: 'rosa' });
    expect(await p.audience.ensureAudience({ name: 'rosa' })).toEqual(a);
    const ev = JSON.stringify({ type: 'opened', emailId: 'em1', to: 'x@example.com', at: '2026-10-16T00:00:00Z' });
    expect(p.audience.verifyWebhook(ev, { 'svix-signature': p.audience.sign(ev) })).toBe(true);
    expect(p.audience.parseWebhook(ev)[0]!.type).toBe('opened');
    expect(FAKE_WEBHOOK_SECRET).toBeTruthy();
  });
});
