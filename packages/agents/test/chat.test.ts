import { activeKillSwitches, findThread, listMessages, listPendingApprovals } from '@ios/core';
import { describe, expect, it } from 'vitest';
import { A_TOOLS, acceptOwnerMessage, newMessageId, respondToOwner } from '../src';
import { createTestStudio, makeTestPersona } from '../src/testing';

async function studio() {
  const t = await createTestStudio({ tools: A_TOOLS });
  const viv = await makeTestPersona(t, { name: 'Vivian Hale' });
  const amos = await makeTestPersona(t, { name: 'Amos Reed' });
  await t.db.query(`INSERT INTO metric_snapshot (persona_id, captured_on, views, followers) VALUES ($1, current_date, 4200, 1300)`, [viv.id]);
  await t.db.query(`INSERT INTO orders (persona_id, amount_cents, ordered_at) VALUES ($1, 1200, now())`, [viv.id]);
  return { ...t, viv, amos };
}

/** Sends a message the way the chat API does: store, pre-allocate the reply id, stream the reply. */
async function send(t: Awaited<ReturnType<typeof studio>>, threadId: string, body: string) {
  const { thread, owner } = await acceptOwnerMessage(t.services, threadId, body);
  const replyId = newMessageId();
  const chunks: string[] = [];
  const turn = await respondToOwner(t.services, { thread, owner, replyId, onText: (d) => chunks.push(d) });
  return { ...turn, chunks, replyId };
}

describe('Studio chat (fake mode)', () => {
  it('streams a Studio Manager reply from the runtime and persists it under the pre-allocated id', async () => {
    const t = await studio();
    const th = await findThread(t.db, t.studioId, 'studio');
    const r = await send(t, th.id, 'How did we do this week?');
    expect(r.chunks.length).toBeGreaterThan(3);
    expect(r.chunks.join('')).toBe(r.reply.body);
    expect(r.reply.id).toBe(r.replyId);
    expect(r.reply).toMatchObject({ role: 'agent', author: 'agent:studio-manager' });
    expect(r.reply.body).toMatch(/2 active personas/);
    expect(r.reply.body).toMatch(/\$12 revenue/);
    expect(r.reply.meta).toMatchObject({ kind: 'reply', fake: true, mode: 'fake' });
    const run = await t.db.one<{ agent: string; ref_type: string; ref_id: string; outcome: string }>(
      'SELECT agent, ref_type, ref_id, outcome FROM agent_run WHERE id = $1',
      [r.reply.meta.runId],
    );
    expect(run).toEqual({ agent: 'studio-manager', ref_type: 'chat_thread', ref_id: th.id, outcome: 'ok' });
    expect((await listMessages(t.db, th.id)).map((m) => m.role)).toEqual(['owner', 'agent']);
    await t.db.close();
  });

  it('@mentions bring in that persona manager, which answers in the Studio thread', async () => {
    const t = await studio();
    const th = await findThread(t.db, t.studioId, 'studio');
    const r = await send(t, th.id, 'How is @vivian doing?');
    expect(r.extra).toHaveLength(1);
    expect(r.extra[0]).toMatchObject({ author: 'agent:persona-manager', persona_id: t.viv.id });
    expect(r.extra[0]!.body).toMatch(/^Vivian Hale · testing/);
    expect(r.extra[0]!.meta).toMatchObject({ personaName: 'Vivian Hale', via: 'owner-mention' });
    expect(r.chunks.join('')).toContain("Vivian Hale's manager:");
    const runs = await t.db.query<{ agent: string; persona_id: string | null }>('SELECT agent, persona_id FROM agent_run ORDER BY started_at');
    expect(runs).toEqual([
      { agent: 'studio-manager', persona_id: null },
      { agent: 'persona-manager', persona_id: t.viv.id },
    ]);
    await t.db.close();
  });

  it('kill requests become an Owner-only approval card in the thread; the persona keeps running', async () => {
    const t = await studio();
    const th = await findThread(t.db, t.studioId, 'studio');
    const r = await send(t, th.id, 'Kill Amos, the numbers are not there.');
    expect(r.reply.body).toMatch(/Opened a kill proposal for Amos Reed/);
    const pending = await listPendingApprovals(t.db, t.studioId);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: 'persona_kill', mode: 'explicit', proposed_by: 'agent:studio-manager', persona_id: t.amos.id });
    const card = (await listMessages(t.db, th.id)).find((m) => m.meta.kind === 'approval_card');
    expect(card?.meta.approvalId).toBe(pending[0]!.id);
    expect((await t.db.one<{ state: string }>('SELECT state FROM persona WHERE id = $1', [t.amos.id])).state).toBe('TESTING');
    await t.db.close();
  });

  it('pauses posting on request (agents can pause, never resume)', async () => {
    const t = await studio();
    const th = await findThread(t.db, t.studioId, 'studio');
    const r = await send(t, th.id, 'Pause all TikTok posting for now');
    expect(r.reply.body).toMatch(/Paused all tiktok posting/);
    const ks = await activeKillSwitches(t.db, t.studioId);
    expect(ks).toMatchObject([{ scope: 'platform', platform: 'tiktok', set_by: 'agent:studio-manager' }]);
    // A question is answered, not acted on.
    await send(t, th.id, 'Should we pause Instagram too?');
    expect(await activeKillSwitches(t.db, t.studioId)).toHaveLength(1);
    await t.db.close();
  });

  it('replies with a notice (not a crash) when the LLM cap is used up', async () => {
    const t = await studio();
    await t.db.query(`UPDATE studio SET settings = jsonb_set(settings, '{caps,llm_usd_month}', '0'::jsonb) WHERE id = $1`, [t.studioId]);
    const th = await findThread(t.db, t.studioId, 'studio');
    const r = await send(t, th.id, 'Status?');
    expect(r.reply.meta).toMatchObject({ kind: 'notice', error: true });
    expect(r.reply.body).toMatch(/studio LLM cap/);
    expect(r.chunks.join('')).toBe(r.reply.body);
    expect((await t.db.one<{ outcome: string }>('SELECT outcome FROM agent_run')).outcome).toBe('refused');
    await t.db.close();
  });

  it('answers the Monetization and Quality threads with their own agents', async () => {
    const t = await studio();
    for (const kind of ['monetization', 'quality'] as const) {
      const th = await findThread(t.db, t.studioId, kind);
      const r = await send(t, th.id, 'Anything to look at?');
      expect(r.reply.author).toBe(kind === 'monetization' ? 'agent:monetization-agent' : 'agent:quality-control');
      expect(r.reply.body.length).toBeGreaterThan(10);
    }
    await t.db.close();
  });

  it('refuses empty messages before any agent runs', async () => {
    const t = await studio();
    const th = await findThread(t.db, t.studioId, 'studio');
    await expect(acceptOwnerMessage(t.services, th.id, '   ')).rejects.toThrow(/empty/);
    expect((await t.db.one<{ n: number }>('SELECT count(*)::int AS n FROM agent_run')).n).toBe(0);
    await t.db.close();
  });
});
