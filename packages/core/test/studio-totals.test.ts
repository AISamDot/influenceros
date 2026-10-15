import { describe, expect, it } from 'vitest';
import { studioTotals } from '../src';
import { makePersona, setup } from './helpers';

describe('studioTotals (studio header)', () => {
  it('counts only TESTING and later states as live, and shows the setup count', async () => {
    const ctx = await setup();
    for (let i = 0; i < 5; i++) await makePersona(ctx, { state: 'SETUP' });
    let t = await studioTotals(ctx.db, ctx.studioId);
    expect(t).toMatchObject({ live: 0, setup: 5, active: 5 });

    await makePersona(ctx, { state: 'PROPOSED' });
    await makePersona(ctx, { state: 'TESTING' });
    await makePersona(ctx, { state: 'MONETISING' });
    await makePersona(ctx, { state: 'RE_ANGLE' });
    await makePersona(ctx, { state: 'KILLED' });
    t = await studioTotals(ctx.db, ctx.studioId);
    expect(t).toMatchObject({ live: 3, setup: 6, active: 9 });
    await ctx.db.close();
  });
});
