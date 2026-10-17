import { createTestStudio, makeTestPersona } from '@troupe/agents/testing';
import { fingerprintOf, type ConceptFingerprint } from '@troupe/agents';
import { BudgetExceededError } from '@troupe/core';
import { describe, expect, it, vi } from 'vitest';
import { contradictions, createWorldService, extractFacts, seriesOf, WORLD_TOOLS } from '../src';
import { clock, personaWithWorld, worldStudio } from './helpers';

const failing = (checks: Array<{ check: string; pass: boolean; severity: string; message: string }>, name: string) => checks.filter((c) => c.check === name && !c.pass);

describe('fact extraction', () => {
  it('pulls people, pets, age, career, home, car and opinions out of first-person text', () => {
    const facts = extractFacts(
      "My sister Angie rang again. I'm 79 and I was a dinner lady for 41 years. I live in York. I've got a dog called Biscuit. I drive a Fiat Panda. I can't stand coupons, but I love crosswords. I'm 5 minutes late.",
    );
    const by = (k: string) => facts.filter((f) => f.kind === k).map((f) => `${f.subject}=${f.value}`);
    expect(by('person')).toEqual(['sister=Angie']);
    expect(by('pet')).toEqual(['dog=Biscuit']);
    expect(by('age')).toEqual(['self=79']);
    expect(by('event')).toEqual(['career years=41']);
    expect(by('place')).toEqual(['home=York']);
    expect(by('possession')).toEqual(['car=fiat panda']);
    expect(by('opinion').sort()).toEqual(['coupons=negative', 'crosswords=positive']);
  });
});

describe('the continuity ledger', () => {
  it('records facts from an approved script and a reply, then blocks "my sister Angie" → "my brother Angelo"', async () => {
    const t = await worldStudio();
    const p = await personaWithWorld(t, { homeBase: 'a terraced house in Yorkshire' });
    clock.now = new Date('2026-11-18T12:00:00Z');
    const scriptId = '11111111-1111-4111-8111-111111111111';
    await t.services.world.recordApproved({ studioId: t.studioId, personaId: p.id, subject: { type: 'script', id: scriptId }, text: 'My sister Angie thinks budgeting is boring. I love crosswords.', at: clock.now });
    // Idempotent per subject.
    await t.services.world.recordApproved({ studioId: t.studioId, personaId: p.id, subject: { type: 'script', id: scriptId }, text: 'My sister Angie thinks budgeting is boring. I love crosswords.', at: clock.now });
    const replyId = '22222222-2222-4222-8222-222222222222';
    await t.services.world.recordApproved({ studioId: t.studioId, personaId: p.id, subject: { type: 'reply', id: replyId }, text: "Ha! My dog Biscuit agrees with you.", at: clock.now });
    const ledger = await t.db.query<{ kind: string; subject: string; value: string; source_type: string }>(`SELECT kind, subject, value, source_type FROM continuity_fact WHERE persona_id = $1 AND source_type <> 'bible' ORDER BY created_at`, [p.id]);
    expect(ledger.map((f) => `${f.source_type}:${f.kind}:${f.subject}=${f.value}`)).toEqual(['script:person:sister=Angie', 'script:opinion:crosswords=positive', 'reply:pet:dog=Biscuit']);
    // The bible seeded the ledger too (age 79, 41 years, the cast, York).
    const seeded = await t.db.query<{ kind: string; value: string }>(`SELECT kind, value FROM continuity_fact WHERE persona_id = $1 AND source_type = 'bible'`, [p.id]);
    expect(seeded.map((f) => `${f.kind}:${f.value}`)).toEqual(expect.arrayContaining(['age:79', 'event:41', 'place:York']));

    const check = (text: string) => t.services.world.checkContent({ studioId: t.studioId, personaId: p.id, subject: { type: 'script', id: null }, text, at: clock.now });
    const angelo = failing(await check('My brother Angelo still thinks budgeting is boring.'), 'continuity');
    expect(angelo).toHaveLength(1);
    expect(angelo[0]).toMatchObject({ severity: 'major' });
    expect(angelo[0]!.message).toMatch(/Angelo.*Angie, your sister/);
    expect(failing(await check("I'm 64 and still learning."), 'continuity')[0]).toBeTruthy();
    expect(failing(await check('I was a dinner lady for 30 years.'), 'continuity')[0]).toBeTruthy();
    expect(failing(await check("Honestly, I hate crosswords."), 'continuity')[0]).toBeTruthy();
    expect(failing(await check('I live in Manchester these days.'), 'continuity')[0]).toBeTruthy();
    expect(failing(await check('My cat Biscuit knocked the jar over.'), 'continuity')[0]).toBeTruthy();
    // Consistent text passes; a new sibling with a different name is fine.
    expect(failing(await check("My sister Angie came round. I'm 79 and my sister Beth too."), 'continuity')).toEqual([]);
    // Re-checking the same script (a Q1 fix loop) doesn't contradict itself.
    expect(failing(await t.services.world.checkContent({ studioId: t.studioId, personaId: p.id, subject: { type: 'script', id: scriptId }, text: 'My sister Angie thinks budgeting is boring.', at: clock.now }), 'continuity')).toEqual([]);
    // Blocks are logged for the persona page.
    expect((await t.db.query(`SELECT 1 FROM concept_block WHERE persona_id = $1 AND check_name = 'continuity'`, [p.id])).length).toBeGreaterThanOrEqual(6);
    // People age: a year on, 80 is right.
    expect(contradictions(extractFacts("I'm 80 now."), [{ id: 'x', kind: 'age', subject: 'self', value: '79', statement: '', sourceType: 'bible', sourceId: null, statedAt: new Date('2026-01-01') }], new Date('2027-03-01'))).toEqual([]);
    await t.db.close();
  });
});

const fp = (over: Partial<ConceptFingerprint> = {}): ConceptFingerprint => ({
  ...fingerprintOf({ title: 'The envelope method for a pension', hookType: 'contrarian', pillar: 'budgeting', niche: 'personal finance', format: 'talking', hook: 'Cash in envelopes beats any app at 79' }),
  ...over,
});

describe('the continuity ledger when something fails', () => {
  it('a failed continuity-keeper run falls back to the rule-based facts: the ledger still records, and "Angie" → "Angelo" still blocks', async () => {
    const t = await worldStudio();
    const p = await personaWithWorld(t, { homeBase: 'a terraced house in Yorkshire' });
    const run = vi.spyOn(t.services.runtime, 'run').mockRejectedValue(new BudgetExceededError('llm cap', { scope: 'persona', unit: 'llm_usd', used: 1, cap: 0, requested: 0.01 }));
    const id = '55555555-5555-4555-8555-555555555555';
    await t.services.world.recordApproved({ studioId: t.studioId, personaId: p.id, subject: { type: 'script', id }, text: 'My sister Angie is 34 and thinks budgeting is boring.', at: clock.now });
    expect(await t.db.query(`SELECT subject, value FROM continuity_fact WHERE persona_id = $1 AND source_type = 'script'`, [p.id])).toEqual(expect.arrayContaining([{ subject: 'sister', value: 'Angie' }]));
    const checks = await t.services.world.checkContent({ studioId: t.studioId, personaId: p.id, subject: { type: 'script', id: null }, text: 'My brother Angelo still thinks budgeting is boring.', at: clock.now });
    expect(failing(checks, 'continuity')).toHaveLength(1);
    expect(run).toHaveBeenCalled();
    await t.db.close();
  });

  it('a failure part-way leaves no marker, so the retry records the subject in full', async () => {
    const t = await worldStudio();
    const p = await personaWithWorld(t, { homeBase: 'a terraced house in Yorkshire' });
    const id = '66666666-6666-4666-8666-666666666666';
    const q = { studioId: t.studioId, personaId: p.id, subject: { type: 'script' as const, id }, text: 'My sister Angie keeps her pension in six envelopes, one per bill.', at: clock.now, fingerprint: fp() };
    vi.spyOn(t.providers.embeddings, 'embed').mockRejectedValueOnce(new Error('embeddings 503'));
    await expect(t.services.world.recordApproved(q)).rejects.toThrow(/503/);
    expect(await t.db.query(`SELECT 1 FROM continuity_record WHERE subject_id = $1`, [id])).toHaveLength(0);
    await t.services.world.recordApproved(q);
    expect(await t.db.one(`SELECT facts FROM continuity_record WHERE subject_id = $1`, [id])).toMatchObject({ facts: expect.any(Number) });
    expect(await t.db.query(`SELECT 1 FROM concept_fingerprint WHERE subject_id = $1`, [id])).toHaveLength(1);
    expect((await t.db.query(`SELECT 1 FROM continuity_fact WHERE source_id = $1 AND subject = 'sister'`, [id])).length).toBe(1);
    await t.db.close();
  });
});

describe('the no-repeat engine', () => {
  it('blocks a near-duplicate concept for the persona and passes a new one', async () => {
    const t = await worldStudio();
    const p = await personaWithWorld(t, { homeBase: 'a terraced house in Yorkshire' });
    await t.services.world.recordApproved({ studioId: t.studioId, personaId: p.id, subject: { type: 'script', id: '33333333-3333-4333-8333-333333333333' }, text: 'Cash in envelopes beats any app. Here is how I split my pension every month into six envelopes.', at: clock.now, fingerprint: fp() });
    const same = await t.services.world.checkConcept({ studioId: t.studioId, personaId: p.id, fingerprint: fp({ premise: 'The envelope method for my pension' }) });
    expect(same.ok).toBe(false);
    expect(same.similarity).toBeGreaterThanOrEqual(0.9);
    expect(same.nearest).toMatchObject({ scope: 'persona', title: 'The envelope method for a pension' });
    const fresh = await t.services.world.checkConcept({ studioId: t.studioId, personaId: p.id, fingerprint: fp({ premise: 'Why I stopped buying extended warranties', keyLine: 'Warranties are insurance you already paid for', hookType: 'story' }) });
    expect(fresh.ok).toBe(true);
    // The same key line repeated is blocked even with a new premise.
    const key = await t.services.world.checkConcept({ studioId: t.studioId, personaId: p.id, fingerprint: fp({ premise: 'Shopping list rules for December', topic: 'groceries', hookType: 'list' }) });
    expect(key.ok).toBe(false);
    // In Q1 it is a blocker check.
    const checks = await t.services.world.checkContent({ studioId: t.studioId, personaId: p.id, subject: { type: 'script', id: null }, text: 'Cash in envelopes beats any app.', at: clock.now, fingerprint: fp({ premise: 'The envelope method for my pension' }) });
    expect(failing(checks, 'no_repeat')[0]).toMatchObject({ severity: 'blocker' });
    await t.db.close();
  });

  it('requires a new beat from every series episode', async () => {
    const t = await worldStudio();
    const p = await personaWithWorld(t, { homeBase: 'a terraced house in Yorkshire' });
    expect(seriesOf('Canteen Rules #3: never shop hungry')).toBe('Canteen Rules');
    const ep = (n: number, beat: string, key: string): ConceptFingerprint => fp({ premise: `Canteen Rules #${n}: ${beat}`, keyLine: key, hookType: 'rule', topic: 'budgeting' });
    await t.services.world.recordApproved({ studioId: t.studioId, personaId: p.id, subject: { type: 'script', id: '44444444-4444-4444-8444-444444444441' }, text: 'Rule one.', at: clock.now, fingerprint: ep(1, 'never shop hungry', 'An empty stomach empties your purse') });
    const repeat = await t.services.world.checkConcept({ studioId: t.studioId, personaId: p.id, fingerprint: ep(2, 'never shop hungry', 'An empty stomach empties your purse') });
    expect(repeat.ok).toBe(false);
    expect(repeat.reason).toMatch(/series "Canteen Rules".*new beat/);
    const next = await t.services.world.checkConcept({ studioId: t.studioId, personaId: p.id, fingerprint: ep(2, 'freeze the bread on day one', 'The freezer is a pantry with a lid') });
    expect(next.ok).toBe(true);
    const q1 = await t.services.world.checkContent({ studioId: t.studioId, personaId: p.id, subject: { type: 'script', id: null }, text: 'Rule two again.', at: clock.now, fingerprint: ep(2, 'never shop hungry', 'An empty stomach empties your purse') });
    expect(failing(q1, 'no_repeat_series')).toHaveLength(1);
    await t.db.close();
  });

  it('blocks near-duplicate wording studio-wide (another persona) but not the persona re-checking itself', async () => {
    const t = await worldStudio();
    const a = await personaWithWorld(t, { homeBase: 'a terraced house in Yorkshire', name: 'Dot Pickering' });
    const b = await makeTestPersona(t, { name: 'Walt Hardy' });
    const words = 'Put every receipt in the biscuit tin on Sunday night, then sort them into three piles: needs, wants and mistakes. The mistakes pile is where the savings hide.';
    const sid = '55555555-5555-4555-8555-555555555555';
    await t.services.world.recordApproved({ studioId: t.studioId, personaId: a.id, subject: { type: 'script', id: sid }, text: words, at: clock.now, fingerprint: fp() });
    const copy = await t.services.world.checkContent({ studioId: t.studioId, personaId: b.id, subject: { type: 'script', id: null }, text: `${words} #budget`, at: clock.now });
    expect(failing(copy, 'near_duplicate_wording')[0]).toMatchObject({ severity: 'blocker' });
    const self = await t.services.world.checkContent({ studioId: t.studioId, personaId: a.id, subject: { type: 'script', id: sid }, text: words, at: clock.now });
    expect(failing(self, 'near_duplicate_wording')).toEqual([]);
    const own = await t.services.world.checkContent({ studioId: t.studioId, personaId: b.id, subject: { type: 'script', id: null }, text: 'Walt keeps a ledger on the workbench and pays cash for parts, never cards.', at: clock.now });
    expect(failing(own, 'near_duplicate_wording')).toEqual([]);
    await t.db.close();
  });

  it('works without a World Bible (null grounding, still guards continuity and repeats)', async () => {
    const t = await createTestStudio({ world: createWorldService, tools: WORLD_TOOLS, now: () => clock.now });
    const p = await makeTestPersona(t);
    expect(await t.services.world.grounding(p.id, clock.now)).toBeNull();
    const checks = await t.services.world.checkContent({ studioId: t.studioId, personaId: p.id, subject: { type: 'script', id: null }, text: 'Hello there, a simple tip.', at: clock.now });
    expect(checks.some((c) => c.check.startsWith('world_'))).toBe(false);
    expect(checks.find((c) => c.check === 'continuity')).toMatchObject({ pass: true });
    await t.db.close();
  });
});
