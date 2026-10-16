import type { WorldDraft } from '@ios/agents';
import { createTestStudio, makeTestPersona, type TestStudio } from '@ios/agents/testing';
import { OWNER } from '@ios/core';
import { createWorldService, fakeWorldDraft, WORLD_TOOLS } from '../src';

/** A mutable clock, so a test can move "now" (grounding uses live weather only near now). */
export const clock = { now: new Date('2026-11-18T18:00:00Z') };

export async function worldStudio(): Promise<TestStudio> {
  return createTestStudio({ world: createWorldService, tools: WORLD_TOOLS, now: () => clock.now });
}

export function draftFor(opts: { homeBase: string; archetype?: string; name?: string; niche?: string; timezone?: string; draftId?: string }): WorldDraft {
  return fakeWorldDraft(
    {
      studioId: 'x',
      draftId: opts.draftId ?? '00000000-0000-4000-8000-000000000001',
      niche: opts.niche ?? 'personal finance',
      concept: { name: opts.name ?? 'Dot Pickering', archetype: opts.archetype ?? '79, school dinner lady for 41 years', premise: 'Dot runs her pension like a canteen.', mechanic: 'Canteen rules: one rule per post' },
      character: { homeBase: opts.homeBase, lore: 'Widowed, two grandchildren, a famous crumble.', identity: 'Retired dinner lady' },
      timezone: opts.timezone ?? null,
    },
    clock.now,
  );
}

/** A persona with an adopted World Bible + storyline. */
export async function personaWithWorld(t: TestStudio, opts: { homeBase: string; archetype?: string; name?: string; state?: 'TESTING' | 'MONETISING'; timezone?: string }) {
  const p = await makeTestPersona(t, { name: opts.name ?? 'Dot Pickering', state: opts.state ?? 'TESTING', timezone: opts.timezone ?? 'Europe/London' });
  const draft = draftFor({ ...opts, name: p.name });
  await t.db.transaction((tx) => t.services.world.adoptWorld(tx, { personaId: p.id, studioId: t.studioId, draft, actor: OWNER }));
  return { ...p, draft };
}
