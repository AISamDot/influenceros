import { describe, expect, it } from 'vitest';
import { createFakeProviders, EMBEDDING_DIM, llmCostUsd } from '../src';

describe('IOS-2 provider fakes', () => {
  it('transcribes what the fake voice said (and can mishear)', async () => {
    const p = createFakeProviders({ mishear: (t) => t.replace('budget', 'budge it') });
    const audio = await p.voice.tts({ voiceId: 'v', text: 'Make a budget you can keep' });
    const t = await p.transcribe.transcribe({ audioUrl: audio.url });
    expect(t.text).toBe('Make a budge it you can keep');
    expect(t.words).toHaveLength(7);
    expect((await createFakeProviders().transcribe.transcribe({ audioUrl: 'https://x/unknown.mp3' })).text).toBe('');
  });

  it('embeds deterministically, unit length, EMBEDDING_DIM wide, with related texts closer', async () => {
    const p = createFakeProviders();
    const [a, b, c] = await p.embeddings.embed(['emergency fund savings', 'savings for an emergency fund', 'sourdough starter recipe']);
    const dot = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i]!, 0);
    expect(a).toHaveLength(EMBEDDING_DIM);
    expect(dot(a!, a!)).toBeCloseTo(1, 6);
    expect(dot(a!, b!)).toBeGreaterThan(dot(a!, c!));
    expect(await createFakeProviders().embeddings.embed(['emergency fund savings'])).toEqual([a]);
  });

  it('returns cited research and feed items', async () => {
    const p = createFakeProviders();
    const map = await p.webResearch.mapField({ niche: 'budgeting' });
    expect(map.curriculum.length).toBeGreaterThan(0);
    const topic = await p.webResearch.researchTopic({ niche: 'budgeting', path: map.curriculum[0]!.path, title: map.curriculum[0]!.title });
    expect(topic.facts.every((f) => f.citations.length > 0)).toBe(true);
    const items = await p.feeds.fetchFeed({ url: 'https://news.google.com/rss/search?q=budgeting', limit: 2 });
    expect(items).toHaveLength(2);
    expect(items[0]!.source).toBe('news.google.com');
  });

  it('prices cache reads below fresh input', () => {
    expect(llmCostUsd('standard', 0, 0, 1_000_000)).toBeLessThan(llmCostUsd('standard', 1_000_000, 0));
    expect(llmCostUsd('strong', 1_000_000, 1_000_000)).toBe(24);
  });
});
