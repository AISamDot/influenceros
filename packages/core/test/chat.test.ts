import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureThreads, findThread, listMessages, listThreads, postOwnerMessage, replyAsAgent } from '../src';
import { type Ctx, count, makePersona, setup } from './helpers';

let ctx: Ctx;
beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => ctx.db.close());

describe('owner chat', () => {
  it('creates studio, monetization, quality and per-persona threads idempotently', async () => {
    await makePersona(ctx, { name: 'Vivian Hale' });
    await ensureThreads(ctx.db, ctx.studioId);
    await ensureThreads(ctx.db, ctx.studioId);
    const threads = await listThreads(ctx.db, ctx.studioId);
    expect(threads.map((t) => t.kind)).toEqual(['studio', 'monetization', 'quality', 'persona']);
  });

  it('persists owner messages and data-summary replies', async () => {
    const id = await makePersona(ctx, { name: 'Vivian Hale' });
    const t = await findThread(ctx.db, ctx.studioId, 'persona', id);
    await postOwnerMessage(ctx.db, t.id, 'Make the hooks warmer');
    const reply = await replyAsAgent(ctx.db, t.id, 'Make the hooks warmer');
    expect(reply.role).toBe('agent');
    expect(reply.body).toMatch(/Vivian Hale/);
    expect((await listMessages(ctx.db, t.id)).map((m) => m.role)).toEqual(['owner', 'agent']);
    // The persona manager (not storage) decides what counts as feedback.
    expect(await count(ctx.db, 'SELECT 1 FROM feedback WHERE persona_id = $1', [id])).toBe(0);
    await expect(postOwnerMessage(ctx.db, t.id, '   ')).rejects.toThrow(/empty/);
  });

  it('studio chat picks up @mentions', async () => {
    await makePersona(ctx, { name: 'Amos Reed' });
    const t = await findThread(ctx.db, ctx.studioId, 'studio');
    const m = await postOwnerMessage(ctx.db, t.id, 'How is @amos doing?');
    expect((m.meta.mentions as Array<{ name: string }>).map((x) => x.name)).toEqual(['Amos Reed']);
    const reply = await replyAsAgent(ctx.db, t.id, 'How is @amos doing?');
    expect(reply.body).toMatch(/Amos Reed's manager/);
  });
});
