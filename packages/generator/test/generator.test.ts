import { ToolPermissionError } from '@ios/agents';
import { ApprovalError, OWNER, STUDIO_MANAGER, sweepAutoApprovals } from '@ios/core';
import { BIBLE_SECTIONS, loadArchivedPersonas } from '@ios/core/seed';
import { describe, expect, it } from 'vitest';
import {
  archiveDraft,
  chooseOption,
  createDraft,
  distinctness,
  draftSignature,
  draftStateFromLaunchPersona,
  draftVersions,
  generatorTurn,
  getDraft,
  insertDraft,
  launchDraft,
  listDraftMessages,
  archiveSignatures,
  pickAlternative,
  regenerateStep,
  restoreDraft,
  studioSignatures,
  type DraftRow,
} from '../src';
import { generatorStudio, NOW } from './helpers';

type T = Awaited<ReturnType<typeof generatorStudio>>;

/** Walks a fresh draft through steps 1–6, picking the given options, and returns it at the review. */
async function walk(t: T, picks: { opportunity?: string; concept?: string; sheet?: string; voice?: string } = {}): Promise<DraftRow> {
  const ctx = { actor: OWNER };
  let d = await createDraft(t.services, { studioId: t.studioId, actor: OWNER });
  d = await chooseOption(t.services, d.id, 1, picks.opportunity ?? 'A', ctx);
  d = await chooseOption(t.services, d.id, 2, picks.concept ?? 'A', ctx);
  d = await chooseOption(t.services, d.id, 3, 'A', ctx);
  d = await chooseOption(t.services, d.id, 4, picks.sheet ?? 'A', ctx);
  d = await chooseOption(t.services, d.id, 5, picks.voice ?? 'A', ctx);
  d = await chooseOption(t.services, d.id, 6, 'A', ctx);
  return d;
}

describe('persona draft lifecycle', () => {
  it('drafts each step from the last, versions every change, and resumes where the Owner left off', async () => {
    const t = await generatorStudio();
    let d = await createDraft(t.services, { studioId: t.studioId, actor: OWNER });
    expect(d).toMatchObject({ status: 'active', current_step: 1, version: 2 });
    const opps = d.state.opportunity.options;
    expect(opps).toHaveLength(4);
    expect(opps.map((o) => o.scores.total)).toEqual([...opps.map((o) => o.scores.total)].sort((a, b) => b - a));
    for (const o of opps) {
      expect(o.evidence.length).toBeGreaterThanOrEqual(3);
      expect(o.evidence.some((e) => e.signal === 'gap' && e.flag === 'S')).toBe(true);
    }
    expect(d.state.opportunity.advice).toMatch(/^I'd take A/);

    d = await chooseOption(t.services, d.id, 1, 'B', { actor: OWNER });
    expect(d.current_step).toBe(2);
    expect(d.state.opportunity.chosen?.id).toBe('B');
    const concepts = d.state.concept.options;
    expect(concepts).toHaveLength(3);
    expect(new Set(concepts.map((c) => c.name)).size).toBe(3);
    expect(new Set(concepts.map((c) => c.archetypeKey)).size).toBe(3);
    for (const c of concepts) {
      expect(c.hooks).toHaveLength(5);
      expect(c.premise).toContain(c.name);
      expect(c.mechanic).toMatch(/^[^:]+: /);
      expect(c.firstProduct.priceCents).toBeGreaterThan(0);
      expect(c.scorecard!.total).toBeGreaterThan(50);
      expect(c.scorecard!.total).toBe(c.scorecard!.captivation + c.scorecard!.demand + c.scorecard!.ladder + c.scorecard!.gap + c.scorecard!.producibility + c.scorecard!.lineSafety);
    }

    d = await chooseOption(t.services, d.id, 2, 'C', { actor: OWNER });
    expect(d.title).toBe(concepts[2]!.name);
    const ch = d.state.character;
    expect(ch.chosen?.name).toBe(concepts[2]!.name);
    expect(ch.chosen?.identity).toMatch(/AI character/);
    expect(ch.chosen?.identity).not.toMatch(/\bDr\.|nutritionist|PhD/);
    expect(ch.options[0]!.alternatives.name!.length).toBeGreaterThanOrEqual(2);
    expect(ch.chosen?.positions.length).toBeGreaterThanOrEqual(3);

    // Swap a field for an alternative: the old value becomes an alternative (undoable).
    const oldLore = ch.chosen!.lore;
    d = await pickAlternative(t.services, d.id, 'lore', 0, { actor: OWNER });
    expect(d.state.character.chosen!.lore).not.toBe(oldLore);
    expect(d.state.character.options[0]!.alternatives.lore).toContain(oldLore);

    d = await chooseOption(t.services, d.id, 3, 'A', { actor: OWNER });
    expect(d.current_step).toBe(4);
    const look = d.state.look.chosen!;
    expect(look.variants).toHaveLength(3);
    expect(look.variants.every((v) => v.provider === 'placeholder' && v.url.startsWith('data:image/svg+xml'))).toBe(true);
    expect(look.profile.palette.length).toBeGreaterThanOrEqual(3);
    expect(look.profile.settings.length).toBeLessThanOrEqual(4);

    d = await chooseOption(t.services, d.id, 4, 'B', { actor: OWNER });
    expect(d.state.look.chosen!.chosenVariant).toBe('B');
    expect(d.state.look.chosen!.check).toMatchObject({ mode: 'placeholder', drift: { verdict: 'not_checked' } });
    expect(d.state.voice.options).toHaveLength(3);
    expect(d.state.voice.options.every((v) => v.fake && v.url.startsWith('https://fake.elevenlabs.local/') && v.voiceId)).toBe(true);
    expect(t.providers.voice.calls.filter((c) => c.method === 'designVoice')).toHaveLength(3);

    d = await chooseOption(t.services, d.id, 5, 'B', { actor: OWNER });
    const content = d.state.content.chosen!;
    expect(content.pillars).toHaveLength(3);
    expect(content.hookBank.length).toBeGreaterThanOrEqual(10);
    expect(content.ladder.map((r) => r.rung)).toEqual(['lead_magnet', 'entry', 'addon', 'core_bundle', 'upsell', 'membership']);
    expect(content.firstProductBrief.sections.length).toBeGreaterThanOrEqual(5);

    d = await chooseOption(t.services, d.id, 6, 'A', { actor: OWNER });
    expect(d.current_step).toBe(7);
    const review = d.state.review.chosen!;
    expect(review).toMatchObject({ ready: true, missing: [] });
    expect(review.scorecard.total).toBeGreaterThan(60);
    expect(review.distinctness.verdict).toBe('distinct');
    expect(review.risks.some((r) => /placeholder sheets/.test(r))).toBe(true);
    expect(d.scores.total).toBe(review.scorecard.total);

    // Resumable: a fresh read is the same draft; every change was a version.
    const again = await getDraft(t.db, d.id);
    expect(again).toMatchObject({ version: d.version, current_step: 7, state: d.state });
    const versions = await draftVersions(t.db, d.id);
    expect(versions[0]!.version).toBe(d.version);
    expect(versions.at(-1)).toMatchObject({ version: 1, step: 0, change: 'draft started' });
    expect(versions.map((v) => v.change)).toContain('concept: picked C');

    // Archivable and restorable; an archived draft refuses changes.
    const archived = await archiveDraft(t.services, d.id, { actor: OWNER });
    expect(archived.status).toBe('archived');
    await expect(chooseOption(t.services, d.id, 6, 'A', { actor: OWNER })).rejects.toThrow(/archived/);
    const restored = await restoreDraft(t.services, d.id, { actor: OWNER });
    expect(restored).toMatchObject({ status: 'active', current_step: 7 });
    expect(restored.state.review.chosen?.ready).toBe(true);
  });

  it("starts from the Owner's own idea as the first opportunity", async () => {
    const t = await generatorStudio();
    const d = await createDraft(t.services, { studioId: t.studioId, idea: 'A retired lighthouse keeper who teaches calm bedtime routines', actor: OWNER });
    expect(d.source).toBe('owner_idea');
    expect(d.state.opportunity.options[0]).toMatchObject({ id: 'A', ownerIdea: true, niche: 'sleep' });
    expect(d.state.opportunity.options.slice(1).every((o) => o.niche !== 'sleep')).toBe(true);
  });
});

describe('step regeneration', () => {
  it('drafts new options, keeps the old picks as they were, and flags later steps stale', async () => {
    const t = await generatorStudio();
    let d = await createDraft(t.services, { studioId: t.studioId, actor: OWNER });
    d = await chooseOption(t.services, d.id, 1, 'A', { actor: OWNER });
    const first = d.state.concept.options.map((c) => `${c.name}|${c.archetypeKey}`);
    d = await chooseOption(t.services, d.id, 2, 'A', { actor: OWNER });
    expect(d.state.character.status).toBe('ready');

    d = await regenerateStep(t.services, d.id, 2, { actor: OWNER, instruction: 'more surprising professions' });
    expect(d.state.concept.generation).toBe(2);
    const second = d.state.concept.options.map((c) => `${c.name}|${c.archetypeKey}`);
    expect(second).toHaveLength(3);
    expect(second).not.toEqual(first);
    expect(d.state.concept.instruction).toBe('more surprising professions');
    expect(d.state.character.status).toBe('stale'); // drafted for the old concept: kept, flagged
    const v = (await draftVersions(t.db, d.id))[0]!;
    expect(v.change).toMatch(/^concept: regenerated \("more surprising professions"\)/);

    // Deterministic: the same draft regenerated the same way gives the same options (tests and replays are stable).
    const replay = await regenerateStep(t.services, d.id, 1, { actor: OWNER });
    expect(replay.state.opportunity.generation).toBe(2);
    expect(replay.state.opportunity.options.map((o) => o.niche)).not.toEqual(d.state.opportunity.options.map((o) => o.niche));
  });
});

describe('owner-only launch', () => {
  it('refuses agents and timers; the Owner launches into SETUP with the deep profile, calendar and Field Brain seed', async () => {
    const t = await generatorStudio();
    const d = await walk(t);
    expect(d.state.review.chosen?.ready).toBe(true);

    // Agents can't launch, by function, by tool, or by asking in the chat.
    await expect(launchDraft(t.services, d.id, { actor: STUDIO_MANAGER })).rejects.toThrow(ApprovalError);
    const agentCtx = { services: t.services, studioId: t.studioId, personaId: null, caller: 'studio-manager' as const, actor: STUDIO_MANAGER };
    await expect(t.services.tools.invoke(agentCtx, 'generator.launch', { draft_id: d.id })).rejects.toThrow(ToolPermissionError);
    expect(t.services.tools.list({ caller: 'studio-manager' }).map((x) => x.name)).not.toContain('generator.launch');
    const turn = await generatorTurn(t.services, { draftId: d.id, step: 7, text: 'Approve the launch now please' });
    expect(turn.reply.body).toMatch(/approve the launch when you are happy|Not ready/i);
    expect(await t.db.query('SELECT 1 FROM persona')).toHaveLength(0);

    const r = await launchDraft(t.services, d.id, { actor: OWNER });
    expect(r.persona.state).toBe('SETUP');
    expect(r.approval).toMatchObject({ kind: 'persona_launch', mode: 'explicit', status: 'approved', decided_by: 'owner:hossam', auto_approve_at: null });
    expect(r.approval.payload).toMatchObject({ owner_only: true, source: 'generator' });
    expect(r.slots).toBe(20);
    expect(r.fieldBrainQueued).toBe(true);
    expect(r.draft).toMatchObject({ status: 'launched', persona_id: r.persona.id });

    const bible = await t.db.one<{ version: number; status: string; approved_by: string; content: Record<string, unknown> }>('SELECT version, status, approved_by, content FROM persona_bible WHERE persona_id = $1', [r.persona.id]);
    expect(bible).toMatchObject({ version: 1, status: 'approved', approved_by: 'owner:hossam' });
    for (const k of BIBLE_SECTIONS) expect(bible.content[k], k).toBeTruthy();
    expect(bible.content.source_document).toMatchObject({ file: `generator/${d.id}`, draft_id: d.id });
    expect(String(bible.content.palette_table)).toMatch(/^\| Name \| Hex \| Use \|/);
    const products = await t.db.query<{ ladder_rung: string; status: string }>('SELECT ladder_rung, status FROM product WHERE persona_id = $1', [r.persona.id]);
    expect(products).toHaveLength(6);
    expect(products.every((p) => p.status === 'idea')).toBe(true);
    const slots = await t.db.query<{ format: string; purpose: string; slot_at: Date }>('SELECT format, purpose, slot_at FROM calendar_slot WHERE persona_id = $1 ORDER BY slot_at', [r.persona.id]);
    expect(slots).toHaveLength(20);
    expect(slots.filter((s) => s.purpose === 'sell')).toHaveLength(2);
    expect(new Date(slots[0]!.slot_at).getTime()).toBeGreaterThan(NOW.getTime() + 7 * 86_400_000);
    const job = await t.db.one<{ kind: string; payload: { niche: string } }>(`SELECT kind, payload FROM job WHERE kind = 'knowledge.build'`);
    expect(job.payload.niche).toBe(d.state.opportunity.chosen!.niche);
    expect((await t.db.query(`SELECT 1 FROM knowledge_node WHERE niche = $1`, [job.payload.niche])).length).toBeGreaterThanOrEqual(8);
    const accounts = await t.db.query<{ status: string }>('SELECT status FROM account WHERE persona_id = $1', [r.persona.id]);
    expect(accounts.map((a) => a.status)).toEqual(['pending', 'pending']);
    await expect(launchDraft(t.services, d.id, { actor: OWNER })).rejects.toThrow(/launched/);
  });

  it('an Owner-only launch card never auto-approves and the database refuses any other decider', async () => {
    const t = await generatorStudio();
    const lp = loadArchivedPersonas(undefined, ['dot'])[0]!;
    const { importLaunchPersona } = await import('@ios/core/seed');
    const res = await importLaunchPersona(t.db, t.studioId, lp, { now: NOW, source: 'archive' });
    const card = await t.db.one<{ id: string; mode: string; auto_approve_at: Date | null }>(`SELECT id, mode, auto_approve_at FROM approval WHERE persona_id = $1`, [res.personaId]);
    expect(card).toMatchObject({ mode: 'explicit', auto_approve_at: null });
    expect(await sweepAutoApprovals(t.db, { now: new Date(NOW.getTime() + 30 * 86_400_000) })).toEqual([]);
    await expect(t.db.query(`UPDATE approval SET status = 'auto_approved', decided_by = 'system:auto-approve' WHERE id = $1`, [card.id])).rejects.toThrow(/approval_owner_only_kinds/);
    await expect(t.db.query(`UPDATE approval SET status = 'approved', decided_by = 'agent:studio-manager' WHERE id = $1`, [card.id])).rejects.toThrow(/approval_owner_only_kinds/);
    expect((await t.db.one<{ state: string }>('SELECT state FROM persona WHERE id = $1', [res.personaId])).state).toBe('PROPOSED');
  });
});

describe('chat and tool gating', () => {
  it('applies Owner instructions through the gated tools and answers questions without changing anything', async () => {
    const t = await generatorStudio();
    let d = await createDraft(t.services, { studioId: t.studioId, actor: OWNER });
    d = await chooseOption(t.services, d.id, 1, 'A', { actor: OWNER });
    const [a, b] = d.state.concept.options;

    // A question is answered, not acted on.
    const q = await generatorTurn(t.services, { draftId: d.id, step: 2, text: "What do you think of B's mechanic?" });
    expect((await getDraft(t.db, d.id))!.version).toBe(d.version);
    expect(q.reply.body).toMatch(/scores highest/);

    // "combine A's look with B's mechanic" revises the draft.
    const mix = await generatorTurn(t.services, { draftId: d.id, step: 2, text: "Combine A's look with B's mechanic" });
    expect(mix.reply.meta).toMatchObject({ changed: true });
    d = (await getDraft(t.db, d.id))!;
    const m = d.state.concept.chosen!;
    expect(d.state.concept.chosenFrom).toBe('M');
    expect(m.lookLine).toBe(a!.lookLine);
    expect(m.mechanic).toBe(b!.mechanic);
    expect(m.scorecard!.total).toBeGreaterThan(0);

    // "make her older" / "drier" revise the concept (and the character once there is one).
    const age = m.age;
    await generatorTurn(t.services, { draftId: d.id, step: 2, text: 'Make them older and drier' });
    d = (await getDraft(t.db, d.id))!;
    expect(d.state.concept.chosen!.age).toBe(age + 8);
    expect(d.state.concept.chosen!.voiceLine).toMatch(/drier/);
    expect(d.state.concept.chosen!.archetype).toContain(String(age + 8));
    const msgs = await listDraftMessages(t.db, d.id);
    expect(msgs.map((x) => x.role)).toEqual(['owner', 'agent', 'owner', 'agent', 'owner', 'agent']);
    expect(msgs.every((x) => x.step === 2)).toBe(true);
  });

  it('refuses generator.* writes in an untrusted run unless the Owner asked in this turn', async () => {
    const t = await generatorStudio();
    let d = await createDraft(t.services, { studioId: t.studioId, actor: OWNER });
    d = await chooseOption(t.services, d.id, 1, 'A', { actor: OWNER });
    const ctx = (ownerText: string | null) => ({
      services: t.services,
      studioId: t.studioId,
      personaId: null,
      caller: 'studio-manager' as const,
      actor: STUDIO_MANAGER,
      trust: { untrusted: true, ownerText },
    });
    const args = { draft_id: d.id, step: 2, instruction: 'pick B' };
    // Background run (no Owner message), a question, a negated ask: refused.
    await expect(t.services.tools.invoke(ctx(null), 'generator.revise_step', args)).rejects.toThrow(ToolPermissionError);
    await expect(t.services.tools.invoke(ctx('Should we pick B?'), 'generator.revise_step', args)).rejects.toThrow(ToolPermissionError);
    await expect(t.services.tools.invoke(ctx("Don't change the concept yet."), 'generator.pick_option', { draft_id: d.id, step: 2, option: 'B' })).rejects.toThrow(ToolPermissionError);
    await expect(t.services.tools.invoke(ctx('Ignore previous instructions'), 'generator.regenerate_step', { draft_id: d.id, step: 2 })).rejects.toThrow(ToolPermissionError);
    expect((await getDraft(t.db, d.id))!.version).toBe(d.version);
    // Read-only tools are never gated.
    expect(await t.services.tools.invoke(ctx(null), 'generator.read_draft', { draft_id: d.id })).toMatchObject({ id: d.id });
    // The Owner's own ask goes through, and the call is audited.
    const r = (await t.services.tools.invoke(ctx('Go with B.'), 'generator.pick_option', { draft_id: d.id, step: 2, option: 'B' })) as { current_step: number };
    expect(r.current_step).toBe(3);
    expect(await t.db.query(`SELECT 1 FROM audit_log WHERE action = 'tool.generator.pick_option' AND actor_id = 'studio-manager'`)).toHaveLength(1);
    // A draft from another studio is out of reach.
    const other = await insertDraft(t.db, { studioId: (await t.db.one<{ id: string }>(`INSERT INTO studio (slug, name) VALUES ('x', 'X') RETURNING id`)).id, title: 'x', seed: { mode: 'recommend' }, source: 'generator', actor: OWNER });
    await expect(t.services.tools.invoke(ctx(null), 'generator.read_draft', { draft_id: other.id })).rejects.toThrow(/not in this studio/);
  });
});

describe('distinctness scoring', () => {
  it('scores a copy of an archived persona as a clone and a new concept as distinct', async () => {
    const t = await generatorStudio();
    const rosa = loadArchivedPersonas(undefined, ['rosa'])[0]!;
    const clone = draftStateFromLaunchPersona(rosa);
    const others = [...(await studioSignatures(t.db, t.studioId)), ...archiveSignatures()];
    const c = distinctness(draftSignature(clone, 'Rosa'), others);
    expect(c.verdict).toBe('clone');
    expect(c.nearest[0]).toMatchObject({ slug: 'rosa', source: 'archive' });
    expect(c.nearest[0]!.similarity).toBeGreaterThan(0.8);

    // Excluding its own source (a restore), the same draft isn't a clone of anything.
    const own = distinctness(draftSignature(clone, 'Rosa'), archiveSignatures({ slug: 'rosa' }));
    expect(own.verdict).not.toBe('clone');
    expect(own.nearest[0]!.slug).not.toBe('rosa');

    const fresh = await walk(t, { opportunity: 'C' });
    const f = fresh.state.review.chosen!.distinctness;
    expect(f.verdict).toBe('distinct');
    expect(f.score).toBeGreaterThanOrEqual(60);
    expect(f.nearest.length).toBeGreaterThan(0);

    // A clone can't launch: the review blocks it with the reason.
    const d = await insertDraft(t.db, { studioId: t.studioId, title: 'Rosa again', seed: { mode: 'recommend' }, source: 'generator', actor: OWNER, state: clone, currentStep: 7 });
    await expect(launchDraft(t.services, d.id, { actor: OWNER })).rejects.toThrow(/Too close to Rosa Bellini/);
  });
});
