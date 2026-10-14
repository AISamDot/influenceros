import { createFakeProviders } from '@ios/providers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { budgetStatus, BudgetExceededError, debit, meteredProviders } from '../src';
import { type Ctx, count, makePersona, setup } from './helpers';

let ctx: Ctx;
beforeEach(async () => {
  // Studio: $100 LLM / 1,000 credits. Persona default: $10 LLM / 100 credits.
  ctx = await setup({ caps: { llm_usd_month: 100, hf_credits_month: 1000 }, persona_default_caps: { llm_usd_month: 10, hf_credits_month: 100 } });
});
afterEach(async () => ctx.db.close());

const alerts = (personaId: string) =>
  count(ctx.db, `SELECT 1 FROM notification WHERE persona_id = $1 AND kind = 'budget'`, [personaId]);

describe('cost governor and credit ledger', () => {
  it('alerts once at 80% and refuses at 100%', async () => {
    const p = await makePersona(ctx);
    const base = { studioId: ctx.studioId, personaId: p, unit: 'hf_credits' as const };
    expect((await debit(ctx.db, { ...base, amount: 70 })).level).toBe('ok');
    expect(await alerts(p)).toBe(0);
    expect((await debit(ctx.db, { ...base, amount: 15 })).level).toBe('warn'); // 85%
    expect(await alerts(p)).toBe(1);
    await debit(ctx.db, { ...base, amount: 5 }); // 90%: no second 80% alert
    expect(await count(ctx.db, `SELECT 1 FROM audit_log WHERE persona_id = $1 AND action = 'budget.alert'`, [p])).toBe(1);

    // 100% exactly is allowed (cap reached), anything past it is refused.
    expect((await debit(ctx.db, { ...base, amount: 10 })).level).toBe('blocked');
    await expect(debit(ctx.db, { ...base, amount: 1 })).rejects.toBeInstanceOf(BudgetExceededError);
    expect(await count(ctx.db, `SELECT 1 FROM audit_log WHERE persona_id = $1 AND action = 'budget.refused'`, [p])).toBe(1);
    expect(await count(ctx.db, `SELECT 1 FROM audit_log WHERE persona_id = $1 AND action = 'budget.cap_reached'`, [p])).toBe(1);
    expect((await budgetStatus(ctx.db, base)).persona?.used).toBe(100);
  });

  it('enforces the studio cap across personas and honours per-persona overrides', async () => {
    const a = await makePersona(ctx, { budget: { llm_usd_month: 80 } });
    const b = await makePersona(ctx, { budget: { llm_usd_month: 80 } });
    await debit(ctx.db, { studioId: ctx.studioId, personaId: a, unit: 'llm_usd', amount: 60 }); // above the $10 default: override applies
    await debit(ctx.db, { studioId: ctx.studioId, personaId: b, unit: 'llm_usd', amount: 35 });
    const err = await debit(ctx.db, { studioId: ctx.studioId, personaId: b, unit: 'llm_usd', amount: 10 }).catch((e) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(err.details.scope).toBe('studio');
  });

  it('meters every paid provider call and refuses before calling past a cap', async () => {
    const p = await makePersona(ctx);
    const raw = createFakeProviders();
    const prov = meteredProviders(ctx.db, raw, { studioId: ctx.studioId, personaId: p, agent: 'persona-manager' });

    const res = await prov.llm.complete({ tier: 'standard', messages: [{ role: 'user', content: 'Draft three hooks about sinking funds' }] });
    await prov.imageVideo.generateStill({ prompt: 'desk' });
    await prov.voice.tts({ voiceId: 'v', text: 'Every dollar gets a job.' });
    await prov.talking.render({ imageUrl: 'a.png', audioUrl: 'a.mp3', durationS: 20 });

    const ledger = await ctx.db.query<{ unit: string; amount: number; operation: string }>(
      `SELECT unit, amount, operation FROM credit_ledger WHERE persona_id = $1 AND entry_type = 'debit' ORDER BY created_at`,
      [p],
    );
    expect(ledger.map((l) => l.unit)).toEqual(['llm_usd', 'hf_credits', 'media_usd', 'media_usd']);
    expect(ledger[0]!.amount).toBeCloseTo(res.costUsd, 6);
    expect(ledger[1]!.amount).toBe(2);
    expect(await count(ctx.db, 'SELECT 1 FROM agent_run WHERE persona_id = $1', [p])).toBe(1);

    // Spend the rest of the credits, then the next paid call is refused and never reaches the provider.
    await debit(ctx.db, { studioId: ctx.studioId, personaId: p, unit: 'hf_credits', amount: 95 });
    const before = raw.imageVideo.calls.length;
    await expect(prov.imageVideo.imageToVideo({ imageUrl: 'a.png', prompt: 'walk', durationS: 5 })).rejects.toBeInstanceOf(BudgetExceededError);
    expect(raw.imageVideo.calls.length).toBe(before);
    // The free cost probe still works.
    expect(await prov.imageVideo.costProbe({ operation: 'still' })).toEqual({ credits: 2 });
  });

  it('reserves before calling, so concurrent paid calls cannot all fit in the same headroom', async () => {
    const p = await makePersona(ctx);
    const raw = createFakeProviders();
    const prov = meteredProviders(ctx.db, raw, { studioId: ctx.studioId, personaId: p, agent: 'renderer' });
    await debit(ctx.db, { studioId: ctx.studioId, personaId: p, unit: 'hf_credits', amount: 94 }); // 6 credits left
    const results = await Promise.allSettled(
      [1, 2, 3, 4].map(() => prov.imageVideo.imageToVideo({ imageUrl: 'a.png', prompt: 'walk', durationS: 5 })), // 6 credits each
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected' && r.reason instanceof BudgetExceededError)).toHaveLength(3);
    expect(raw.imageVideo.callsTo('imageToVideo')).toHaveLength(1);
    const used = (await budgetStatus(ctx.db, { studioId: ctx.studioId, personaId: p, unit: 'hf_credits' })).persona!;
    expect(used.used).toBe(100);
    expect(await count(ctx.db, `SELECT 1 FROM credit_ledger WHERE entry_type = 'hold'`)).toBe(0);
  });

  it('releases the hold when the paid call fails', async () => {
    const p = await makePersona(ctx);
    const raw = createFakeProviders();
    raw.imageVideo.generateStill = async () => {
      throw new Error('upstream 503');
    };
    const prov = meteredProviders(ctx.db, raw, { studioId: ctx.studioId, personaId: p, agent: 'renderer' });
    await expect(prov.imageVideo.generateStill({ prompt: 'desk' })).rejects.toThrow(/503/);
    expect((await budgetStatus(ctx.db, { studioId: ctx.studioId, personaId: p, unit: 'hf_credits' })).persona?.used).toBe(0);
    expect(await count(ctx.db, 'SELECT 1 FROM credit_ledger')).toBe(0);
  });
});
