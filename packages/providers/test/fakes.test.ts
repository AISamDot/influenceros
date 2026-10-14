import { describe, expect, it } from 'vitest';
import { createFakeProviders, FAKE_WEBHOOK_SECRET, FakeLemonSqueezy, higgsfieldCredits } from '../src';

describe('provider fakes', () => {
  it('are deterministic and record their calls', async () => {
    const a = createFakeProviders();
    const b = createFakeProviders();
    const req = { tier: 'standard' as const, messages: [{ role: 'user' as const, content: 'Plan the week' }] };
    const ra = await a.llm.complete(req);
    const rb = await b.llm.complete(req);
    expect(ra).toEqual(rb);
    expect(ra.costUsd).toBeGreaterThan(0);
    expect(a.llm.callsTo('complete')).toHaveLength(1);

    const s1 = await a.imageVideo.generateStill({ prompt: 'desk, morning light' });
    const s2 = await b.imageVideo.generateStill({ prompt: 'desk, morning light' });
    expect(s1.url).toBe(s2.url);
    expect(s1).toMatchObject({ width: 1080, height: 1920, credits: higgsfieldCredits('still') });
    expect(await a.imageVideo.costProbe({ operation: 'image_to_video', durationS: 8 })).toEqual({ credits: 12 });
  });

  it('publishes with the AI label, verifies, and can simulate failures', async () => {
    const p = createFakeProviders().publish;
    const req = { accountRef: 'acc', platform: 'tiktok' as const, mediaUrls: ['m.mp4'], caption: 'hi', aiLabel: true as const };
    p.failNext = 1;
    await expect(p.publish(req)).rejects.toThrow(/503/);
    const { externalId } = await p.publish(req);
    expect(await p.verify(externalId)).toMatchObject({ status: 'live', aiLabel: true });
    // Untyped callers can't skip the label.
    await expect(p.publish({ ...req, aiLabel: false } as never)).rejects.toThrow(/AI label/);
  });

  it('verifies store webhooks with HMAC', () => {
    const store = new FakeLemonSqueezy([], FAKE_WEBHOOK_SECRET);
    const body = JSON.stringify({ type: 'order_created', orderId: 'o1' });
    expect(store.verifyWebhook(body, store.sign(body))).toBe(true);
    expect(store.verifyWebhook(body, 'deadbeef')).toBe(false);
  });

  it('supports both talking backends', async () => {
    const fal = createFakeProviders({ talking: 'fal-kling-avatar' }).talking;
    const hf = createFakeProviders({ talking: 'higgsfield-seedance' }).talking;
    const req = { imageUrl: 'a.png', audioUrl: 'a.mp3', durationS: 30 };
    expect(await fal.render(req)).toMatchObject({ credits: 0 });
    expect((await hf.render(req)).credits).toBeGreaterThan(0);
  });
});
