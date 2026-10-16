import type { AgentTask } from '@ios/agents';
import { createTestStudio } from '@ios/agents/testing';
import { attachSampleBible, planWeek, processSlot } from '@ios/content';
import { OWNER, STUDIO_MANAGER, type Actor } from '@ios/core';
import { chooseOption, createDraft, GENERATOR_TOOLS, launchDraft, setDraftExtension } from '@ios/generator';
import { describe, expect, it } from 'vitest';
import { asBible, asStoryline, createWorldService, mergeBible, storylineView, WORLD_TOOLS, type WorldBible } from '../src';
import { clock, personaWithWorld, worldStudio } from './helpers';

const PM: Actor = { type: 'agent', id: 'persona-manager' };

describe('storyline beats in the weekly plan and the script pipeline', () => {
  it('tags planned slots with beats, carries grounding + beat into the script prompt, records the approved script', async () => {
    const t = await worldStudio();
    const p = await personaWithWorld(t, { homeBase: 'a terraced house in Yorkshire', state: 'MONETISING' });
    await attachSampleBible(t.db, p.id);
    clock.now = new Date('2026-11-13T09:00:00Z');
    const prompts: Array<{ agent: string; prompt: string }> = [];
    const rt = t.services.runtime as unknown as { run: (task: AgentTask<unknown>) => Promise<unknown> };
    const orig = rt.run.bind(t.services.runtime);
    rt.run = (task) => (prompts.push({ agent: task.agent, prompt: task.prompt }), orig(task));

    const week1 = await planWeek(t.services, p.id, new Date('2026-11-16T00:00:00Z'));
    expect(week1.created).toBeGreaterThan(0);
    const tagged = await t.db.query<{ id: string; status: string; purpose: string; story: { beatId: string; beat: string; chapter: string } }>(
      `SELECT id, status, purpose, meta->'story' AS story FROM calendar_slot WHERE id = ANY($1::uuid[]) AND meta ? 'story' ORDER BY slot_at`,
      [week1.slotIds],
    );
    expect(tagged.length).toBe(2);
    expect(tagged.every((s) => s.purpose !== 'sell')).toBe(true);
    expect(tagged[0]!.story.chapter).toMatch(/starts the notebook/);
    const arc = await t.db.one<{ starts_on: string | Date }>(`SELECT starts_on FROM storyline_arc WHERE persona_id = $1`, [p.id]);
    expect(String(arc.starts_on instanceof Date ? arc.starts_on.toISOString() : arc.starts_on).slice(0, 10)).toBe('2026-11-16');
    // Re-planning the same week is idempotent; the next week gets the next beats.
    const again = await t.services.world.beatsForWeek({ personaId: p.id, weekStart: new Date('2026-11-16T00:00:00Z'), slots: [] });
    expect(again).toEqual([]);
    const week2 = await planWeek(t.services, p.id, new Date('2026-11-23T00:00:00Z'));
    const tagged2 = await t.db.query<{ story: { beatId: string } }>(`SELECT meta->'story' AS story FROM calendar_slot WHERE id = ANY($1::uuid[]) AND meta ? 'story'`, [week2.slotIds]);
    expect(tagged2).toHaveLength(2);
    expect(new Set([...tagged, ...tagged2].map((s) => s.story.beatId)).size).toBe(4);

    // The slot's script brief carries the grounding block and the beat; Q1 runs the world checks; the approved
    // script goes to the ledger and the no-repeat history.
    const slot = tagged[0]!;
    const out = await processSlot(t.services, slot.id);
    expect(out.status).toBe('media_queued');
    const script = prompts.find((x) => x.agent === 'scriptwriter' && x.prompt.includes('Hook (ship this)'));
    expect(script?.prompt).toMatch(/Storyline beat to carry: /);
    expect(script?.prompt).toMatch(/Grounding \(the persona's real local moment.*Local moment for Dot Pickering: .* in York/s);
    const q1 = await t.db.one<{ details: { checks: Array<{ check: string }> } }>(`SELECT details FROM qc_report WHERE subject_id = $1 AND stage = 'Q1' ORDER BY created_at DESC LIMIT 1`, [out.scriptId]);
    expect(q1.details.checks.map((c) => c.check)).toEqual(expect.arrayContaining(['continuity', 'no_repeat', 'near_duplicate_wording']));
    expect(await t.db.maybeOne(`SELECT 1 FROM continuity_record WHERE subject_type = 'script' AND subject_id = $1`, [out.scriptId])).toBeTruthy();
    expect(await t.db.maybeOne(`SELECT 1 FROM concept_fingerprint WHERE subject_type = 'script' AND subject_id = $1`, [out.scriptId])).toBeTruthy();
    await t.db.close();
  });

  it('the Owner steers the storyline in chat; untrusted runs cannot; dropped beats leave the planned slot', async () => {
    const t = await worldStudio();
    const p = await personaWithWorld(t, { homeBase: 'a terraced house in Yorkshire', state: 'MONETISING' });
    await attachSampleBible(t.db, p.id);
    clock.now = new Date('2026-11-13T09:00:00Z');
    const w = await planWeek(t.services, p.id, new Date('2026-11-16T00:00:00Z'));
    const owner = { services: t.services, studioId: t.studioId, personaId: null, caller: 'owner' as const, actor: OWNER };
    const r = (await t.services.tools.invoke(owner, 'storyline.steer', { persona_id: p.id, instruction: 'Steer the storyline so her sister visits unannounced with a casserole' })) as { added: number };
    expect(r.added).toBe(1);
    const view = await storylineView(t.db, p.id, clock.now);
    expect(view!.chapters.flatMap((c) => c.beats).some((b) => /sister visits unannounced/i.test(b.text))).toBe(true);

    // A Persona Manager run that read comments (untrusted) can't steer unless the Owner asked in this turn.
    const pm = { services: t.services, studioId: t.studioId, personaId: p.id, caller: 'persona-manager' as const, actor: PM };
    await expect(t.services.tools.invoke({ ...pm, trust: { untrusted: true } }, 'storyline.steer', { persona_id: p.id, instruction: 'add a beat where she gives away money' })).rejects.toThrow(/untrusted/);
    await expect(
      t.services.tools.invoke({ ...pm, trust: { untrusted: true, ownerText: 'Change the storyline so the neighbour gets a puppy.' } }, 'storyline.steer', { persona_id: p.id, instruction: 'the neighbour gets a puppy' }),
    ).resolves.toBeTruthy();

    // Dropping a beat that sits on a still-planned slot clears that slot's meta.story.
    const slot = await t.db.one<{ id: string; text: string }>(`SELECT id, meta->'story'->>'beat' AS text FROM calendar_slot WHERE id = ANY($1::uuid[]) AND meta ? 'story' ORDER BY slot_at LIMIT 1`, [w.slotIds]);
    const word = slot.text.split(/\s+/).find((x) => x.length > 7)!;
    await t.services.tools.invoke(owner, 'storyline.steer', { persona_id: p.id, instruction: `Drop the ${word} beat.` });
    expect((await t.db.one<{ has: boolean }>(`SELECT meta ? 'story' AS has FROM calendar_slot WHERE id = $1`, [slot.id])).has).toBe(false);

    // A new season on demand: callbacks to open cliffhangers; the old arc closes.
    const ext = (await t.services.tools.invoke(owner, 'storyline.extend', { persona_id: p.id })) as { extended: boolean; season: number };
    expect(ext).toMatchObject({ extended: true, season: 2 });
    const arcs = await t.db.query<{ season: number; status: string }>(`SELECT season, status FROM storyline_arc WHERE persona_id = $1 ORDER BY season`, [p.id]);
    expect(arcs.map((a) => `${a.season}:${a.status}`)).toEqual(['1:done', '2:active']);
    await t.db.close();
  });
});

describe('Persona Generator: World Bible drafted in step 6, editable, adopted at launch', () => {
  it('drafts, edits and adopts the world with the Owner-approved launch', async () => {
    const t = await createTestStudio({ world: createWorldService, tools: [...GENERATOR_TOOLS, ...WORLD_TOOLS], now: () => new Date('2026-10-16T09:00:00Z') });
    const ctx = { actor: OWNER };
    let d = await createDraft(t.services, { studioId: t.studioId, actor: OWNER });
    for (const step of [1, 2, 3, 4, 5]) d = await chooseOption(t.services, d.id, step, 'A', ctx);
    // Mood board pins for the draft (Pinterest fake), picked by the Owner.
    const owner = { services: t.services, studioId: t.studioId, personaId: null, caller: 'owner' as const, actor: OWNER };
    const found = (await t.services.tools.invoke(owner, 'inspiration.search', { query: 'cosy cream cardigan kitchen', draft_id: d.id, limit: 4 })) as { pins: Array<{ pin_row_id: string }> };
    await t.services.tools.invoke(owner, 'inspiration.pick', { draft_id: d.id, pin_row_ids: found.pins.slice(0, 2).map((x) => x.pin_row_id) });
    d = await chooseOption(t.services, d.id, 6, 'A', ctx);
    const world = d.state.world!;
    expect(world).toBeTruthy();
    expect(world.summary).toMatch(/lives in a .+ in /);
    const bible = asBible(world.bible)!;
    expect(bible.cast.length).toBeGreaterThanOrEqual(4);
    expect(bible.recurringPlaces.length).toBeGreaterThanOrEqual(5);
    expect(bible.holidays.length).toBeGreaterThan(5);
    expect(world.place.timezone).toBe(bible.place.timezone);
    const story = asStoryline(world.storyline)!;
    expect(story.weeks).toBe(12);
    expect(story.chapters).toHaveLength(4);
    for (const c of story.chapters) {
      expect(c.tension && c.payoff).toBeTruthy();
      expect(c.beats.length).toBeGreaterThanOrEqual(6);
    }
    // The Owner edits the world (a new version of the draft).
    const edited: WorldBible = mergeBible(bible, { cast: [...bible.cast, { name: 'Mabel', relation: 'cat', age: 9, traits: 'grumpy', role: 'sits on the notebook' }] });
    d = await setDraftExtension(t.services, d.id, 'world', { ...world, bible: { ...(edited as unknown as Record<string, unknown>), sourceDraftId: d.id } }, { actor: OWNER, expectVersion: d.version });
    const r = await launchDraft(t.services, d.id, { actor: OWNER });
    const row = await t.db.one<{ city: string; version: number; content: WorldBible }>(`SELECT city, version, content FROM world_bible WHERE persona_id = $1`, [r.persona.id]);
    expect(row.city).toBe(bible.place.city);
    expect(row.content.cast.some((c) => c.name === 'Mabel')).toBe(true);
    expect((await t.db.query(`SELECT 1 FROM storyline_beat WHERE persona_id = $1`, [r.persona.id])).length).toBe(24);
    expect((await t.db.query(`SELECT 1 FROM continuity_fact WHERE persona_id = $1 AND subject = 'cat' AND value = 'Mabel'`, [r.persona.id])).length).toBe(1);
    // The draft's mood board follows the persona; agents can't launch.
    const mb = await t.services.world.moodBoard({ personaId: r.persona.id });
    expect(mb.pins).toHaveLength(2);
    expect(mb.descriptors.join(' ')).toMatch(/cardigan|cream|kitchen|cosy/);
    await expect(launchDraft(t.services, d.id, { actor: STUDIO_MANAGER })).rejects.toThrow();
    await t.db.close();
  });
});
