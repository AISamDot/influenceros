import { nullWorld, type WorldService } from '@troupe/agents';
import { createTestStudio } from '@troupe/agents/testing';
import { json } from '@troupe/db';
import { describe, expect, it } from 'vitest';
import { scoreConcept } from '../src';
import { fakeConcepts, fakeOpportunities, sheetPrompt } from '../src/fake';
import { lookDraftId, lookVariants, PIN_FACE_MAX, pinFaceCheck } from '../src/media';

/** IOS-5 stream K in the Persona Generator: the 5-view sheet, the production plan, the niche filter, the pin face check. */

const opp = fakeOpportunities({ draftId: 'd1', generation: 1, mix: { active: {}, archived: {} } })[0]!;
const concept = fakeConcepts({ draftId: 'd1', generation: 1, opportunity: opp })[0]!;

describe('look step (fake mode)', () => {
  it('sheets are the 5-view production sheet; the step carries the identity / core / BOPA plan and the board’s mood as text', async () => {
    const world: WorldService = {
      ...nullWorld(),
      moodBoard: async (q) =>
        q.draftId ? { pins: [{ id: 'p', url: 'https://pinterest.example/p', imageUrl: 'https://i.pinimg.example/p.jpg', title: 'pin', description: '', board: null, source: 'pinterest-api' }], descriptors: ['washed denim', 'golden hour'] } : { pins: [], descriptors: [] },
    };
    const t = await createTestStudio({ world: () => world });
    const d = await t.db.one<{ id: string }>(`INSERT INTO persona_draft (studio_id, title, state, created_by) VALUES ($1, $2, $3::jsonb, 'owner:hossam') RETURNING id`, [t.studioId, concept.name, json({})]);
    expect(await lookDraftId(t.services, t.studioId, ['', concept.name])).toBe(d.id);
    const look = (await lookVariants(t.services, { studioId: t.studioId, concept, character: null })) as Awaited<ReturnType<typeof lookVariants>> & {
      production: { identity: unknown[]; core: unknown[]; bopa: { backgrounds: { cells: unknown[] } }; mood: string[]; pins: number; draftId: string };
    };
    expect(look.variants).toHaveLength(3);
    for (const v of look.variants) {
      expect(v.prompt).toMatch(/front, side, back, front close-up, top-down view/);
      expect(v.prompt).toMatch(/washed denim/);
      expect(v.prompt).not.toMatch(/pinimg|pinterest/);
    }
    expect(look.production.identity).toHaveLength(3);
    expect(look.production.core).toHaveLength(4);
    expect(look.production.bopa.backgrounds.cells).toHaveLength(9);
    expect(look.production.mood).toEqual(['washed denim', 'golden hour']);
    expect(look.production.pins).toBe(1);
    expect(look.production.draftId).toBe(d.id);
  });

  it('sheetPrompt is an invented character in the method order', () => {
    const p = sheetPrompt('Nora Vale', 68, { anchors: ['silver bob'], wardrobe: ['cardigan'], palette: [{ name: 'sage', hex: '#000' }], settings: ['kitchen'], stylisation: 'Photoreal', framing: 'chest-up', hue: 1 }, 0);
    expect(p).toMatch(/fictional AI character/);
    expect(p).toMatch(/no resemblance to any real person/);
  });
});

describe('pin face check', () => {
  it('blocks a sheet whose face is too close to a picked pin; pins are compared, never generated from', async () => {
    const face = { name: 'stub', compare: async (pin: string) => ({ faces: 1, similarity: pin.includes('close') ? PIN_FACE_MAX + 0.1 : 0.2 }) };
    expect((await pinFaceCheck(face, '/tmp/sheet.png', [{ id: 'a', title: 'far', path: '/tmp/far.png' }])).verdict).toBe('clear');
    const hit = await pinFaceCheck(face, '/tmp/sheet.png', [
      { id: 'a', title: 'far', path: '/tmp/far.png' },
      { id: 'b', title: 'too close', path: '/tmp/close.png' },
    ]);
    expect(hit).toMatchObject({ checked: 2, verdict: 'too_similar', nearest: { id: 'b' } });
    expect((await pinFaceCheck(face, '/tmp/sheet.png', [{ id: 'c', title: 'no image', path: null }])).verdict).toBe('not_checked');
  });
});

describe('niche filter in the scorecard (producibility)', () => {
  it('a format posing as a niche loses producibility points and the note says why', () => {
    const good = scoreConcept({ concept, opportunity: opp });
    expect(good.notes.producibility).toMatch(/Niche filter/);
    const fmt = scoreConcept({ concept, opportunity: { ...opp, niche: 'room makeovers' } });
    expect(fmt.producibility).toBeLessThan(good.producibility);
    expect(fmt.notes.producibility).toMatch(/makeovers/);
  });
});
