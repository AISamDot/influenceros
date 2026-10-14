import { activeKillSwitches, findThread, ForbiddenError, OWNER, STUDIO_MANAGER } from '@ios/core';
import { json } from '@ios/db';
import { describe, expect, it } from 'vitest';
import { A_TOOLS, acceptOwnerMessage, measureFeedbackEffects, respondToOwner, type ToolContext, ToolPermissionError } from '../src';
import { createTestStudio, makeTestPersona } from '../src/testing';

const BIBLE = {
  voice: { energy: 'Warm, steady', avoid: ['shame words'] },
  content_dna: { hook_library: ['"Stop wasting your salary on coffee."'] },
  compliance: { never_claims: ['credentials'] },
};

async function setup() {
  const t = await createTestStudio({ tools: A_TOOLS });
  const viv = await makeTestPersona(t, { name: 'Vivian Hale' });
  const amos = await makeTestPersona(t, { name: 'Amos Reed' });
  await t.db.query(
    `INSERT INTO persona_bible (persona_id, version, content, status, created_by, approved_by, approved_at) VALUES ($1, 1, $2::jsonb, 'approved', 'agent:persona-designer', 'owner:hossam', now())`,
    [viv.id, json(BIBLE)],
  );
  await t.db.query('UPDATE persona SET current_bible_version = 1 WHERE id = $1', [viv.id]);
  const thread = await findThread(t.db, t.studioId, 'persona', viv.id);
  const say = async (body: string) => {
    const { thread: th, owner } = await acceptOwnerMessage(t.services, thread.id, body);
    return (await respondToOwner(t.services, { thread: th, owner })).reply;
  };
  return { ...t, viv, amos, thread, say };
}

const feedbackRows = (t: Awaited<ReturnType<typeof setup>>) =>
  t.db.query<{ class: string; status: string }>('SELECT class, status FROM feedback WHERE persona_id = $1 ORDER BY created_at', [t.viv.id]);

describe('Persona Manager feedback loop', () => {
  it('classify → before/after → Yes → Bible vN+1 → audited → confirmed', async () => {
    const t = await setup();
    const proposal = await t.say("Her hooks feel preachy. Make them warmer, and drop the money-shaming.");
    expect(proposal.author).toBe('agent:persona-manager');
    expect(proposal.body).toMatch(/^Got it: .*\(persona rule\)\./);
    expect(proposal.body).toMatch(/Before: Stop wasting your salary on coffee/);
    expect(proposal.body).toMatch(/After: /);
    expect(proposal.body).toMatch(/Tap Apply or reply "yes"/);
    expect(proposal.meta.feedback).toMatchObject({ status: 'proposed', class: 'persona_rule' });
    expect(await feedbackRows(t)).toEqual([{ class: 'persona_rule', status: 'proposed' }]);
    // Nothing changes before the Yes.
    expect((await t.db.one<{ v: number }>('SELECT current_bible_version AS v FROM persona WHERE id = $1', [t.viv.id])).v).toBe(1);

    const done = await t.say('yes');
    expect(done.body).toMatch(/Bible v2 is live \(content dna\)/);
    expect(await feedbackRows(t)).toEqual([{ class: 'persona_rule', status: 'applied' }]);
    const bible = await t.db.query<{ version: number; status: string; content: { content_dna: { owner_rules: string[] }; changelog: unknown[] } }>(
      'SELECT version, status, content FROM persona_bible WHERE persona_id = $1 ORDER BY version',
      [t.viv.id],
    );
    expect(bible.map((b) => [b.version, b.status])).toEqual([
      [1, 'superseded'],
      [2, 'approved'],
    ]);
    expect(bible[1]!.content.content_dna.owner_rules[0]).toMatch(/warmer/);
    expect(bible[1]!.content.changelog).toHaveLength(1);
    expect((await t.db.one<{ v: number }>('SELECT current_bible_version AS v FROM persona WHERE id = $1', [t.viv.id])).v).toBe(2);
    const audit = (await t.db.query<{ action: string; actor_id: string }>(`SELECT action, actor_id FROM audit_log WHERE persona_id = $1 AND action LIKE ANY(ARRAY['feedback.%','bible.%']) ORDER BY id`, [t.viv.id])).map((a) => `${a.action}:${a.actor_id}`);
    expect(audit).toEqual(['feedback.proposed:persona-manager', 'bible.revised:hossam', 'feedback.applied:hossam']);
    await t.db.close();
  });

  it('routes strategy to the playbook, studio-wide to the Studio Manager, applies one-offs now and drops a No', async () => {
    const t = await setup();
    await t.say('Post more carousels and fewer statics for her.');
    await t.say('yes');
    const rule = await t.db.one<{ scope: string; status: string; source: string }>(`SELECT scope, status, source FROM playbook_rule WHERE persona_id = $1`, [t.viv.id]);
    expect(rule).toEqual({ scope: 'persona', status: 'active', source: 'feedback' });

    const studio = await t.say('Every persona should avoid hype words, make that studio-wide.');
    expect(studio.body).toMatch(/goes to the Studio Manager/);
    await t.say('yes');
    expect(await t.db.one<{ scope: string; status: string }>(`SELECT scope, status FROM playbook_rule WHERE scope = 'studio'`)).toEqual({ scope: 'studio', status: 'proposed' });

    const oneOff = await t.say("Make this post's hook shorter.");
    expect(oneOff.body).toMatch(/Applied now/);
    expect((await t.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM decision WHERE persona_id = $1`, [t.viv.id])).n).toBe(1);

    await t.say('Use a softer voice in the replies.');
    const no = await t.say('not now');
    expect(no.body).toMatch(/Dropped it/);
    expect((await feedbackRows(t)).map((f) => `${f.class}:${f.status}`)).toEqual([
      'strategy:applied',
      'studio:applied',
      'one_off:applied',
      'persona_rule:rejected',
    ]);
    await t.db.close();
  });

  it('questions get numbers, not a feedback entry; /status, /pause and /resume work', async () => {
    const t = await setup();
    const q = await t.say('How many views did she get this week?');
    expect(q.body).toMatch(/Vivian Hale · testing · L1/);
    expect(await feedbackRows(t)).toEqual([]);
    expect((await t.say('/status')).body).toMatch(/Last 7 days/);
    await t.say('/pause');
    expect(await activeKillSwitches(t.db, t.studioId)).toMatchObject([{ scope: 'persona', persona_id: t.viv.id, set_by: 'owner:hossam' }]);
    await t.say('/resume');
    expect(await activeKillSwitches(t.db, t.studioId)).toEqual([]);
    await t.db.close();
  });

  it('compliance and disclosure text never change without the Owner: they become an approval card', async () => {
    const t = await setup();
    const { logFeedback, applyFeedback } = await import('../src');
    const row = await logFeedback(t.db, {
      personaId: t.viv.id,
      studioId: t.studioId,
      text: 'change her disclosure',
      proposal: { class: 'persona_rule', restated: 'x', before: 'a', after: 'b', section: 'compliance', rule: 'new text', applies_from: 'now' },
    });
    const r = await applyFeedback(t.db, { feedbackId: row.id, actor: OWNER, studioId: t.studioId });
    expect(r.result.approvalId).toBeDefined();
    const a = await t.db.one<{ kind: string; mode: string; status: string }>('SELECT kind, mode, status FROM approval WHERE id = $1', [r.result.approvalId]);
    expect(a).toEqual({ kind: 'legal_text_change', mode: 'explicit', status: 'pending' });
    expect((await t.db.one<{ v: number }>('SELECT current_bible_version AS v FROM persona WHERE id = $1', [t.viv.id])).v).toBe(1);
    await t.db.close();
  });
});

describe('tool permissions (in code)', () => {
  it("a Persona Manager can't touch another persona or any Owner-only action", async () => {
    const t = await setup();
    const asManager: ToolContext = { services: t.services, studioId: t.studioId, personaId: t.viv.id, caller: 'persona-manager', actor: { type: 'agent', id: 'persona-manager' } };
    const tools = t.services.tools;
    // Its own persona: fine.
    expect(await tools.invoke(asManager, 'persona.status', { persona_id: t.viv.id })).toMatchObject({ name: 'Vivian Hale' });
    // Another persona: refused for reads and writes.
    await expect(tools.invoke(asManager, 'persona.status', { persona_id: t.amos.id })).rejects.toBeInstanceOf(ToolPermissionError);
    await expect(tools.invoke(asManager, 'bible.revise', { persona_id: t.amos.id, section: 'voice', rule: 'x' })).rejects.toBeInstanceOf(ToolPermissionError);
    // Studio Manager-only and Owner-only tools: refused, and not even listed.
    await expect(tools.invoke(asManager, 'studio.propose_kill', { persona_id: t.viv.id, action: 'kill', rationale: 'x' })).rejects.toBeInstanceOf(ToolPermissionError);
    await expect(tools.invoke(asManager, 'studio.pause_posting', { scope: 'global', reason: 'x' })).rejects.toBeInstanceOf(ToolPermissionError);
    await expect(tools.invoke(asManager, 'approvals.decide', { approval_id: t.viv.id, decision: 'approve' })).rejects.toBeInstanceOf(ToolPermissionError);
    await expect(tools.invoke(asManager, 'feedback.decide', { feedback_id: t.viv.id, decision: 'apply' })).rejects.toBeInstanceOf(ToolPermissionError);
    const visible = tools.list({ caller: 'persona-manager' }).map((d) => d.name);
    expect(visible).not.toContain('studio.propose_kill');
    expect(visible).not.toContain('approvals.decide');
    // Raising autonomy or caps is the Owner's; lowering is allowed.
    await expect(tools.invoke(asManager, 'persona.lower_controls', { persona_id: t.viv.id, autonomy: 'L2' })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(tools.invoke(asManager, 'persona.lower_controls', { persona_id: t.viv.id, llm_usd_month: 500 })).rejects.toBeInstanceOf(ForbiddenError);
    await tools.invoke(asManager, 'persona.lower_controls', { persona_id: t.viv.id, autonomy: 'L0' });
    // Compliance text isn't a section it can revise.
    await expect(tools.invoke(asManager, 'bible.revise', { persona_id: t.viv.id, section: 'compliance', rule: 'x' })).rejects.toThrow(/section must be one of/);
    // An agent can never borrow the Owner's authority.
    await expect(tools.invoke({ ...asManager, actor: OWNER }, 'persona.status', { persona_id: t.viv.id })).rejects.toBeInstanceOf(ToolPermissionError);
    // Pending approvals: only its own persona's.
    const asStudio: ToolContext = { ...asManager, personaId: null, caller: 'studio-manager', actor: STUDIO_MANAGER };
    await tools.invoke(asStudio, 'studio.propose_kill', { persona_id: t.amos.id, action: 'kill', rationale: 'weak' });
    expect(await tools.invoke(asManager, 'approvals.pending', {})).toEqual([]);
    expect(await tools.invoke(asStudio, 'approvals.pending', {})).toHaveLength(1);
    // Mutating calls are audited.
    const audited = await t.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'tool.studio.propose_kill'`);
    expect(audited.n).toBe(1);
    await t.db.close();
  });

  it("the Owner's feedback decision is an Owner-only tool", async () => {
    const t = await setup();
    const proposal = await t.say('Make her voice warmer.');
    const id = (proposal.meta.feedback as { id: string }).id;
    const asOwner: ToolContext = { services: t.services, studioId: t.studioId, personaId: null, caller: 'owner', actor: OWNER };
    expect(await t.services.tools.invoke(asOwner, 'feedback.decide', { feedback_id: id, decision: 'apply' })).toMatchObject({ status: 'applied', result: { bibleVersion: 2 } });
    await expect(t.services.tools.invoke(asOwner, 'feedback.decide', { feedback_id: id, decision: 'apply' })).rejects.toThrow(/already applied/);
    await t.db.close();
  });
});

describe('feedback effect review', () => {
  it('measures views and saves per post the week before and after a change', async () => {
    const t = await setup();
    const proposal = await t.say('Make her voice warmer.');
    await t.say('yes');
    const id = (proposal.meta.feedback as { id: string }).id;
    const appliedAt = new Date(Date.now() - 10 * 86_400_000);
    await t.db.query(`UPDATE feedback SET applied_change = applied_change || $2::jsonb WHERE id = $1`, [id, json({ applied_at: appliedAt.toISOString() })]);
    const post = async (daysFromChange: number, views: number) => {
      const { id: pid } = await t.db.one<{ id: string }>(
        `INSERT INTO post (persona_id, platform, format, status, published_at) VALUES ($1, 'tiktok', 'talking', 'live', $2) RETURNING id`,
        [t.viv.id, new Date(appliedAt.getTime() + daysFromChange * 86_400_000)],
      );
      await t.db.query(`INSERT INTO metric_snapshot (persona_id, post_id, captured_on, views, saves) VALUES ($1, $2, current_date, $3, $4)`, [t.viv.id, pid, views, views / 100]);
    };
    await post(-2, 1000);
    await post(2, 1500);
    expect(await measureFeedbackEffects(t.db)).toBe(1);
    const f = await t.db.one<{ effect: { views_change_pct: number; before: { posts: number } } }>('SELECT effect FROM feedback WHERE id = $1', [id]);
    expect(f.effect).toMatchObject({ views_change_pct: 50, before: { posts: 1 } });
    expect(await measureFeedbackEffects(t.db)).toBe(0);
    await t.db.close();
  });
});
