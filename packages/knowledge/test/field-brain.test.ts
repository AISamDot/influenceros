import { makeTestPersona } from '@troupe/agents/testing';
import { DeferJob, updateSettings, OWNER } from '@troupe/core';
import { describe, expect, it } from 'vitest';
import { buildFieldBrain, embedPending, fieldBrainStatus, KNOWLEDGE_JOBS, pendingEmbeddings, researchNode } from '../src';
import { drain, knowledgeStudio } from './helpers';

describe('Field Brain (Knowledge Builder on FakeWebResearch)', () => {
  it('builds a niche through jobs and makes it retrievable by similarity, with citations', async () => {
    const t = await knowledgeStudio();
    await makeTestPersona(t, { niche: 'personal finance' });

    const summary = await buildFieldBrain(t.services, { studioId: t.studioId, niche: 'Personal Finance' });
    expect(summary).toMatchObject({ niche: 'personal finance', mode: 'fake', nodes: 6, queued: 6, researched: 0 });
    expect(summary.sources).toBeGreaterThanOrEqual(5);
    expect(summary.experts).toBe(1);

    const ran = await drain(t.services);
    expect(ran.filter((r) => r.kind === KNOWLEDGE_JOBS.researchNode).every((r) => r.outcome === 'succeeded')).toBe(true);
    expect(ran.filter((r) => r.kind === KNOWLEDGE_JOBS.researchNode)).toHaveLength(6);

    const nodes = await t.db.query<{ path: string; facts: Array<{ claim: string; citations: Array<{ url: string; source_id: string | null }> }>; last_verified_at: Date | null; embedding_model: string }>(
      `SELECT path, facts, last_verified_at, embedding_model FROM knowledge_node WHERE studio_id = $1 ORDER BY path`,
      [t.studioId],
    );
    expect(nodes).toHaveLength(6);
    for (const n of nodes) {
      expect(n.last_verified_at).not.toBeNull();
      expect(n.embedding_model).toBe('fake-embeddings');
      expect(n.facts.length).toBeGreaterThan(0);
      expect(n.facts.every((f) => f.citations.length > 0 && f.citations.every((c) => c.source_id))).toBe(true);
    }

    const hits = await t.services.knowledge.retrieve({ studioId: t.studioId, niche: 'personal finance', query: 'personal finance habits that last', k: 3, kinds: ['node'] });
    expect(hits).toHaveLength(3);
    expect(hits[0]!.title).toBe('personal finance: habits');
    expect(hits[0]!.kind).toBe('node');
    expect(hits[0]!.citations.length).toBeGreaterThan(0);
    expect(hits[0]!.citations[0]!.url).toMatch(/^https:\/\/fake\.research\.local\//);
    expect(hits[0]!.score).toBeGreaterThan(hits[2]!.score);
    expect(hits[0]!.lastVerifiedAt).toBeInstanceOf(Date);

    // Another niche or another studio sees nothing.
    expect(await t.services.knowledge.retrieve({ studioId: t.studioId, niche: 'dating', query: 'habits' })).toEqual([]);

    const [status] = await fieldBrainStatus(t.services, t.studioId, 'personal finance');
    expect(status).toMatchObject({ niche: 'personal finance', nodes: 6, researched: 6, embedded: 6, experts: 1 });
    expect(status!.lastBuild?.status).toBe('done');
  });

  it('meters research against the knowledge cost ref and logs the knowledge-builder agent', async () => {
    const t = await knowledgeStudio();
    const s = await buildFieldBrain(t.services, { studioId: t.studioId, niche: 'sleep', inline: true });
    expect(s.researched).toBe(6);
    expect(s.costUsd).toBeGreaterThan(0.05 + 6 * 0.12 - 1e-9);
    const debits = await t.db.query<{ ref_type: string; ref_id: string; provider: string }>(
      `SELECT ref_type, ref_id, provider FROM credit_ledger WHERE entry_type = 'debit' AND unit = 'llm_usd'`,
    );
    expect(debits.filter((d) => d.provider === 'fake-web-research')).toHaveLength(7); // map + 6 nodes
    expect(debits.every((d) => d.ref_type === 'knowledge' && d.ref_id === t.studioId)).toBe(true);
    const runs = await t.db.query<{ agent: string; summary: string }>(`SELECT agent, summary FROM agent_run`);
    expect(runs).toContainEqual({ agent: 'knowledge-builder', summary: 'field-brain plan: sleep' });
    // A second build inside the refresh window re-maps but researches nothing.
    const again = await buildFieldBrain(t.services, { studioId: t.studioId, niche: 'sleep', inline: true });
    expect(again.researched).toBe(0);
    expect(again.nodes).toBe(6);
  });

  it('refreshes weekly only the volatile levels plus a capped slice, and skips nodes that keep failing', async () => {
    const t = await knowledgeStudio();
    await buildFieldBrain(t.services, { studioId: t.studioId, niche: 'sleep', inline: true });
    const age = (days: number) => t.db.query(`UPDATE knowledge_node SET researched_at = $2 WHERE studio_id = $1`, [t.studioId, new Date(t.services.now().getTime() - days * 86_400_000)]);
    await age(8);
    expect((await buildFieldBrain(t.services, { studioId: t.studioId, niche: 'sleep', inline: true })).researched).toBe(2); // debate + frontier
    for (let i = 0; i < 20; i++) {
      await t.db.query(`INSERT INTO knowledge_node (studio_id, niche, path, title, level, origin) VALUES ($1, 'sleep', $2, $3, 'fundamental', 'map')`, [t.studioId, `extra/n${i}`, `extra ${i}`]);
    }
    await age(61);
    expect((await buildFieldBrain(t.services, { studioId: t.studioId, niche: 'sleep', inline: true })).researched).toBe(12); // REFRESH_CAP
    // A node that failed research three times is left out until forced.
    await t.db.query(`UPDATE knowledge_node SET researched_at = NULL, notes = notes || '{"research_failures": 3}'::jsonb WHERE studio_id = $1`, [t.studioId]);
    expect((await buildFieldBrain(t.services, { studioId: t.studioId, niche: 'sleep', inline: true })).researched).toBe(0);
  });

  it('debits what a failed research call already spent', async () => {
    const t = await knowledgeStudio();
    await buildFieldBrain(t.services, { studioId: t.studioId, niche: 'sleep' });
    const node = await t.db.one<{ id: string }>(`SELECT id FROM knowledge_node WHERE studio_id = $1 LIMIT 1`, [t.studioId]);
    t.providers.webResearch.researchTopic = async () => {
      throw Object.assign(new Error('research answer was not valid JSON'), { costUsd: 0.84 });
    };
    await expect(researchNode(t.services, node.id)).rejects.toThrow(/not valid JSON/);
    const d = await t.db.one<{ amount: number }>(`SELECT amount FROM credit_ledger WHERE entry_type = 'debit' AND operation = 'research_topic'`);
    expect(d.amount).toBeCloseTo(0.84);
    expect(await t.db.one(`SELECT count(*)::int AS n FROM credit_ledger WHERE entry_type = 'hold'`)).toEqual({ n: 0 });
    const n = await t.db.one<{ notes: { research_failures?: number } }>('SELECT notes FROM knowledge_node WHERE id = $1', [node.id]);
    expect(n.notes.research_failures).toBe(1);
  });

  it('defers research instead of failing when the studio LLM cap is used up', async () => {
    const t = await knowledgeStudio();
    await buildFieldBrain(t.services, { studioId: t.studioId, niche: 'sleep' });
    const node = await t.db.one<{ id: string }>(`SELECT id FROM knowledge_node WHERE studio_id = $1 LIMIT 1`, [t.studioId]);
    await updateSettings(t.db, t.studioId, { caps: { llm_usd_month: 0.01, hf_credits_month: 8000 } }, OWNER);
    await expect(researchNode(t.services, node.id)).rejects.toBeInstanceOf(DeferJob);
    const n = await t.db.one<{ researched_at: Date | null; research_error: string | null }>('SELECT researched_at, research_error FROM knowledge_node WHERE id = $1', [node.id]);
    expect(n.researched_at).toBeNull();
    expect(n.research_error).toMatch(/cap|budget|exceed/i);
  });

  it('falls back to keyword search when the embedder is down, and re-embeds rows from another model', async () => {
    const t = await knowledgeStudio();
    await buildFieldBrain(t.services, { studioId: t.studioId, niche: 'sleep', inline: true });
    const embed = t.providers.embeddings.embed.bind(t.providers.embeddings);
    t.providers.embeddings.embed = async () => {
      throw new Error('model offline');
    };
    const hits = await t.services.knowledge.retrieve({ studioId: t.studioId, niche: 'sleep', query: 'sleep mistakes' });
    expect(hits[0]?.title).toBe('sleep: mistakes');
    t.providers.embeddings.embed = embed;

    await t.db.query(`UPDATE knowledge_node SET embedding_model = 'old-model' WHERE studio_id = $1`, [t.studioId]);
    expect(await pendingEmbeddings(t.services)).toMatchObject({ nodes: 6 });
    expect(await embedPending(t.services)).toMatchObject({ nodes: 6 });
    expect(await pendingEmbeddings(t.services)).toMatchObject({ nodes: 0 });
  });
});
