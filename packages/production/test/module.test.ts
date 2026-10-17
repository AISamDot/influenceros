import { ToolPermissionError } from '@troupe/agents';
import { createTestStudio, makeTestPersona } from '@troupe/agents/testing';
import { OWNER } from '@troupe/core';
import { describe, expect, it } from 'vitest';
import * as mod from '../src';

describe('@troupe/production module', () => {
  it('exports a StudioModule and its service factory', () => {
    expect(Array.isArray(mod.tools)).toBe(true);
    expect(typeof mod.jobs).toBe('object');
    expect(Array.isArray(mod.schedules)).toBe(true);
    expect(typeof mod.liveProviders).toBe('function');
    expect(typeof mod.createPromptCompiler).toBe('function');
  });

  it('keeps its tools inside stream K namespaces', () => {
    for (const t of mod.tools) expect(t.name).toMatch(/^(?:prompt|production|look|location|media|voice)\./);
    const names = mod.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['prompt.compile', 'production.niche_filter', 'production.hook_templates', 'production.overview', 'location.list', 'look.build', 'location.lock', 'look.pick']));
    expect(mod.PRODUCTION_JOB).toEqual({ lookBuild: 'look.build', lockLocations: 'production.lock_locations' });
  });
});

describe('stream K tools through the registry', () => {
  it('the Studio Manager reads the niche filter, hook templates and a compiled prompt; spends nothing', async () => {
    const t = await createTestStudio({ prompts: mod.createPromptCompiler });
    t.services.tools.register(...mod.tools);
    const p = await makeTestPersona(t, { name: 'Nora Vale' });
    const sm = { services: t.services, studioId: t.studioId, personaId: null, caller: 'studio-manager' as const, actor: { type: 'agent' as const, id: 'studio-manager' } };
    const niche = (await t.services.tools.invoke(sm, 'production.niche_filter', { niche: 'glow-ups' })) as { formatNotNiche: string | null };
    expect(niche.formatNotNiche).toBe('glow-ups');
    const hooks = (await t.services.tools.invoke(sm, 'production.hook_templates', { format: 'reply_comment', topic: 'saving' })) as { templates: Array<{ id: string; fits: boolean; example: string }> };
    expect(hooks.templates[0]!.fits).toBe(true);
    expect(hooks.templates.find((x) => x.id === 'quiz')!.example).toMatch(/saving/);
    const v = (await t.services.tools.invoke(sm, 'prompt.compile', { persona_id: p.id, kind: 'video', scene: 'waves', line: 'Hello, love.' })) as { text: string; checks: Array<{ pass: boolean }> };
    expect(v.text).toMatch(/No captions or subtitles/);
    expect(v.checks.every((c) => c.pass)).toBe(true);
    const n = await t.db.one<{ n: number }>('SELECT count(*)::int AS n FROM credit_ledger');
    expect(n.n).toBe(0);
  });

  it('look.build queues a job for makers; look.pick is the Owner’s; untrusted runs cannot queue spend', async () => {
    const t = await createTestStudio();
    t.services.tools.register(...mod.tools);
    const p = await makeTestPersona(t);
    const vp = { services: t.services, studioId: t.studioId, personaId: null, caller: 'video-producer' as const, actor: { type: 'agent' as const, id: 'video-producer' } };
    const r = (await t.services.tools.invoke(vp, 'look.build', { persona_id: p.id })) as { job_id: string };
    expect((await t.db.one<{ kind: string }>('SELECT kind FROM job WHERE id = $1', [r.job_id])).kind).toBe('look.build');
    await expect(t.services.tools.invoke(vp, 'look.pick', { persona_id: p.id, grid: 'poses', cell: 2 })).rejects.toBeInstanceOf(ToolPermissionError);
    await expect(t.services.tools.invoke({ ...vp, trust: { untrusted: true, ownerText: null } }, 'location.lock', { persona_id: p.id })).rejects.toBeInstanceOf(ToolPermissionError);
    const owner = { services: t.services, studioId: t.studioId, personaId: null, caller: 'owner' as const, actor: OWNER };
    await expect(t.services.tools.invoke(owner, 'look.pick', { persona_id: p.id, grid: 'poses', cell: 2 })).rejects.toThrow(/no grid yet/);
  });
});
