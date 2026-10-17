import { ToolPermissionError } from '@troupe/agents';
import { makeTestPersona } from '@troupe/agents/testing';
import { OWNER } from '@troupe/core';
import { describe, expect, it } from 'vitest';
import { schedules, WORLD_JOBS, WORLD_TOOLS } from '../src';
import { clock, personaWithWorld, worldStudio } from './helpers';

describe('stream J tools and schedules', () => {
  it('namespaces, callers and write gating', () => {
    const ns = new Set(WORLD_TOOLS.map((t) => t.name.split('.')[0]));
    expect([...ns].sort()).toEqual(['continuity', 'inspiration', 'norepeat', 'pinterest', 'storyline', 'world']);
    for (const t of WORLD_TOOLS) {
      if (t.mutates) expect(t.ownerIntent, t.name).toBeInstanceOf(RegExp);
      if (t.name.startsWith('inspiration.')) expect(t.callers).toContain('studio-manager');
      if (t.name.startsWith('storyline.')) expect(t.callers).toContain('persona-manager');
    }
  });

  it('edits and backfills the World Bible through tools; a scoped agent cannot touch another persona', async () => {
    const t = await worldStudio();
    const p = await personaWithWorld(t, { homeBase: 'a terraced house in Yorkshire' });
    const owner = { services: t.services, studioId: t.studioId, personaId: null, caller: 'owner' as const, actor: OWNER };
    const r = (await t.services.tools.invoke(owner, 'world.update', { persona_id: p.id, patch: { localEvents: [{ name: 'York Christmas Market', month: 11, day: 20 }], routine: { daily: ['up at 6'] } } })) as { version: number };
    expect(r.version).toBe(2);
    const v = (await t.services.tools.invoke(owner, 'world.view', { persona_id: p.id })) as { bible: { routine: { daily: string[] }; place: { city: string } } };
    expect(v.bible.routine.daily).toEqual(['up at 6']);
    expect(v.bible.place.city).toBe('York');
    clock.now = new Date('2026-11-18T12:00:00Z');
    const g = (await t.services.tools.invoke(owner, 'world.grounding', { persona_id: p.id })) as { holidays: string[] };
    expect(g.holidays.join()).toMatch(/York Christmas Market/);
    await expect(t.services.tools.invoke(owner, 'world.update', { persona_id: p.id, patch: { lat: 1 } })).rejects.toThrow(/cannot edit/);

    const other = await makeTestPersona(t, { name: 'Walt Hardy', timezone: 'America/Chicago' });
    const pm = { services: t.services, studioId: t.studioId, personaId: p.id, caller: 'persona-manager' as const, actor: { type: 'agent' as const, id: 'persona-manager' } };
    await expect(t.services.tools.invoke(pm, 'world.backfill', { persona_id: other.id })).rejects.toBeInstanceOf(ToolPermissionError);
    const b = (await t.services.tools.invoke(owner, 'world.backfill', { persona_id: other.id })) as { created: boolean; summary: string };
    expect(b.created).toBe(true);
    expect(b.summary).toMatch(/Chicago/);
    expect(((await t.services.tools.invoke(owner, 'world.backfill', { persona_id: other.id })) as { created: boolean }).created).toBe(false);
    await t.db.close();
  });

  it('schedules only enqueue, once per persona per window', async () => {
    const t = await worldStudio();
    await personaWithWorld(t, { homeBase: 'a terraced house in Yorkshire' });
    const now = new Date('2026-11-18T06:30:00Z');
    for (const s of schedules) {
      expect(s.due(now, null)).toBe(true);
      await s.run(t.services, now);
      await s.run(t.services, now);
    }
    const kinds = await t.db.query<{ kind: string }>(`SELECT kind FROM job ORDER BY kind`);
    expect(kinds.map((k) => k.kind)).toEqual([WORLD_JOBS.sync, WORLD_JOBS.upkeep, WORLD_JOBS.weather].sort());
    await t.db.close();
  });
});
