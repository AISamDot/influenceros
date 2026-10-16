import { createTestStudio, makeTestPersona, type TestStudio } from '@ios/agents/testing';
import { afterEach, describe, expect, it } from 'vitest';
import * as radar from '../src';

const DAY = 86_400_000;
const NOW = new Date('2026-10-16T12:00:00Z');
let t: TestStudio | null = null;
afterEach(async () => {
  await t?.db.close();
  t = null;
});

async function livePost(personaId: string, daysAgo: number, views: number, saves: number, shares: number, title: string) {
  const { id: slot } = await t!.db.one<{ id: string }>(
    `INSERT INTO calendar_slot (persona_id, slot_at, format, purpose, title, status) VALUES ($1, $2, 'talking', 'reach', $3, 'live') RETURNING id`,
    [personaId, new Date(NOW.getTime() - daysAgo * DAY), title],
  );
  const { id } = await t!.db.one<{ id: string }>(
    `INSERT INTO post (persona_id, calendar_slot_id, platform, format, status, published_at, caption) VALUES ($1, $2, 'instagram', 'talking', 'live', $3, $4) RETURNING id`,
    [personaId, slot, new Date(NOW.getTime() - daysAgo * DAY), title],
  );
  await t!.db.query(`INSERT INTO metric_snapshot (persona_id, post_id, platform, captured_on, views, saves, shares) VALUES ($1, $2, 'instagram', $3, $4, $5, $6)`, [
    personaId,
    id,
    new Date(NOW.getTime() - (daysAgo - 1) * DAY).toISOString().slice(0, 10),
    views,
    saves,
    shares,
  ]);
  return id;
}

describe('internal winners → double down', () => {
  it('finds our posts beating the persona median by ≥ 2× on views and saves + shares, and books a double-down idea', async () => {
    t = await createTestStudio({ now: () => NOW, tools: radar.tools });
    const p = await makeTestPersona(t, { niche: 'personal finance', state: 'TESTING' });
    for (let i = 0; i < 8; i += 1) await livePost(p.id, 3 + i, 1_000, 15, 5, `Ordinary post ${i}`);
    const win = await livePost(p.id, 2, 3_000, 50, 20, 'The envelope method in 30 seconds');
    await livePost(p.id, 2, 3_000, 10, 2, 'Views but no saves');
    await livePost(p.id, 0.5, 9_000, 200, 50, 'Too fresh to judge');

    const winners = await radar.internalWinners(t.db, p.id, NOW);
    expect(winners.map((w) => w.post_id)).toEqual([win]);
    expect(winners[0]).toMatchObject({ title: 'The envelope method in 30 seconds', views_lift: 3 });

    const r = await radar.doubleDown(t.services, { personaId: p.id, winner: winners[0]! });
    expect(r.status).toBe('booked');
    const idea = await t.db.one<{ title: string; status: string; source: { type: string; variant: string; series: string } }>('SELECT title, status, source FROM idea WHERE id = $1', [r.ideaId]);
    expect(idea.status).toBe('new');
    expect(idea.source).toMatchObject({ type: 'double_down', variant: 'part_2', series: 'The envelope method in 30 seconds' });
    expect(idea.title).toBe('Part 2: The envelope method in 30 seconds');
    // Once per source post.
    expect((await radar.doubleDown(t.services, { personaId: p.id, winner: winners[0]! })).existing).toBe(true);
    // The weekly pass books nothing more for it.
    expect(await radar.weeklyRemix(t.services, p.id)).toEqual({ remixes: 0, doubleDowns: 0, blocked: 0 });
  });

  it('remix formats: optional formats fall back to their core shape unless the plan has them on; avatar formats validate first', () => {
    expect(radar.remixFormat('photo_dump', new Set())).toEqual({ format: 'carousel', target: 'carousel', validateFirst: false });
    expect(radar.remixFormat('photo_dump', new Set(['photo_dump']))).toEqual({ format: 'photo_dump', target: 'photo_dump', validateFirst: false });
    expect(radar.remixFormat('talking', new Set())).toEqual({ format: 'activity_text', target: 'talking', validateFirst: true });
    expect(radar.remixFormat('facecam_screen', new Set(['facecam_screen']))).toEqual({ format: 'activity_text', target: 'facecam_screen', validateFirst: true });
    expect(radar.remixFormat('static', new Set())).toEqual({ format: 'static', target: 'static', validateFirst: false });
    expect(radar.remixFormat(null, new Set()).format).toBe('activity_text');
  });
});
