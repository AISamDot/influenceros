import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '@ios/db';
import { createTestDb } from '@ios/db/testing';
import { listPendingApprovals, personaPage, studioWall } from '../src';
import { seed, type SeedSummary } from '../src/seed';

let db: Db;
let s: SeedSummary;
const NOW = new Date('2026-10-14T12:00:00Z'); // a Wednesday

beforeAll(async () => {
  db = await createTestDb();
  s = await seed(db, { now: NOW });
});
afterAll(async () => db.close());

const BIBLE_SECTIONS = [
  'identity', 'character_lore', 'worldview', 'expertise_map', 'signature_frameworks', 'positions_on_debates',
  'news_beats', 'audience', 'voice', 'look', 'content_dna', 'engagement_style', 'products', 'community',
  'compliance', 'metrics',
];

describe('seed', () => {
  it('creates 5 personas: Testing ×3, Monetising ×1, Scaling ×1', () => {
    const states = s.personas.map((p) => p.state).sort();
    expect(states).toEqual(['MONETISING', 'SCALING', 'TESTING', 'TESTING', 'TESTING']);
  });

  it('gives every persona a deep profile with all Appendix A sections', async () => {
    const rows = await db.query<{ content: Record<string, unknown> }>('SELECT content FROM persona_bible');
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(Object.keys(r.content).sort()).toEqual([...BIBLE_SECTIONS].sort());
  });

  it('plans 10 slots this week per persona with the format and purpose mix', async () => {
    for (const p of s.personas) {
      const page = await personaPage(db, p.slug, NOW);
      const slots = page!.week.days.flatMap((d) => d.slots);
      expect(slots).toHaveLength(10);
      const by = (k: 'format' | 'purpose') => slots.reduce<Record<string, number>>((acc, x) => ({ ...acc, [x[k]]: (acc[x[k]] ?? 0) + 1 }), {});
      expect(by('format')).toEqual({ talking: 3, activity_text: 3, voiceover: 2, static: 1, carousel: 1 });
      const purpose = by('purpose');
      expect(purpose.reach).toBe(6);
      expect(purpose.trust).toBeGreaterThanOrEqual(2);
      expect(purpose.trust).toBeLessThanOrEqual(3);
      expect(purpose.sell).toBeGreaterThanOrEqual(1);
      expect(purpose.sell).toBeLessThanOrEqual(2);
      expect(slots.every((x) => x.thumbnail_url?.startsWith('data:image/svg+xml'))).toBe(true);
    }
  });

  it('has exactly one pending kill proposal, listed first, plus a 24 h card', async () => {
    const pending = await listPendingApprovals(db, s.studioId);
    expect(pending[0]).toMatchObject({ kind: 'persona_kill', persona_slug: 'theo', mode: 'explicit' });
    expect(pending.filter((a) => a.kind === 'persona_kill')).toHaveLength(1);
    expect(pending.some((a) => a.kind === 'product_v1' && a.mode === 'auto_after')).toBe(true);
  });

  it('feeds the studio wall: sparklines, next 3 posts, kill flag', async () => {
    const cards = await studioWall(db, s.studioId, NOW);
    expect(cards).toHaveLength(5);
    for (const c of cards) {
      expect(c.series.views).toHaveLength(7);
      expect(c.next).toHaveLength(3);
      expect(c.persona.portrait_url).toMatch(/^data:image\/svg\+xml/);
    }
    expect(cards.filter((c) => c.killProposed).map((c) => c.persona.slug)).toEqual(['theo']);
    const amos = cards.find((c) => c.persona.slug === 'amos')!;
    expect(amos.totals.revenue7dCents).toBeGreaterThan(0);
  });
});
