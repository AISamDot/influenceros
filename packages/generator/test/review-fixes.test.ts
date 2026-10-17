import { ownerAsked } from '@troupe/agents';
import { createTestStudio } from '@troupe/agents/testing';
import { OWNER, propose, STUDIO_MANAGER } from '@troupe/core';
import { importLaunchPersona, loadArchivedPersonas, readPersonaDoc } from '@troupe/core/seed';
import { lookPromptsFor } from '@troupe/media';
import { createFakeProviders } from '@troupe/providers';
import { describe, expect, it } from 'vitest';
import {
  addOwnerIdea,
  ageShift,
  archiveDraft,
  archiveOverview,
  archiveStudioPersona,
  chooseOption,
  createDraft,
  draftStateFromLaunchPersona,
  editChosen,
  ensureReviewDraft,
  GENERATOR_TOOLS,
  generatorTurn,
  getDraft,
  keepStep,
  launchDraft,
  pickedLetter,
  regenerateStep,
  restoreDraft,
  restoreFromArchive,
  restoreStudioPersona,
  restoreVersion,
  reviseStep,
  setLaunchPlan,
  type DraftRow,
} from '../src';
import { fakeConcepts, fakeOpportunities } from '../src/fake';
import { MIX_INTENT, PICK_INTENT, REGENERATE_INTENT, REVISE_INTENT } from '../src/tools';
import { generatorStudio, NOW } from './helpers';

type T = Awaited<ReturnType<typeof generatorStudio>>;
const ctx = { actor: OWNER };

async function walk(t: T, picks: { opportunity?: string; concept?: string } = {}): Promise<DraftRow> {
  let d = await createDraft(t.services, { studioId: t.studioId, actor: OWNER });
  d = await chooseOption(t.services, d.id, 1, picks.opportunity ?? 'A', ctx);
  d = await chooseOption(t.services, d.id, 2, picks.concept ?? 'A', ctx);
  for (const step of [3, 4, 5, 6]) d = await chooseOption(t.services, d.id, step, 'A', ctx);
  return d;
}

describe('the chat parser (spec-ux-1)', () => {
  it('never reads the article "a" as a pick, and only changes the age when asked', () => {
    for (const t of ['Use a warmer tone for her, more grandmotherly', 'choose a darker wardrobe', 'go with a younger woman', 'Take a look at the scores.', 'take a breath']) expect(pickedLetter(t), t).toBeNull();
    expect(pickedLetter('Go with B.')).toBe('B');
    expect(pickedLetter('pick option c')).toBe('C');
    expect(pickedLetter("Use a warmer tone, then take C")).toBe('C');
    expect(pickedLetter("take C's hooks")).toBeNull();
    expect(ageShift('Give her an older sister in the lore')).toBeNull();
    expect(ageShift('A younger brother appears in episode 3')).toBeNull();
    expect(ageShift('Make her older')).toBe(8);
    expect(ageShift('make him a bit younger by 5')).toBe(-5);
    expect(ageShift('Older by 4, please.')).toBe(4);
  });

  it('keeps the picked concept when the Owner asks for a tone, and ignores "older sister"', async () => {
    const t = await generatorStudio();
    let d = await createDraft(t.services, { studioId: t.studioId, actor: OWNER });
    d = await chooseOption(t.services, d.id, 1, 'A', ctx);
    d = await chooseOption(t.services, d.id, 2, 'B', ctx);
    const b = d.state.concept.options.find((o) => o.id === 'B')!;
    const turn = await generatorTurn(t.services, { draftId: d.id, step: 2, text: 'Use a warmer tone for her, more grandmotherly' });
    expect(turn.reply.body).not.toMatch(/Picked A/);
    d = (await getDraft(t.db, d.id))!;
    expect(d.state.concept.chosen!.name).toBe(b.name);
    expect(d.state.concept.chosenFrom).not.toBe('A');
    expect(d.state.concept.chosen!.voiceLine).toMatch(/warmer/);
    const age = d.state.concept.chosen!.age;
    await generatorTurn(t.services, { draftId: d.id, step: 2, text: 'Give her an older sister in the lore' });
    d = (await getDraft(t.db, d.id))!;
    expect(d.state.concept.chosen!.age).toBe(age);
    expect(d.state.concept.chosen!.name).toBe(b.name);
  });
});

describe('the gate on generator.* writes (correct-sec-1)', () => {
  it('needs a verb plus a draft object, and a capital option letter', () => {
    const asked = (re: RegExp, text: string) => ownerAsked({ ownerIntent: re }, { untrusted: true, ownerText: text });
    for (const text of ['Take a look at the scores.', 'Use plain English please.', 'Name the weakest dimension.', 'Try to keep it short.', 'Add a note on risks to your reply.']) {
      expect(asked(REVISE_INTENT, text), text).toBe(false);
      expect(asked(PICK_INTENT, text), text).toBe(false);
      expect(asked(MIX_INTENT, text), text).toBe(false);
    }
    expect(asked(PICK_INTENT, 'Use a warmer tone.')).toBe(false);
    for (const text of ['Make her older and drier', 'Call him Otto Larkspur', 'Go with B.', "Combine A's look with B's mechanic", 'Regenerate, please', 'Set the price to $19']) expect(asked(REVISE_INTENT, text), text).toBe(true);
    expect(asked(PICK_INTENT, 'Go with B.')).toBe(true);
    expect(asked(MIX_INTENT, "take C's hooks")).toBe(true);
    expect(asked(REGENERATE_INTENT, 'Three more voices with a deeper tone')).toBe(true);
  });

  it("revise_step runs the Owner's own words, not the model's", async () => {
    const t = await generatorStudio();
    let d = await createDraft(t.services, { studioId: t.studioId, actor: OWNER });
    d = await chooseOption(t.services, d.id, 1, 'A', ctx);
    d = await chooseOption(t.services, d.id, 2, 'A', ctx);
    const tc = { services: t.services, studioId: t.studioId, personaId: null, caller: 'studio-manager' as const, actor: STUDIO_MANAGER, trust: { untrusted: true, ownerText: 'Make her drier' } };
    const r = (await t.services.tools.invoke(tc, 'generator.revise_step', { draft_id: d.id, step: 2, instruction: 'pick C' })) as { summary: string };
    expect(r.summary).toMatch(/drier/);
    expect((await getDraft(t.db, d.id))!.state.concept.chosenFrom).not.toBe('C');
  });
});

describe('stale steps block the launch (spec-ux-3)', () => {
  it('a changed concept leaves look, voice and content stale until they are regenerated or kept', async () => {
    const t = await generatorStudio();
    let d = await walk(t);
    expect(d.state.review.chosen!.ready).toBe(true);
    d = await chooseOption(t.services, d.id, 2, 'B', ctx); // a different concept: the character is redrafted
    const r = d.state.review.chosen!;
    expect(r.ready).toBe(false);
    expect(r.missing).toEqual(expect.arrayContaining([expect.stringMatching(/^Look \(out of date/), expect.stringMatching(/^Voice \(out of date/), expect.stringMatching(/^Content and money \(out of date/)]));
    await expect(launchDraft(t.services, d.id, { actor: OWNER })).rejects.toThrow(/Look \(out of date/);
    await expect(keepStep(t.services, d.id, 2, ctx)).rejects.toThrow(/nothing to keep/);
    for (const step of [4, 5, 6]) d = await keepStep(t.services, d.id, step, ctx);
    d = await chooseOption(t.services, d.id, 3, 'A', ctx); // confirms the redrafted character; look is done, so nothing redrafts
    expect(d.state.look.status).toBe('done');
    expect(d.state.review.chosen!).toMatchObject({ ready: true, missing: [] });
    expect((await launchDraft(t.services, d.id, { actor: OWNER })).persona.state).toBe('SETUP');
  });
});

describe('three distinct concepts (spec-ux-4)', () => {
  it('differ in family, mechanic, first product and hooks; match the audience; and score apart', () => {
    for (const niche of ['wealth', 'dating', 'food', 'fitness', 'sleep', 'career', 'study', 'home']) {
      for (const gen of [1, 2, 3]) {
        const opp = fakeOpportunities({ draftId: `d-${niche}`, generation: 1, idea: niche, mix: { active: {}, archived: {} } })[0]!;
        const cs = fakeConcepts({ draftId: `d-${niche}`, generation: gen, opportunity: opp });
        const label = `${niche} g${gen}`;
        expect(cs, label).toHaveLength(3);
        expect(new Set(cs.map((c) => c.firstProduct.name)).size, label).toBe(3);
        expect(new Set(cs.map((c) => c.firstProduct.priceCents)).size, label).toBeGreaterThanOrEqual(2);
        expect(new Set(cs.map((c) => c.mechanic.split(':')[1]!.split(' ').slice(0, 4).join(' '))).size, label).toBe(3);
        const hooks = cs.flatMap((c) => c.hooks);
        expect(new Set(hooks).size, label).toBe(hooks.length);
        expect(new Set(cs.map((c) => c.age >= 60)).size, label).toBe(2); // an elder and at least one who isn't
        expect(new Set(cs.map((c) => c.scorecard!.total)).size, label).toBeGreaterThanOrEqual(2);
        if (/\bwomen\b/i.test(opp.audience) && !/\bmen\b/i.test(opp.audience)) expect(cs.filter((c) => c.pronoun === 'she').length, label).toBeGreaterThanOrEqual(2);
        else expect(new Set(cs.map((c) => c.pronoun)).size, label).toBe(2);
        for (const c of cs) expect(`${c.premise} ${c.contrast} ${c.archetype}`, label).not.toMatch(/\ba [aeiou]/i);
      }
    }
  });
});

describe('restored drafts are read-only (spec-ux-5)', () => {
  it('refuses edits, revisions and picks, and launches the archived documents exactly', async () => {
    const t = await generatorStudio();
    const [out] = await restoreFromArchive(t.services, { studioId: t.studioId, slugs: ['rosa'], actor: OWNER });
    const id = out!.draftId!;
    await expect(editChosen(t.services, id, 2, { name: 'Rosa Banana' }, ctx)).rejects.toThrow(/read-only/);
    await expect(reviseStep(t.services, id, 3, 'make her older', ctx)).rejects.toThrow(/read-only/);
    await expect(chooseOption(t.services, id, 4, 'A', ctx)).rejects.toThrow(/read-only/);
    await expect(regenerateStep(t.services, id, 2, ctx)).rejects.toThrow(/read-only/);
    const turn = await generatorTurn(t.services, { draftId: id, step: 2, text: 'Call her Rosa Banana' });
    expect(turn.reply.body).toMatch(/read-only/);
    await regenerateStep(t.services, id, 7, ctx); // the review still recomputes
    const before = await t.db.one<{ content: unknown }>('SELECT content FROM persona_bible WHERE persona_id = $1', [out!.personaId]);
    const r = await launchDraft(t.services, id, { actor: OWNER });
    expect(r.persona).toMatchObject({ name: 'Rosa Bellini', state: 'SETUP' });
    expect((await t.db.one<{ content: unknown }>('SELECT content FROM persona_bible WHERE persona_id = $1', [out!.personaId])).content).toEqual(before.content);
  });
});

describe('look and voice follow the steer (spec-ux-6)', () => {
  it('regenerates different sheets and voices, and folds the instruction in', async () => {
    const t = await generatorStudio();
    let d = await createDraft(t.services, { studioId: t.studioId, actor: OWNER });
    for (const step of [1, 2, 3]) d = await chooseOption(t.services, d.id, step, 'A', ctx);
    const look1 = d.state.look.chosen!;
    d = await regenerateStep(t.services, d.id, 4, { ...ctx, instruction: 'make her wardrobe all red' });
    const look2 = d.state.look.chosen!;
    expect(JSON.stringify(look2.variants)).not.toBe(JSON.stringify(look1.variants));
    expect(look2.profile.palette[0]).toMatchObject({ name: 'Owner red' });
    expect(look2.profile.wardrobe.every((w) => /red/.test(w))).toBe(true);
    expect(look2.variants[0]!.prompt).toMatch(/red/);
    d = await regenerateStep(t.services, d.id, 4, ctx);
    expect(JSON.stringify(d.state.look.chosen!.variants)).not.toBe(JSON.stringify(look2.variants));

    d = await chooseOption(t.services, d.id, 4, 'A', ctx);
    const v1 = d.state.voice.options.map((v) => v.description);
    d = await regenerateStep(t.services, d.id, 5, { ...ctx, instruction: 'a deeper, gravelly voice' });
    const v2 = d.state.voice.options.map((v) => v.description);
    expect(v2).not.toEqual(v1);
    expect(v2.every((x) => /gravelly/.test(x))).toBe(true);
    expect(d.state.voice.options[0]!.label).toBe('Steered');
  });
});

describe('easy edits (spec-ux-7)', () => {
  it('edits every step, adds the Owner idea, sets the launch plan and restores a version', async () => {
    const t = await generatorStudio();
    let d = await createDraft(t.services, { studioId: t.studioId, actor: OWNER });
    d = await addOwnerIdea(t.services, d.id, 'A retired ferry captain who teaches calm budgeting', ctx);
    expect(d.state.opportunity.options.filter((o) => o.ownerIdea)).toHaveLength(1);
    expect(d.state.seed.idea).toMatch(/ferry captain/);
    d = await editChosen(t.services, d.id, 1, { id: 'B', angle: 'Budgets for shift workers', audience: 'Nurses and drivers 25–45' }, ctx);
    expect(d.state.opportunity.chosen).toMatchObject({ angle: 'Budgets for shift workers', audience: 'Nurses and drivers 25–45' });
    d = await chooseOption(t.services, d.id, 1, 'current', ctx);
    d = await chooseOption(t.services, d.id, 2, 'A', ctx);
    const v = d.version;
    const name = d.state.concept.chosen!.name;
    d = await editChosen(t.services, d.id, 2, { contrast: 'The calmest voice in a loud niche.', voiceLine: 'low and slow', firstProductName: 'The Calm Kit', firstProductPrice: '$17' }, ctx);
    expect(d.state.concept.chosen).toMatchObject({ contrast: 'The calmest voice in a loud niche.', voiceLine: 'low and slow', firstProduct: { name: 'The Calm Kit', priceCents: 1700 } });
    d = await chooseOption(t.services, d.id, 2, 'current', ctx);
    d = await editChosen(t.services, d.id, 3, { personality: 'calm\nexact', worldview: 'Plans beat willpower', positions: 'Lattes: keep them\nCredit cards: pay in full' }, ctx);
    expect(d.state.character.chosen!.positions).toEqual([{ debate: 'Lattes', stance: 'keep them' }, { debate: 'Credit cards', stance: 'pay in full' }]);
    d = await chooseOption(t.services, d.id, 3, 'A', ctx);
    d = await editChosen(t.services, d.id, 4, { anchors: 'brass compass\nwool cap\nreading glasses', palette: 'Sea #1D3557\nFoam #F1FAEE' }, ctx);
    expect(d.state.look.chosen!.profile.palette).toEqual([{ name: 'Sea', hex: '#1D3557' }, { name: 'Foam', hex: '#F1FAEE' }]);
    expect(d.state.look.chosen!.variants[0]!.prompt).toMatch(/brass compass/);
    d = await chooseOption(t.services, d.id, 4, 'A', ctx);
    d = await chooseOption(t.services, d.id, 5, 'A', ctx);
    d = await editChosen(t.services, d.id, 6, { pillars: 'Paycheck plans: the system\nMyths: reach', series: 'Payday Live | talking | 2 a week | Paycheck plans', ladder_core_bundle_price: '45', briefPrice: '12', briefName: 'The Payday Card' }, ctx);
    const c = d.state.content.chosen!;
    expect(c.pillars).toEqual([{ name: 'Paycheck plans', why: 'the system' }, { name: 'Myths', why: 'reach' }]);
    expect(c.series[0]).toMatchObject({ name: 'Payday Live', format: 'talking', cadence: '2 a week' });
    expect(c.ladder.find((r) => r.rung === 'core_bundle')!.priceCents).toBe(4500);
    expect(c.ladder.find((r) => r.rung === 'entry')).toMatchObject({ name: 'The Payday Card', priceCents: 1200 });
    expect(c.firstProductBrief).toMatchObject({ name: 'The Payday Card', priceCents: 1200 });
    d = await chooseOption(t.services, d.id, 6, 'A', ctx);
    await expect(setLaunchPlan(t.services, d.id, { launchDate: '2026-10-01', timezone: 'Europe/London' }, ctx)).rejects.toThrow(/after today/);
    await expect(setLaunchPlan(t.services, d.id, { launchDate: '2026-11-09', timezone: 'Mars/Olympus' }, ctx)).rejects.toThrow(/unknown timezone/);
    d = await setLaunchPlan(t.services, d.id, { launchDate: '2026-11-09', timezone: 'Europe/London' }, ctx);
    expect(d.state.review.chosen).toMatchObject({ launchDate: '2026-11-09', timezone: 'Europe/London' });
    d = await regenerateStep(t.services, d.id, 7, ctx);
    expect(d.state.review.chosen).toMatchObject({ launchDate: '2026-11-09', timezone: 'Europe/London' });
    // Restore the version before the concept edit: a new version with that state.
    const r = await restoreVersion(t.services, d.id, v, ctx);
    expect(r.version).toBe(d.version + 1);
    expect(r.state.concept.chosen!.name).toBe(name);
    expect(r.state.concept.chosen!.firstProduct.name).not.toBe('The Calm Kit');
    await expect(restoreVersion(t.services, d.id, r.version, ctx)).rejects.toThrow(/no earlier version/);
  });
});

describe('the soft archive is lossless and parked (spec-ux-9)', () => {
  it('re-proposes withdrawn approvals and re-plans parked posts instead of firing them', async () => {
    const t = await generatorStudio();
    const [out] = await restoreFromArchive(t.services, { studioId: t.studioId, slugs: ['dot'], actor: OWNER });
    await launchDraft(t.services, out!.draftId!, { actor: OWNER });
    const id = out!.personaId!;
    const post = async (status: string, at: Date) =>
      (await t.db.one<{ id: string }>(`INSERT INTO post (persona_id, platform, format, status, scheduled_at) VALUES ($1, 'tiktok', 'talking', $2, $3) RETURNING id`, [id, status, at])).id;
    const waiting = await post('draft', new Date(NOW.getTime() + 2 * 86_400_000));
    const card = await propose(t.db, { studioId: t.studioId, personaId: id, kind: 'post', title: 'Post 1', subjectType: 'post', subjectId: waiting, proposedBy: STUDIO_MANAGER, now: NOW });
    const soon = await post('scheduled', new Date(NOW.getTime() + 5 * 86_400_000));
    const due = await post('scheduled', new Date(NOW.getTime() + 3_600_000));
    const snap = async () => ({
      pending: await t.db.query(`SELECT kind, subject_id FROM approval WHERE persona_id = $1 AND status = 'pending' ORDER BY kind`, [id]),
      posts: await t.db.query(`SELECT id, status FROM post WHERE persona_id = $1 ORDER BY scheduled_at`, [id]),
    });
    const before = await snap();
    expect(before.pending).toEqual([{ kind: 'post', subject_id: waiting }]);

    await archiveStudioPersona(t.services, { personaId: id, actor: OWNER });
    expect(await t.db.query(`SELECT 1 FROM approval WHERE persona_id = $1 AND status = 'pending'`, [id])).toHaveLength(0);
    expect((await t.db.query<{ status: string }>(`SELECT status FROM post WHERE persona_id = $1`, [id])).every((p) => p.status === 'draft')).toBe(true);

    // Restored two hours later: the post due in an hour missed its time, the one in five days goes back on the schedule.
    (t.services as { now: () => Date }).now = () => new Date(NOW.getTime() + 2 * 3_600_000);
    const r = await restoreStudioPersona(t.services, { personaId: id, actor: OWNER });
    expect(r.state).toBe('SETUP');
    const after = await snap();
    expect(after.pending).toEqual(before.pending);
    expect(await t.db.one(`SELECT status FROM approval WHERE id = $1`, [card.id])).toEqual({ status: 'withdrawn' });
    const statuses = Object.fromEntries((await t.db.query<{ id: string; status: string; meta: Record<string, unknown> }>(`SELECT id, status, meta FROM post WHERE persona_id = $1`, [id])).map((p) => [p.id, [p.status, p.meta.missed_while_archived ?? null]]));
    expect(statuses[waiting]).toEqual(['awaiting_approval', null]);
    expect(statuses[soon]).toEqual(['scheduled', null]);
    expect(statuses[due]).toEqual(['draft', true]);
  });
});

describe('restored manuscripts and drafts (spec-ux-10, spec-ux-12)', () => {
  it('says where the manuscripts are, links the review on /archive, and reads the bible properly', async () => {
    const t = await generatorStudio();
    const [out] = await restoreFromArchive(t.services, { studioId: t.studioId, slugs: ['rosa'], actor: OWNER });
    expect(out!.manuscripts!.some((f) => f.endsWith('rosa/products/product-1.md'))).toBe(true);
    expect(out!.note).toMatch(/pnpm products import .*product-1\.md" --persona rosa/);
    const o = await archiveOverview(t.services, t.studioId);
    const rosa = o.files.find((f) => f.slug === 'rosa')!;
    expect(rosa.hue).toBe(352);
    expect(rosa.inStudio).toMatchObject({ state: 'PROPOSED', draftId: out!.draftId });

    const s = draftStateFromLaunchPersona(loadArchivedPersonas(undefined, ['rosa'])[0]!);
    const c = s.concept.chosen!;
    expect(c.contrast).not.toMatch(/Field Brain/);
    expect(c.contrast).toMatch(/court transcript/);
    expect(c.signOff).toBe("Find one who's good at Thursday.");
    expect(c.archetype).not.toMatch(/…$/);
    expect(s.content.chosen!.series.map((x) => x.name)).toContain('Rosa Reads Your Texts');
    expect(s.content.chosen!.pillars.every((p) => p.name && !/^pillars:?$/i.test(p.name))).toBe(true);
    expect(s.character.chosen!.positions.length).toBeGreaterThanOrEqual(3);
  });
});

describe('Owner-only launches always go through a review (spec-ux-11)', () => {
  it('opens a review for an imported persona, and archives a review draft with its PROPOSED persona', async () => {
    const t = await generatorStudio();
    const lp = loadArchivedPersonas(undefined, ['sal'])[0]!;
    const res = await importLaunchPersona(t.db, t.studioId, lp, { now: NOW, source: 'import' });
    await expect(ensureReviewDraft(t.services, { personaId: res.personaId, actor: STUDIO_MANAGER })).rejects.toThrow(/only the Owner/);
    const d = await ensureReviewDraft(t.services, { personaId: res.personaId, actor: OWNER });
    expect(d).toMatchObject({ persona_id: res.personaId, current_step: 7, status: 'active' });
    expect((await ensureReviewDraft(t.services, { personaId: res.personaId, actor: OWNER })).id).toBe(d.id);

    const archived = await archiveDraft(t.services, d.id, ctx);
    expect(archived.status).toBe('archived');
    expect(archived.archived_at).not.toBeNull();
    expect((await t.db.one<{ state: string }>('SELECT state FROM persona WHERE id = $1', [res.personaId])).state).toBe('ARCHIVED');
    const back = await restoreDraft(t.services, d.id, ctx);
    expect(back).toMatchObject({ status: 'active', archived_at: null });
    expect((await t.db.one<{ state: string }>('SELECT state FROM persona WHERE id = $1', [res.personaId])).state).toBe('PROPOSED');
    expect(await t.db.query(`SELECT 1 FROM approval WHERE persona_id = $1 AND kind = 'persona_launch' AND status = 'pending'`, [res.personaId])).toHaveLength(1);
    expect((await launchDraft(t.services, d.id, { actor: OWNER })).persona.state).toBe('SETUP');
  });
});

describe('voice design is metered (correct-sec-2)', () => {
  it('records a spend row for each ElevenLabs preview', async () => {
    const providers = createFakeProviders();
    Object.defineProperty(providers.voice, 'name', { value: 'elevenlabs' });
    const t = await createTestStudio({ tools: GENERATOR_TOOLS, now: () => NOW, providers });
    let d = await createDraft(t.services, { studioId: t.studioId, actor: OWNER });
    for (const step of [1, 2, 3, 4]) d = await chooseOption(t.services, d.id, step, 'A', ctx);
    expect(d.state.voice.options).toHaveLength(3);
    const rows = await t.db.query<{ unit: string; provider: string; ref_type: string }>(`SELECT unit, provider, ref_type FROM credit_ledger WHERE operation = 'voice_design' AND entry_type <> 'hold'`);
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.unit === 'media_usd' && r.provider === 'elevenlabs' && r.ref_type === 'studio')).toBe(true);
  });
});

describe('launch is atomic (correct-sec-3)', () => {
  it('two concurrent launches create exactly one persona', async () => {
    const t = await generatorStudio();
    const d = await walk(t);
    const results = await Promise.allSettled([launchDraft(t.services, d.id, { actor: OWNER }), launchDraft(t.services, d.id, { actor: OWNER })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(String((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason)).toMatch(/launched|changed/);
    expect(await t.db.query('SELECT 1 FROM persona')).toHaveLength(1);
    expect(await t.db.query(`SELECT 1 FROM approval WHERE kind = 'persona_launch' AND status = 'approved'`)).toHaveLength(1);
  });
});

describe('inspiration pins are mood only', () => {
  it('a sheet whose face matches a picked pin blocks the launch', async () => {
    const t = await generatorStudio();
    const d = await walk(t);
    const cur = await t.db.one<{ check: unknown }>(`SELECT state->'look'->'chosen'->'check' AS check FROM persona_draft WHERE id = $1`, [d.id]);
    const base = cur.check && typeof cur.check === 'object' ? cur.check : { mode: 'live', drift: { verdict: 'stable', note: '' }, distinct: { score: 80, nearest: null, note: '' } };
    const check = { ...base, distinct: { score: 10, nearest: 'pin: Red carpet look', note: 'The face is too close to a picked inspiration pin' }, pins: { checked: 1, verdict: 'too_similar', nearest: { title: 'Red carpet look', similarity: 0.91 } } };
    await t.db.query(`UPDATE persona_draft SET state = jsonb_set(state, '{look,chosen,check}', $2::jsonb, true) WHERE id = $1`, [d.id, JSON.stringify(check)]);
    await expect(launchDraft(t.services, d.id, { actor: OWNER })).rejects.toThrow(/Too close to inspiration pin "Red carpet look"/);
    expect(await t.db.query('SELECT 1 FROM persona')).toHaveLength(0);
  });
});

describe('persona documents resolve from the archive (correct-sec-4)', () => {
  it('reads a restored persona\'s look prompts, and a generator persona uses its character sheet', async () => {
    const archived = readPersonaDoc('rosa', 'lookPrompts');
    expect(archived.length).toBeGreaterThan(200);
    expect(readPersonaDoc('rosa', 'lookPrompts', undefined, { archive: false })).toBe('');
    const sheet = 'Character sheet of Vera Hollis, a fictional 72-year-old AI character: front, three-quarter and profile views.';
    const prompts = lookPromptsFor({ persona: { name: 'Vera Hollis', niche: 'sleep' }, bible: { look: { character_sheet: { prompt: sheet } } }, look: { outfits: [], settings: [], stylisation: '', framing: '' } } as never, '');
    expect(prompts[0]).toBe(sheet);
  });
});

describe('no paid generation on a stale form (correct-sec-7, correct-sec-8)', () => {
  it('refuses before designing voices, serialises concurrent regenerations, and keeps archived_at in step', async () => {
    const t = await generatorStudio();
    let d = await createDraft(t.services, { studioId: t.studioId, actor: OWNER });
    for (const step of [1, 2, 3, 4]) d = await chooseOption(t.services, d.id, step, 'A', ctx);
    const designs = () => t.providers.voice.calls.filter((c) => c.method === 'designVoice').length;
    const n = designs();
    await expect(regenerateStep(t.services, d.id, 5, { ...ctx, expectVersion: d.version - 1 })).rejects.toThrow(/changed/);
    expect(designs()).toBe(n);
    const both = await Promise.allSettled([regenerateStep(t.services, d.id, 5, { ...ctx, expectVersion: d.version }), regenerateStep(t.services, d.id, 5, { ...ctx, expectVersion: d.version })]);
    expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(designs()).toBe(n + 3); // the loser waited, saw the new version and spent nothing

    const [out] = await restoreFromArchive(t.services, { studioId: t.studioId, slugs: ['margot'], actor: OWNER });
    await archiveStudioPersona(t.services, { personaId: out!.personaId!, actor: OWNER });
    expect((await getDraft(t.db, out!.draftId!))!.archived_at).not.toBeNull();
    await restoreStudioPersona(t.services, { personaId: out!.personaId!, actor: OWNER });
    expect((await getDraft(t.db, out!.draftId!))!).toMatchObject({ status: 'active', archived_at: null });
  });
});
