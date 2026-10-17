import { reviseBible } from '@troupe/agents';
import { ApprovalError, decide, OWNER, propose, proposeArchive, proposeKill, STUDIO_MANAGER, studioWall, sweepAutoApprovals, transition } from '@troupe/core';
import { archiveLabels, launchPersonaSlugs, loadArchivedPersonas, seed } from '@troupe/core/seed';
import { createTestDb } from '@troupe/db/testing';
import { describe, expect, it } from 'vitest';
import { archiveOverview, archiveStudioPersona, getDraft, launchDraft, restoreFromArchive, restoreStudioPersona } from '../src';
import { generatorStudio, NOW } from './helpers';

type T = Awaited<ReturnType<typeof generatorStudio>>;
const ARCHIVE = '2026-10-16';
const LAUNCH_FIVE = ['ambrose', 'dot', 'margot', 'rosa', 'sal'];

async function snapshot(t: T, personaId: string) {
  return {
    bibles: await t.db.query(`SELECT version, status, content, created_by, approved_by FROM persona_bible WHERE persona_id = $1 ORDER BY version`, [personaId]),
    products: await t.db.query(`SELECT name, slug, ladder_rung, status, price_cents FROM product WHERE persona_id = $1 ORDER BY slug`, [personaId]),
    slots: (await t.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM calendar_slot WHERE persona_id = $1`, [personaId])).n,
    accounts: await t.db.query(`SELECT platform, handle, status FROM account WHERE persona_id = $1 ORDER BY platform`, [personaId]),
  };
}

describe('the empty default seed', () => {
  it('seeds a studio with no personas, slots or products, and points to the generator', async () => {
    const db = await createTestDb();
    const s = await seed(db, { now: NOW });
    expect(s).toMatchObject({ kind: 'empty', personas: [] });
    for (const table of ['persona', 'calendar_slot', 'product', 'idea', 'approval', 'persona_bible', 'knowledge_node']) {
      expect((await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).n, table).toBe(0);
    }
    expect(await studioWall(db, s.studioId, NOW)).toEqual([]);
    const threads = await db.query<{ kind: string }>(`SELECT kind FROM chat_thread ORDER BY kind`);
    expect(threads.map((x) => x.kind)).toEqual(['monetization', 'quality', 'studio']);
    const hello = await db.one<{ body: string }>(`SELECT body FROM chat_message`);
    expect(hello.body).toMatch(/\/generator/);
    expect(hello.body).toMatch(/\/archive/);
    await db.close();
  });

  it('keeps the launch five in the dated archive, and nothing in the live seed folder', () => {
    expect(launchPersonaSlugs()).toEqual([]);
    expect(archiveLabels()).toContain(ARCHIVE);
    expect(loadArchivedPersonas(ARCHIVE).map((p) => p.slug)).toEqual(LAUNCH_FIVE);
  });
});

describe('archive → restore round trip', () => {
  it('restores an archived persona exactly, as PROPOSED, waiting for the Owner in the review step', async () => {
    const t = await generatorStudio();
    const rosa = loadArchivedPersonas(ARCHIVE, ['rosa'])[0]!;
    await expect(restoreFromArchive(t.services, { studioId: t.studioId, slugs: ['rosa'], actor: STUDIO_MANAGER })).rejects.toThrow(ApprovalError);

    const [out] = await restoreFromArchive(t.services, { studioId: t.studioId, slugs: ['rosa'], from: ARCHIVE, actor: OWNER });
    expect(out).toMatchObject({ slug: 'rosa', status: 'restored' });
    const p = await t.db.one<{ id: string; state: string; name: string }>(`SELECT id, state, name FROM persona WHERE slug = 'rosa'`);
    expect(p).toMatchObject({ id: out!.personaId, state: 'PROPOSED', name: 'Rosa Bellini' });

    // Exact: the bible as archived, the product ladder, the launch plan.
    const snap = await snapshot(t, p.id);
    expect(snap.bibles).toHaveLength(1);
    expect(snap.bibles[0]).toMatchObject({ version: 1, status: 'approved', content: rosa.bible });
    expect(snap.products.map((x: any) => [x.name, x.ladder_rung, x.price_cents])).toEqual(
      [...rosa.products].sort((a, b) => a.slug.localeCompare(b.slug)).map((x) => [x.name, x.rung, x.priceCents]),
    );
    expect(snap.accounts).toEqual([
      { platform: 'instagram', handle: 'rosareadsyourtexts', status: 'pending' },
      { platform: 'tiktok', handle: 'rosareadsyourtexts', status: 'pending' },
    ]);

    // The launch waits for the Owner: explicit, Owner-only, no timer.
    const card = await t.db.one<{ mode: string; payload: Record<string, unknown> }>(`SELECT mode, payload FROM approval WHERE persona_id = $1 AND kind = 'persona_launch'`, [p.id]);
    expect(card).toMatchObject({ mode: 'explicit', payload: { owner_only: true, source: 'archive' } });
    expect(await sweepAutoApprovals(t.db, { now: new Date(NOW.getTime() + 60 * 86_400_000) })).toEqual([]);

    // …in the Persona Generator's review step.
    const d = (await getDraft(t.db, out!.draftId!))!;
    expect(d).toMatchObject({ source: 'archive', current_step: 7, persona_id: p.id, archive_ref: { label: ARCHIVE, slug: 'rosa' }, status: 'active' });
    expect(d.state.review.chosen).toMatchObject({ ready: true, missing: [] });
    expect(d.state.review.chosen!.distinctness.nearest.every((n) => n.slug !== 'rosa')).toBe(true);

    await expect(launchDraft(t.services, d.id, { actor: STUDIO_MANAGER })).rejects.toThrow(/only the Owner/);
    const launched = await launchDraft(t.services, d.id, { actor: OWNER });
    expect(launched.persona.state).toBe('SETUP');
    expect(launched.approval).toMatchObject({ status: 'approved', decided_by: 'owner:hossam' });
    expect(await snapshot(t, p.id)).toEqual(snap); // launching changed nothing in the documents

    // Restoring again is a no-op with a reason.
    const again = await restoreFromArchive(t.services, { studioId: t.studioId, slugs: ['rosa', 'nobody'], actor: OWNER });
    expect(again.map((r) => r.status)).toEqual(['skipped', 'skipped']);
    expect(again[1]!.reason).toMatch(/not in the archive/);
  });

  it('restores all five, and the archive page lists them with their studio state', async () => {
    const t = await generatorStudio();
    const out = await restoreFromArchive(t.services, { studioId: t.studioId, slugs: 'all', actor: OWNER });
    expect(out.map((r) => [r.slug, r.status])).toEqual(LAUNCH_FIVE.map((s) => [s, 'restored']));
    const drafts = await t.db.query<{ state: { review: { chosen: { ready: boolean; missing: string[] } } } }>(`SELECT state FROM persona_draft`);
    expect(drafts).toHaveLength(5);
    expect(drafts.every((x) => x.state.review.chosen.ready)).toBe(true);
    const o = await archiveOverview(t.services, t.studioId);
    expect(o.files.map((f) => [f.slug, f.inStudio?.state])).toEqual(LAUNCH_FIVE.map((s) => [s, 'PROPOSED']));
    expect(o.files.find((f) => f.slug === 'rosa')!.productDocs).toContain('product-1.md');
  });

  it('soft-archives a live persona and restores every bible version and product exactly', async () => {
    const t = await generatorStudio();
    const [out] = await restoreFromArchive(t.services, { studioId: t.studioId, slugs: ['dot'], actor: OWNER });
    await launchDraft(t.services, out!.draftId!, { actor: OWNER });
    const id = out!.personaId!;
    expect(await reviseBible(t.db, { personaId: id, studioId: t.studioId, section: 'content_dna', rule: 'Hooks under 8 words.', actor: OWNER })).toBe(2);
    expect(await reviseBible(t.db, { personaId: id, studioId: t.studioId, section: 'voice', rule: 'Say "love" less.', actor: OWNER })).toBe(3);
    await t.db.query(`UPDATE product SET status = 'approved' WHERE persona_id = $1 AND ladder_rung = 'entry'`, [id]);
    const before = await snapshot(t, id);
    expect(before.bibles.map((b: any) => [b.version, b.status])).toEqual([[1, 'superseded'], [2, 'superseded'], [3, 'approved']]);

    // SETUP and never live: the Studio Manager may archive it without an approval.
    await archiveStudioPersona(t.services, { personaId: id, actor: STUDIO_MANAGER, reason: 'Owner asked to pause the food niche' });
    const parked = await t.db.one<{ state: string; archived_from_state: string }>('SELECT state, archived_from_state FROM persona WHERE id = $1', [id]);
    expect(parked).toEqual({ state: 'ARCHIVED', archived_from_state: 'SETUP' });
    expect(await studioWall(t.db, t.studioId, NOW)).toEqual([]);
    expect((await archiveOverview(t.services, t.studioId)).parked).toMatchObject([{ id, from: 'SETUP', bible_versions: 3 }]);
    await expect(restoreStudioPersona(t.services, { personaId: id, actor: STUDIO_MANAGER })).rejects.toThrow(/only the Owner/);

    const r = await restoreStudioPersona(t.services, { personaId: id, actor: OWNER });
    expect(r).toEqual({ state: 'SETUP', draftId: null });
    expect(await snapshot(t, id)).toEqual(before);
    expect((await studioWall(t.db, t.studioId, NOW)).map((c) => c.persona.id)).toEqual([id]);
    const log = await t.db.query<{ from_state: string; to_state: string }>(`SELECT from_state, to_state FROM persona_state_log WHERE persona_id = $1 ORDER BY created_at`, [id]);
    expect(log.slice(-2)).toEqual([{ from_state: 'SETUP', to_state: 'ARCHIVED' }, { from_state: 'ARCHIVED', to_state: 'SETUP' }]);
  });

  it('archiving a launched persona needs the Owner; killing still needs its own approval', async () => {
    const t = await generatorStudio();
    const [out] = await restoreFromArchive(t.services, { studioId: t.studioId, slugs: ['margot'], actor: OWNER });
    await launchDraft(t.services, out!.draftId!, { actor: OWNER });
    const id = out!.personaId!;
    await transition(t.db, { personaId: id, to: 'TESTING', actor: OWNER });

    // An agent can't archive it, only propose; the card is Owner-only and never auto-approves.
    await expect(archiveStudioPersona(t.services, { personaId: id, actor: STUDIO_MANAGER })).rejects.toThrow(/needs the Owner/);
    const p = await proposeArchive(t.db, { personaId: id, rationale: 'Overlaps the new wealth persona', proposedBy: STUDIO_MANAGER });
    expect(p.archived).toBe(false);
    const card = (p as { approval: { id: string; mode: string; payload: Record<string, unknown> } }).approval;
    expect(card.mode).toBe('explicit');
    expect(await sweepAutoApprovals(t.db, { now: new Date(NOW.getTime() + 60 * 86_400_000) })).toEqual([]);
    await expect(decide(t.db, { approvalId: card.id, decision: 'approve', actor: STUDIO_MANAGER })).rejects.toThrow(/only the Owner/);

    // The Owner on the dashboard types the name.
    await expect(archiveStudioPersona(t.services, { personaId: id, actor: OWNER })).rejects.toThrow(/type Margot from 2075 exactly/);
    // The Owner approves the card instead: archived from TESTING.
    await decide(t.db, { approvalId: card.id, decision: 'approve', actor: OWNER });
    expect(await t.db.one('SELECT state, archived_from_state FROM persona WHERE id = $1', [id])).toEqual({ state: 'ARCHIVED', archived_from_state: 'TESTING' });

    // Archived personas can't be killed or launched; a kill is a separate, explicit decision.
    await expect(proposeKill(t.db, { personaId: id, rationale: 'x', proposedBy: STUDIO_MANAGER })).rejects.toThrow(/not a valid transition/);
    await expect(propose(t.db, { studioId: t.studioId, personaId: id, kind: 'persona_archive', title: 'again', proposedBy: STUDIO_MANAGER })).rejects.toThrow(/nothing to archive/);
    await restoreStudioPersona(t.services, { personaId: id, actor: OWNER });
    expect((await t.db.one<{ state: string }>('SELECT state FROM persona WHERE id = $1', [id])).state).toBe('TESTING');
    await expect(transition(t.db, { personaId: id, to: 'KILLED', actor: OWNER })).rejects.toThrow(/needs an approved persona_kill/);
    await expect(archiveStudioPersona(t.services, { personaId: id, actor: OWNER, confirmName: 'Margot from 2075' })).resolves.toMatchObject({ state: 'ARCHIVED' });
  });

  it('a never-launched persona archived from review comes back to its review draft', async () => {
    const t = await generatorStudio();
    const [out] = await restoreFromArchive(t.services, { studioId: t.studioId, slugs: ['ambrose'], actor: OWNER });
    await archiveStudioPersona(t.services, { personaId: out!.personaId!, actor: OWNER });
    expect((await getDraft(t.db, out!.draftId!))!.status).toBe('archived');
    expect(await t.db.query(`SELECT 1 FROM approval WHERE persona_id = $1 AND status = 'pending'`, [out!.personaId])).toHaveLength(0);

    const again = await restoreFromArchive(t.services, { studioId: t.studioId, slugs: ['ambrose'], actor: OWNER });
    expect(again[0]).toMatchObject({ status: 'unarchived', draftId: out!.draftId });
    expect((await getDraft(t.db, out!.draftId!))!.status).toBe('active');
    const launched = await launchDraft(t.services, out!.draftId!, { actor: OWNER });
    expect(launched.persona.state).toBe('SETUP');
  });
});
