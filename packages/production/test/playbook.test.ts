import { CAMERA_STYLES } from '@troupe/agents';
import { createTestStudio, makeTestPersona } from '@troupe/agents/testing';
import { HOOK_TEMPLATES, planWeek, attachSampleBible } from '@troupe/content';
import { json } from '@troupe/db';
import { describe, expect, it } from 'vitest';
import {
  BOPA_ANGLES,
  bopaPlan,
  CAMERA_SPEC,
  cameraStylesFor,
  chainFrame,
  characterPrompt,
  characterSheetPrompt,
  coreRefPrompts,
  DETAIL_STRIP,
  detailStripPrompt,
  ensureLocations,
  gridCell,
  identityStackPrompts,
  identityStackUrls,
  locationCandidatePrompts,
  lockedLocation,
  lockLocation,
  nicheFilter,
  personaPlaces,
  pickCamera,
  placeKey,
  recentCameras,
  recordFrame,
  recordSlotProduction,
  saveIdentityRef,
  setFrameStatus,
  SHEET_VIEWS,
  slotProduction,
  upscaleCellPrompt,
} from '../src';

const BRIEF = {
  name: 'Nora Vale',
  age: 68,
  anchors: ['silver bob', 'round tortoiseshell glasses', 'a scar through the left eyebrow'],
  wardrobe: ['a moss-green cardigan', 'a navy raincoat', 'a cream fisherman jumper'],
  settings: ['a terraced-house kitchen', 'an allotment shed', 'a bus stop'],
  palette: ['sage', 'cream'],
  stylisation: 'Photoreal',
};

describe('character sheet, identity stack, core refs', () => {
  it('the 5-view sheet lists front, side, back, front close-up and top-down on neutral grey, in the method’s order', () => {
    const p = characterSheetPrompt(BRIEF);
    expect(SHEET_VIEWS).toEqual(['front', 'side', 'back', 'front close-up', 'top-down']);
    expect(p).toContain('front, side, back, front close-up, top-down view');
    expect(p).toMatch(/neutral grey/);
    expect(p).toMatch(/No equipment or clutter in frame/);
    expect(p).toMatch(/no resemblance to any real person/);
    // camera angle → character → pose/background → outfit → skin → no clutter → realism
    const order = ['eye-level camera', 'Nora Vale', 'Standing relaxed', 'Wearing', 'Skin detail', 'No equipment', 'Photoreal'].map((x) => p.indexOf(x));
    expect(order.every((x, i) => x >= 0 && (i === 0 || x > order[i - 1]!))).toBe(true);
    const c = characterPrompt(BRIEF, { angle: 'Camera 45° left', pose: 'Leaning', background: 'in a kitchen' });
    expect(c.indexOf('Camera 45° left')).toBeLessThan(c.indexOf('Nora Vale'));
    expect(c.indexOf('Leaning')).toBeLessThan(c.indexOf('Wearing'));
  });

  it('the detail strip has 8–9 close-ups; the identity stack is a face close-up and 2 full-body shots; 4 core refs in varied settings', () => {
    expect(DETAIL_STRIP.length).toBeGreaterThanOrEqual(8);
    expect(DETAIL_STRIP.length).toBeLessThanOrEqual(9);
    expect(detailStripPrompt(BRIEF)).toMatch(/9 square close-up/);
    const stack = identityStackPrompts(BRIEF);
    expect(stack.map((s) => s.kind)).toEqual(['face', 'full_body', 'full_body']);
    expect(stack.every((s) => /neutral grey background/.test(s.prompt))).toBe(true);
    const core = coreRefPrompts(BRIEF);
    expect(core).toHaveLength(4);
    expect(new Set(core.map((c) => c.label.split(': ')[1])).size).toBeGreaterThanOrEqual(3);
    expect(core.every((c) => /never a flat backdrop/.test(c.prompt))).toBe(true);
  });

  it('BOPA: a 3×3 background grid, keep-identity outfit edits, a 2×2 pose grid, angles in degrees, upscale of a picked cell', () => {
    const b = bopaPlan(BRIEF);
    expect(b.backgrounds.cells).toHaveLength(9);
    expect(b.backgrounds.gridPrompt).toMatch(/3×3 grid of nine photos/);
    expect(b.outfits).toHaveLength(3);
    expect(b.outfits.every((o) => /Keep the exact same person, face, skin, hair, pose, framing/.test(o.prompt) && /change the outfit only/.test(o.prompt))).toBe(true);
    expect(b.poses.cells).toHaveLength(4);
    expect(b.poses.gridPrompt).toMatch(/2×2 grid/);
    expect(b.angles.map((a) => a.degrees)).toEqual(BOPA_ANGLES.map((a) => a.degrees));
    expect(b.angles[0]!.prompt).toMatch(/Camera 45° to the left of the subject/);
    expect(gridCell(4, 3)).toMatchObject({ row: 2, col: 2, left: 1 / 3, top: 1 / 3 });
    expect(gridCell(3, 2)).toMatchObject({ row: 2, col: 2 });
    expect(upscaleCellPrompt(b.backgrounds.cells[4]!, 4, 3, 'background')).toMatch(/cell 5 \(row 2, column 2\) of the 3×3 reference grid/);
  });

  it('location candidates: one prompt across 5 variations, no people', () => {
    const c = locationCandidatePrompts('the kitchen', 'green tiles', 'Photoreal');
    expect(c).toHaveLength(5);
    expect(new Set(c.map((x) => x.prompt.split('. ')[0])).size).toBe(1);
    expect(c.every((x) => /No people in frame/.test(x.prompt))).toBe(true);
  });
});

describe('realism camera styles', () => {
  it('every style has its imperfections; a persona gets 3–5 styles with handheld by default; the bible can set them', () => {
    for (const s of CAMERA_STYLES) expect(CAMERA_SPEC[s].imperfections.length).toBeGreaterThan(0);
    const auto = cameraStylesFor({}, 'persona-1');
    expect(auto.length).toBeGreaterThanOrEqual(3);
    expect(auto.length).toBeLessThanOrEqual(5);
    expect(auto).toContain('handheld');
    expect(cameraStylesFor({ look: { camera_styles: ['mirror', 'Dashcam', 'doorway peek', 'bogus'] } }, 'x')).toEqual(['mirror', 'dashcam', 'doorway_peek']);
  });

  it('rotates: talking formats get a talking style, recent styles are skipped, the pick is deterministic per slot', () => {
    const styles = ['mirror', 'over_shoulder', 'selfie', 'propped_phone'] as const;
    for (let i = 0; i < 20; i++) expect(CAMERA_SPEC[pickCamera(styles, { format: 'talking', seed: `s${i}` })].talking).toBe(true);
    expect(pickCamera(styles, { format: 'static', recent: ['mirror', 'over_shoulder', 'selfie'], seed: 'x' })).toBe('propped_phone');
    expect(pickCamera(styles, { format: 'static', seed: 'slot-a' })).toBe(pickCamera(styles, { format: 'static', seed: 'slot-a' }));
  });
});

describe('niche filter (five questions, niche vs format)', () => {
  it('a talk-to-camera niche with a character and a recurring mechanic passes 5/5 and gets hook templates', () => {
    const r = nicheFilter({ niche: 'budgeting on a small wage', premise: '68, school dinner lady for 41 years', archetype: 'retired dinner lady', mechanic: 'Hatch verdicts: rates your receipts', hooks: ['Show me your receipt.', '3 mistakes with your first budget'] });
    expect(r.score).toBe(5);
    expect(r.pass).toBe(true);
    expect(r.formatNotNiche).toBeNull();
    expect(r.templates.length).toBeGreaterThanOrEqual(8);
    expect(r.templates[0]!.example).toMatch(/budgeting on a small wage/);
  });

  it('formats are not niches, hostless content fails the host question, expensive scenes fail the hooks question', () => {
    const fmt = nicheFilter({ niche: 'room makeovers', premise: 'a decorator', mechanic: 'weekly makeover' });
    expect(fmt.formatNotNiche).toBe('makeovers');
    expect(fmt.pass).toBe(false);
    const hostless = nicheFilter({ niche: 'satisfying slime videos', premise: 'x', mechanic: 'daily drop' });
    expect(hostless.answers.find((a) => a.id === 'host')!.yes).toBe(false);
    const pricey = nicheFilter({ niche: 'adventure travel', premise: 'globetrotter', mechanic: 'skydiving every week', hooks: ['I jumped again'] });
    expect(pricey.answers.find((a) => a.id === 'hooks')!.yes).toBe(false);
    expect(pricey.summary).toMatch(/expensive scenes/);
  });

  it('the hook-template library covers the playbook list', () => {
    const names = HOOK_TEMPLATES.map((t) => t.id);
    for (const id of ['three_mistakes', 'do_this_instead', 'myth_vs_fact', 'ranking', 'story_hook', 'pov', 'quiz', 'beginner_guide', 'reaction', 'triple_hook']) expect(names).toContain(id);
  });
});

describe('identity refs, location lock, consistency chain, slot production record', () => {
  it('the identity stack is the active face + full-body refs (never candidates), else the sheet', async () => {
    const t = await createTestStudio();
    const p = await makeTestPersona(t);
    await saveIdentityRef(t.db, { personaId: p.id, kind: 'sheet', label: '5-view sheet', prompt: 'x', url: 'https://hf/sheet.png' });
    expect(await identityStackUrls(t.db, p.id)).toEqual(['https://hf/sheet.png']);
    await saveIdentityRef(t.db, { personaId: p.id, kind: 'face', label: 'face close-up', prompt: 'x', url: 'https://hf/face.png' });
    await saveIdentityRef(t.db, { personaId: p.id, kind: 'full_body', label: 'a', prompt: 'x', url: 'https://hf/a.png', status: 'candidate' });
    await saveIdentityRef(t.db, { personaId: p.id, kind: 'full_body', label: 'b', prompt: 'x', url: 'https://hf/b.png' });
    expect(await identityStackUrls(t.db, p.id)).toEqual(['https://hf/face.png', 'https://hf/b.png']);
    // Upsert per label.
    await saveIdentityRef(t.db, { personaId: p.id, kind: 'face', label: 'face close-up', prompt: 'y', url: 'https://hf/face2.png' });
    expect(await identityStackUrls(t.db, p.id)).toEqual(['https://hf/face2.png', 'https://hf/b.png']);
  });

  it('places come from the World Bible draft then the bible settings; a lock carries its anchor frames', async () => {
    const t = await createTestStudio();
    const p = await makeTestPersona(t);
    await t.db.query(
      `INSERT INTO persona_draft (studio_id, title, state, persona_id, created_by, status) VALUES ($1, 'x', $2::jsonb, $3, 'owner:hossam', 'launched')`,
      [t.studioId, json({ world: { bible: { recurring_places: [{ name: 'The Hatch', description: 'a school kitchen serving hatch' }, { name: 'Bus stop', description: 'a rainy shelter' }] } } }), p.id],
    );
    const places = await personaPlaces(t.db, p.id, ['a terraced-house kitchen', 'the hatch']);
    expect(places.map((x) => x.place)).toEqual(['The Hatch', 'Bus stop', 'a terraced-house kitchen']);
    expect(places[0]!.source).toBe('world');
    expect(await ensureLocations(t.db, p.id, places)).toBe(3);
    expect(await ensureLocations(t.db, p.id, places)).toBe(0);
    expect(await lockedLocation(t.db, p.id, 'the hatch')).toBeNull();
    await lockLocation(t.db, p.id, placeKey('The Hatch'), { refs: [{ url: 'https://hf/h1.png', assetKey: null, angle: 'wide' }, { url: 'https://hf/h2.png', assetKey: null, angle: 'corner' }], candidates: [], chosen: 2, at: new Date() });
    const lock = await lockedLocation(t.db, p.id, 'THE  hatch');
    expect(lock!.refs.map((r) => r.url)).toEqual(['https://hf/h1.png', 'https://hf/h2.png']);
    expect(lock!.chosen).toBe(2);
  });

  it('chains only from approved frames, never a rejected one; the slot record writes only meta.production', async () => {
    const t = await createTestStudio();
    const p = await makeTestPersona(t);
    await attachSampleBible(t.db, p.id);
    const { slotIds } = await planWeek(t.services, p.id, new Date('2026-10-19T00:00:00Z'));
    const [a, b] = slotIds;
    await t.db.query(`UPDATE calendar_slot SET meta = meta || '{"story": {"beat": "kept"}}'::jsonb WHERE id = $1`, [a]);
    await recordFrame(t.db, { personaId: p.id, slotId: a!, genKey: 'still:0', location: 'The Kitchen', camera: 'selfie', url: 'https://hf/1.png' });
    expect(await chainFrame(t.db, p.id, 'kitchen')).toBeNull(); // pending
    await setFrameStatus(t.db, a!, 'approved');
    expect((await chainFrame(t.db, p.id, 'the kitchen'))!.url).toBe('https://hf/1.png');
    await recordFrame(t.db, { personaId: p.id, slotId: b!, genKey: 'still:0', location: 'kitchen', camera: 'mirror', url: 'https://hf/2.png' });
    await setFrameStatus(t.db, b!, 'rejected', ['still:0']);
    await setFrameStatus(t.db, b!, 'approved'); // a rejected frame never flips back
    expect((await chainFrame(t.db, p.id, 'kitchen'))!.url).toBe('https://hf/1.png');
    expect(await chainFrame(t.db, p.id, 'kitchen', { excludeSlotId: a! })).toBeNull();

    await recordSlotProduction(t.db, a!, { camera: 'selfie', location: 'The Kitchen', chain: { from: ['https://hf/0.png'], locked: true } });
    const meta = await t.db.one<{ meta: Record<string, unknown> }>('SELECT meta FROM calendar_slot WHERE id = $1', [a]);
    expect(meta.meta.story).toEqual({ beat: 'kept' });
    expect((await slotProduction(t.db, a!))!.camera).toBe('selfie');
    expect(await recentCameras(t.db, p.id)).toEqual(['selfie']);
  });
});
