import { createToolRegistry, type JobContext } from '@troupe/agents';
import { OWNER, STUDIO_MANAGER, type JobRow } from '@troupe/core';
import { describe, expect, it } from 'vitest';
import * as mod from '../src';
import { linkStore, persona, post, product, studio } from './helpers';

describe('@troupe/commerce module', () => {
  it('exports a StudioModule within its namespaces', () => {
    expect(Array.isArray(mod.tools)).toBe(true);
    expect(typeof mod.jobs).toBe('object');
    expect(Array.isArray(mod.schedules)).toBe(true);
    expect(typeof mod.liveProviders).toBe('function');
    const ns = /^(?:store|site|email|membership|attribution)\./;
    expect(mod.tools.every((t) => ns.test(t.name))).toBe(true);
    expect(Object.keys(mod.jobs).every((k) => ns.test(k))).toBe(true);
    expect(mod.schedules.every((s) => ns.test(s.name))).toBe(true);
  });

  it('tools run through the registry with persona scope and caller checks', async () => {
    const t = await studio();
    const p = await persona(t);
    await product(t, p.id, { status: 'live', checkoutUrl: 'https://a.lemonsqueezy.com/buy/1' });
    const reg = createToolRegistry(mod.tools);
    const services = { ...t.services, tools: reg };
    const owner = { services, studioId: t.studioId, personaId: null, caller: 'owner' as const, actor: OWNER };
    const urls = (await reg.invoke(owner, 'site.urls', { persona_id: p.id })) as { home: string; freebie: string; products: Array<{ url: string }> };
    expect(urls.home).toMatch(new RegExp(`/p/${p.slug}$`));
    expect(urls.freebie).toMatch(new RegExp(`/p/${p.slug}/free$`));
    expect(urls.products[0]!.url).toMatch(/\/shop\/kitchen-reset-workbook$/);
    const status = (await reg.invoke(owner, 'store.status', { persona_id: p.id })) as { products: Array<{ store_status: string }> };
    expect(status.products).toHaveLength(1);
    const writer = { services, studioId: t.studioId, personaId: p.id, caller: 'email-writer' as const, actor: { type: 'agent' as const, id: 'email-writer' } };
    expect(await reg.invoke(writer, 'email.write_welcome', { persona_id: p.id })).toMatchObject({ status: 'active' });
    await expect(reg.invoke(writer, 'store.sync', {})).rejects.toThrow(/may not call/);
    const other = await persona(t);
    await expect(reg.invoke(writer, 'email.list_stats', { persona_id: other.id })).rejects.toThrow(/own persona/);
    // An untrusted run can't broadcast unless the Owner asked for it.
    const untrusted = { ...writer, trust: { untrusted: true } };
    await expect(reg.invoke(untrusted, 'email.broadcast', { persona_id: p.id, subject: 'Hi', body: 'Hello there, a short note.' })).rejects.toThrow(/blocked in this run/);
    const sm = { services, studioId: t.studioId, personaId: null, caller: 'studio-manager' as const, actor: STUDIO_MANAGER };
    expect(await reg.invoke(sm, 'attribution.ensure_links', {})).toEqual({ links: 0, coupons: 0 });
  });

  it('schedules only enqueue; handlers do the work', async () => {
    const t = await studio();
    const p = await persona(t);
    await linkStore(t, p.id, p.slug);
    const pr = await product(t, p.id, { status: 'live', checkoutUrl: 'https://a.lemonsqueezy.com/buy/1' });
    await post(t, p.id, { productId: pr.id });
    const now = new Date();
    for (const s of mod.schedules) {
      expect(s.due(now, null)).toBe(true);
      await s.run(t.services, now);
    }
    await mod.schedules.find((s) => s.name === 'attribution.sweep')!.run(t.services, now);
    const kinds = (await t.db.query<{ kind: string }>(`SELECT kind FROM job ORDER BY kind`)).map((j) => j.kind);
    expect(kinds).toEqual(['attribution.sweep', 'email.send_due', 'store.product_sweep', 'store.sync']);
    expect((await t.db.query('SELECT 1 FROM short_link')).length).toBe(0);

    const run = async (kind: string) => {
      const job = await t.db.one<JobRow>(`SELECT * FROM job WHERE kind = $1`, [kind]);
      const ctx: JobContext = { services: t.services, job, heartbeat: async () => true };
      return mod.jobs[kind]!(ctx);
    };
    expect(await run('attribution.sweep')).toEqual({ links: 1, coupons: 1 });
    expect(await run('store.sync')).toEqual({ stores: 1, linked: 1 });
    expect(await run('email.send_due')).toMatchObject({ sent: 0 });
    expect(await run('store.product_sweep')).toEqual({ changes: 1 }); // live with a URL → 'linked'
  });
});
