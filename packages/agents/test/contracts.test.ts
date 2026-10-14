import { BudgetExceededError, OWNER, STUDIO_MANAGER } from '@ios/core';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CADENCE, MODEL_IDS, type ToolDef, ToolPermissionError } from '../src';
import { createTestStudio, makeTestPersona } from '../src/testing';

const echo: ToolDef<{ persona_id: string; text: string }, string> = {
  name: 'test.echo',
  description: 'Echoes text for a persona.',
  scope: 'persona',
  mutates: true,
  inputSchema: { type: 'object', properties: { persona_id: { type: 'string' }, text: { type: 'string' } }, required: ['persona_id', 'text'], additionalProperties: false },
  parse: (raw) => {
    const r = raw as { persona_id?: unknown; text?: unknown };
    if (typeof r?.persona_id !== 'string' || typeof r.text !== 'string') throw new Error('bad input');
    return { persona_id: r.persona_id, text: r.text };
  },
  run: async (_ctx, i) => i.text,
};
const ownerOnly: ToolDef<Record<string, never>, string> = {
  name: 'test.owner_thing',
  description: 'Owner-only.',
  scope: 'studio',
  ownerOnly: true,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  parse: () => ({}),
  run: async () => 'done',
};

describe('IOS-2 contracts: fake runtime', () => {
  it('maps tiers to the 5.5 models', () => {
    expect(MODEL_IDS).toEqual({ fast: 'claude-haiku-5-5', standard: 'claude-sonnet-5-5', strong: 'claude-opus-5-5' });
    expect(Object.values(DEFAULT_CADENCE.formatMix).reduce((a, b) => a + b, 0)).toBe(DEFAULT_CADENCE.postsPerWeek);
    expect(Object.values(DEFAULT_CADENCE.purposeMix).reduce((a, b) => a + b, 0)).toBe(DEFAULT_CADENCE.postsPerWeek);
  });

  it('returns the fake output through the governor, attributes the cost and logs agent_run', async () => {
    const t = await createTestStudio();
    const p = await makeTestPersona(t);
    const slot = await t.db.one<{ id: string }>(
      `INSERT INTO calendar_slot (persona_id, slot_at, format, purpose, title) VALUES ($1, now(), 'talking', 'reach', 'x') RETURNING id`,
      [p.id],
    );
    const res = await t.services.runtime.run({
      agent: 'scriptwriter',
      scope: { studioId: t.studioId, personaId: p.id },
      label: 'hook-lab: test',
      system: 'Write hooks.',
      cached: [{ key: `bible:${p.id}:v1`, text: 'Bible text' }],
      prompt: 'Three hooks about saving.',
      parse: (v) => {
        if (!Array.isArray(v)) throw new Error('expected an array');
        return v as string[];
      },
      fake: () => ['Hook one', 'Hook two', 'Hook three'],
      costRef: { type: 'calendar_slot', id: slot.id },
    });
    expect(res.mode).toBe('fake');
    expect(res.output).toEqual(['Hook one', 'Hook two', 'Hook three']);
    expect(res.model).toBe('fake:claude-sonnet-5-5');
    const run = await t.db.one<{ agent: string; summary: string; outcome: string }>('SELECT agent, summary, outcome FROM agent_run WHERE id = $1', [res.runId]);
    expect(run).toEqual({ agent: 'scriptwriter', summary: 'hook-lab: test', outcome: 'ok' });
    const debit = await t.db.one<{ ref_type: string; ref_id: string; amount: number }>(
      `SELECT ref_type, ref_id, amount FROM credit_ledger WHERE entry_type = 'debit' AND persona_id = $1`,
      [p.id],
    );
    expect(debit).toMatchObject({ ref_type: 'calendar_slot', ref_id: slot.id });
    expect(debit.amount).toBeCloseTo(res.costUsd, 6);
    await t.db.close();
  });

  it('refuses past a cap and logs the refusal', async () => {
    const t = await createTestStudio();
    const p = await makeTestPersona(t, { budget: { llm_usd_month: 0 } });
    await expect(
      t.services.runtime.run({ agent: 'persona-manager', scope: { studioId: t.studioId, personaId: p.id }, label: 'x', system: 's', prompt: 'p', fake: () => 'ok' }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect((await t.db.one<{ outcome: string }>('SELECT outcome FROM agent_run')).outcome).toBe('refused');
    await t.db.close();
  });
});

describe('IOS-2 contracts: tool registry', () => {
  it('enforces persona scope and Owner-only tools in code', async () => {
    const t = await createTestStudio({ tools: [echo, ownerOnly] });
    const a = await makeTestPersona(t);
    const b = await makeTestPersona(t);
    const asManager = { services: t.services, studioId: t.studioId, personaId: a.id, caller: 'persona-manager' as const, actor: { type: 'agent' as const, id: 'persona-manager' } };
    expect(await t.services.tools.invoke(asManager, 'test.echo', { persona_id: a.id, text: 'hi' })).toBe('hi');
    await expect(t.services.tools.invoke(asManager, 'test.echo', { persona_id: b.id, text: 'hi' })).rejects.toBeInstanceOf(ToolPermissionError);
    await expect(t.services.tools.invoke(asManager, 'test.owner_thing', {})).rejects.toBeInstanceOf(ToolPermissionError);
    const asStudio = { ...asManager, personaId: null, caller: 'studio-manager' as const, actor: STUDIO_MANAGER };
    expect(await t.services.tools.invoke(asStudio, 'test.echo', { persona_id: b.id, text: 'yo' })).toBe('yo');
    await expect(t.services.tools.invoke(asStudio, 'test.owner_thing', {})).rejects.toBeInstanceOf(ToolPermissionError);
    const asOwner = { ...asStudio, caller: 'owner' as const, actor: OWNER };
    expect(await t.services.tools.invoke(asOwner, 'test.owner_thing', {})).toBe('done');
    expect(t.services.tools.list({ caller: 'persona-manager' }).map((d) => d.name)).toEqual(['test.echo']);
    const audited = await t.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'tool.test.echo'`);
    expect(audited.n).toBe(2);
    await t.db.close();
  });

  it('rejects duplicate and malformed tool names', async () => {
    const t = await createTestStudio({ tools: [echo] });
    expect(() => t.services.tools.register(echo)).toThrow(/duplicate/);
    expect(() => t.services.tools.register({ ...echo, name: 'Echo' })).toThrow(/namespace/);
    await t.db.close();
  });
});
