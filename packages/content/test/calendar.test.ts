import { type CadencePolicy, CADENCE_BOUNDS, DEFAULT_CADENCE } from '@ios/agents';
import { createTestStudio, makeTestPersona } from '@ios/agents/testing';
import { json } from '@ios/db';
import { describe, expect, it } from 'vitest';
import { assignMix, bookReactionIdeas, effectiveCadence, normaliseCadence, planWeek, postingTimes, WINNER_CADENCE } from '../src/calendar';
import { fakeHooks, HOOK_TYPES, parseHooks, scoreHook, selectHooks } from '../src/hooks';
import { loadPersonaContext } from '../src/persona';
import { attachSampleBible } from '../src/sample';
import { schedules } from '../src/jobs';
import { tzOffsetMs } from '../src/util';

const NOW = new Date('2026-10-14T10:00:00Z'); // a Wednesday
const NEXT_MONDAY = new Date('2026-10-19T00:00:00Z');

type SlotRow = { slot_at: Date; format: string; purpose: string; pillar: string | null; title: string; cta_keyword: string | null; posting_window: string; product_id: string | null; status: string; idea_id: string | null };
const slotsOf = (db: { query: <T>(q: string, p: unknown[]) => Promise<T[]> }, personaId: string) =>
  db.query<SlotRow>(`SELECT slot_at, format, purpose, pillar, title, cta_keyword, posting_window, product_id, status, idea_id FROM calendar_slot WHERE persona_id = $1 ORDER BY slot_at`, [personaId]);
const tally = (rows: Array<Record<string, unknown>>, key: string) => rows.reduce<Record<string, number>>((a, r) => ({ ...a, [String(r[key])]: (a[String(r[key])] ?? 0) + 1 }), {});
const localHour = (d: Date, tz: string) => {
  const local = new Date(new Date(d).getTime() + tzOffsetMs(new Date(d), tz));
  return local.getUTCHours() + local.getUTCMinutes() / 60;
};
const isoDateOf = (d: Date) => new Date(d).toISOString().slice(0, 10);
const localDay = (d: Date, tz: string) => new Date(new Date(d).getTime() + tzOffsetMs(new Date(d), tz)).toISOString().slice(0, 10);

describe('weekly calendar', () => {
  it('plans 10 posts with the 3/3/2/1/1 format mix, ~6/3/1 purposes, a CTA keyword on each and posting windows in local time', async () => {
    const t = await createTestStudio({ now: () => NOW });
    const p = await makeTestPersona(t, { timezone: 'America/New_York' });
    await attachSampleBible(t.db, p.id);
    const res = await planWeek(t.services, p.id, NEXT_MONDAY);
    expect(res.created).toBe(10);
    const rows = await slotsOf(t.db, p.id);
    expect(tally(rows, 'format')).toEqual({ talking: 3, activity_text: 3, voiceover: 2, static: 1, carousel: 1 });
    expect(tally(rows, 'purpose')).toEqual({ reach: 6, trust: 3, sell: 1 });
    for (const r of rows) {
      expect(r.cta_keyword).toMatch(/^[A-Z]{3,12}$/);
      expect(r.status).toBe('planned');
      expect(r.idea_id).toBeTruthy();
      const h = localHour(r.slot_at, 'America/New_York');
      const window = r.posting_window === 'morning' ? [7.5, 8.2] : r.posting_window === 'midday' ? [12.25, 12.9] : [19, 19.6];
      expect(h).toBeGreaterThanOrEqual(window[0]!);
      expect(h).toBeLessThanOrEqual(window[1]!);
    }
    // One a day, then a second on the strongest days; never more than 3 a day; every day of the week covered.
    const perDay = Object.values(tally(rows.map((r) => ({ d: localDay(r.slot_at, 'America/New_York') })), 'd'));
    expect(perDay).toHaveLength(7);
    expect(Math.max(...perDay)).toBe(2);
    // Titles are unique and pillar-based; the sell slot is in the Products pillar.
    expect(new Set(rows.map((r) => r.title.toLowerCase())).size).toBe(10);
    expect(rows.find((r) => r.purpose === 'sell')?.pillar).toBe('Products');
    expect(rows.filter((r) => r.purpose !== 'sell').every((r) => ['Money systems', 'Budget basics', 'Frugal living', 'Money mindset'].includes(r.pillar!))).toBe(true);
    // Idempotent: the week is already planned.
    expect((await planWeek(t.services, p.id, NEXT_MONDAY)).skipped).toBe('week already planned');
    expect(await slotsOf(t.db, p.id)).toHaveLength(10);
    await t.db.close();
  });

  it('scales winners to 2–3 posts a day (FR-4.3), and takes a lever target as given within bounds', async () => {
    expect(effectiveCadence(DEFAULT_CADENCE, 'SCALING')).toBe(WINNER_CADENCE);
    expect(effectiveCadence(DEFAULT_CADENCE, 'TESTING')).toBe(DEFAULT_CADENCE);
    const lever = { ...DEFAULT_CADENCE, postsPerWeek: 30, source: 'lever' as const };
    const n = normaliseCadence(lever);
    expect(n.postsPerWeek).toBe(CADENCE_BOUNDS.max);
    expect(Object.values(n.formatMix).reduce((a, b) => a + b, 0)).toBe(21);
    expect(Object.values(n.purposeMix).reduce((a, b) => a + b, 0)).toBe(21);
    expect(assignMix(normaliseCadence(DEFAULT_CADENCE)).filter((x) => x.purpose === 'sell').map((x) => x.format)).toEqual(['talking']);

    const t = await createTestStudio({ now: () => NOW });
    const winner = await makeTestPersona(t, { state: 'SCALING', timezone: 'Asia/Dubai' });
    await attachSampleBible(t.db, winner.id);
    const res = await planWeek(t.services, winner.id, NEXT_MONDAY);
    expect(res.created).toBe(17);
    const rows = await slotsOf(t.db, winner.id);
    expect(tally(rows, 'format')).toEqual({ talking: 5, activity_text: 5, voiceover: 3, static: 2, carousel: 2 });
    const perDay = Object.values(tally(rows.map((r) => ({ d: localDay(r.slot_at, 'Asia/Dubai') })), 'd'));
    expect(Math.min(...perDay)).toBeGreaterThanOrEqual(2);
    expect(Math.max(...perDay)).toBe(3);
    await t.db.close();

    // A D lever (or Owner) target wins over the winner default.
    const fixed: CadencePolicy = { target: async () => ({ ...DEFAULT_CADENCE, postsPerWeek: 7, formatMix: { talking: 2, activity_text: 2, voiceover: 1, static: 1, carousel: 1 }, purposeMix: { reach: 4, trust: 2, sell: 1 }, source: 'lever' }) };
    const t2 = await createTestStudio({ now: () => NOW, cadence: () => fixed });
    const w2 = await makeTestPersona(t2, { state: 'SCALING' });
    expect((await planWeek(t2.services, w2.id, NEXT_MONDAY)).created).toBe(7);
    await t2.db.close();
  });

  it('skips windows already past and less than 2 h away when planning the current week', () => {
    const times = postingTimes(new Date('2026-10-12T00:00:00Z'), 10, 'UTC', { now: NOW, seed: 'x' });
    expect(times.every((x) => x.at.getTime() >= NOW.getTime() + 2 * 3_600_000)).toBe(true);
    expect(times.length).toBe(10); // Wed evening → Sun: 5 days × up to 3
  });

  it('books sell slots in Monetization Agent order and picks up News Desk reaction ideas first', async () => {
    const t = await createTestStudio({ now: () => NOW });
    const p = await makeTestPersona(t);
    await attachSampleBible(t.db, p.id);
    const sheet = await t.db.one<{ id: string }>(
      `INSERT INTO product (persona_id, name, slug, ladder_rung, status, price_cents, cta_keyword) VALUES ($1, 'Zero-Based Budget Sheet', 'zbb', 'entry', 'live', 1200, 'SHEET') RETURNING id`,
      [p.id],
    );
    await t.db.query(
      `INSERT INTO idea (persona_id, title, purpose, source, status) VALUES ($1, 'What the new rent data means for a $3K budget', 'reach', $2::jsonb, 'new')`,
      [p.id, json({ type: 'news', news_item_id: 'n1', briefing_date: '2026-10-18', expires_at: '2026-10-21T00:00:00Z' })],
    );
    await planWeek(t.services, p.id, NEXT_MONDAY);
    const rows = await slotsOf(t.db, p.id);
    const sell = rows.find((r) => r.purpose === 'sell')!;
    expect(sell).toMatchObject({ product_id: sheet.id, cta_keyword: 'SHEET', title: 'Walkthrough: Zero-Based Budget Sheet' });
    const news = rows.find((r) => r.title.startsWith('What the new rent data'))!;
    expect(new Date(news.slot_at).getTime()).toBeLessThan(new Date('2026-10-21T00:00:00Z').getTime());
    expect((await t.db.one<{ status: string }>(`SELECT status FROM idea WHERE title LIKE 'What the new rent%'`)).status).toBe('booked');
    await t.db.close();
  });

  it('keeps a west-of-UTC Sunday evening in its own week, so the next week still gets planned', async () => {
    const t = await createTestStudio({ now: () => new Date('2026-10-28T10:00:00Z') });
    const p = await makeTestPersona(t, { timezone: 'America/New_York' });
    await attachSampleBible(t.db, p.id);
    const first = await planWeek(t.services, p.id, new Date('2026-11-02T00:00:00Z'));
    expect(first.created).toBe(10);
    const last = (await slotsOf(t.db, p.id)).at(-1)!;
    expect(new Date(last.slot_at).getTime()).toBeGreaterThanOrEqual(new Date('2026-11-09T00:00:00Z').getTime()); // Sun 19:xx EST
    const second = await planWeek(t.services, p.id, new Date('2026-11-09T00:00:00Z'));
    expect(second.skipped).toBeUndefined();
    expect(second.created).toBe(10);
    const plan = schedules.find((s) => s.name === 'calendar.weekly_plan')!;
    expect(await plan.run(t.services, new Date('2026-11-12T10:00:00Z'))).toEqual({ queued: 1 }); // only the week of Nov 16
    await t.db.close();
  });

  it('books a fresh News Desk reaction into a week that is already planned, before the idea expires', async () => {
    const t = await createTestStudio({ now: () => NOW });
    const p = await makeTestPersona(t);
    await attachSampleBible(t.db, p.id);
    expect((await planWeek(t.services, p.id, NOW)).created).toBeGreaterThan(0);
    // The briefing lands after the week was planned; replanning does nothing.
    const expires = new Date(NOW.getTime() + 48 * 3_600_000);
    const addIdea = (title: string, id: string) =>
      t.db.one<{ id: string }>(
        `INSERT INTO idea (persona_id, title, pillar, format, purpose, source, status) VALUES ($1, $2, 'News reaction', 'talking', 'reach', $3::jsonb, 'new') RETURNING id`,
        [p.id, title, json({ type: 'news', news_item_id: id, briefing_date: '2026-10-14', expires_at: expires.toISOString() })],
      );
    const a = await addIdea('The new CPI print, in plain English', 'n1');
    const b = await addIdea('Why the Fed pause matters for your savings', 'n2');
    expect((await planWeek(t.services, p.id, NOW)).skipped).toBe('week already planned');

    const advance = schedules.find((s) => s.name === 'pipeline.advance')!;
    const res = (await advance.run(t.services, NOW)) as { queued: number; reactions?: number };
    expect(res.reactions).toBe(1); // one per persona per run
    const slot = await t.db.one<{ slot_at: Date; title: string; status: string; purpose: string; idea_id: string }>(
      `SELECT slot_at, title, status, purpose, idea_id FROM calendar_slot WHERE idea_id = ANY($1::uuid[])`,
      [[a.id, b.id]],
    );
    const [first, other] = slot.idea_id === a.id ? [a, b] : [b, a];
    expect(slot.title).toBe(first === a ? 'The new CPI print, in plain English' : 'Why the Fed pause matters for your savings');
    expect(['reach', 'trust']).toContain(slot.purpose);
    expect(new Date(slot.slot_at).getTime()).toBeGreaterThan(NOW.getTime());
    expect(new Date(slot.slot_at).getTime()).toBeLessThanOrEqual(expires.getTime());
    expect((await t.db.one<{ status: string }>(`SELECT status FROM idea WHERE id = $1`, [first.id])).status).toBe('booked');
    expect((await t.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM job WHERE kind = 'pipeline.slot' AND payload->>'slotId' = (SELECT id::text FROM calendar_slot WHERE idea_id = $1)`, [first.id])).n).toBe(1);

    // The next run books the other idea on a different day (one reaction a day).
    const second = await bookReactionIdeas(t.services, { now: NOW });
    expect(second.map((r) => r.ideaId)).toEqual([other.id]);
    expect(isoDateOf(second[0]!.slotAt)).not.toBe(isoDateOf(slot.slot_at));
    expect(await bookReactionIdeas(t.services, { now: NOW })).toEqual([]);
    await t.db.close();
  });

  it('plans nothing for personas that are not publishing', async () => {
    const t = await createTestStudio({ now: () => NOW });
    const p = await makeTestPersona(t, { state: 'KILLED' });
    expect((await planWeek(t.services, p.id, NEXT_MONDAY)).skipped).toBe('persona is KILLED');
    await t.db.close();
  });
});

describe('hook-lab', () => {
  it('writes 10 hooks across 10 types, scores them and ships 1 plus 2 A/B variants of other types', async () => {
    const t = await createTestStudio();
    const p = await makeTestPersona(t);
    await attachSampleBible(t.db, p.id);
    const ctx = await loadPersonaContext(t.db, p.id);
    const raw = fakeHooks('Sinking funds explained', ctx);
    expect(raw.map((h) => h.type)).toEqual([...HOOK_TYPES]);
    const scored = raw.map((h) => scoreHook(h, ctx));
    expect(scored.every((h) => h.score >= 0 && h.score <= 100 && h.reasons.length > 0)).toBe(true);
    const { shipped, variants } = selectHooks(scored);
    expect(shipped.score).toBe(Math.max(...scored.map((h) => h.score)));
    expect(variants).toHaveLength(2);
    expect(new Set([shipped.type, ...variants.map((v) => v.type)]).size).toBe(3);
    await t.db.close();
  });

  it('excludes non-compliant, banned and repeated hooks, and tires out an over-used type', () => {
    const ctx = { voice: { wpm: 160, lexicon: ['calm money'], avoid: [], catchphrases: [], energy: '' }, hookLibrary: [], bannedHooks: ['Income claims ("make $5K")'] };
    expect(scoreHook({ text: 'Make $5K a month with this budget', type: 'number' }, ctx).excluded).toMatch(/compliance: guaranteed_returns/);
    expect(scoreHook({ text: 'POV: payday feels calm', type: 'pov' }, ctx, ['POV: payday feels calm']).excluded).toBe('too close to a recent hook');
    const fresh = scoreHook({ text: 'POV: calm money on payday', type: 'pov' }, ctx);
    const tired = scoreHook({ text: 'POV: calm money on payday', type: 'pov' }, ctx, [], ['pov', 'pov']);
    expect(fresh.score - tired.score).toBe(10);
    expect(fresh.reasons).toContain('persona word "calm money"');
  });

  it('rejects a model reply with fewer than 10 hooks', () => {
    expect(() => parseHooks({ hooks: [{ text: 'x', type: 'pov' }] })).toThrow(/10 hooks/);
  });
});
