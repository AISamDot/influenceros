import { CLIP_MAX_S, type Grounding, IMAGE_PROMPT_BLOCKS, NO_CAPTIONS, nullWorld, speechSeconds, VIDEO_PROMPT_BLOCKS, type WorldService } from '@ios/agents';
import { createTestStudio, makeTestPersona } from '@ios/agents/testing';
import { attachSampleBible } from '@ios/content';
import { json } from '@ios/db';
import { describe, expect, it } from 'vitest';
import { accentPhrase, checkVideoPrompt, compileImage, compileVideo, type CompileContext, createPromptCompiler, ensureLocations, lockLocation, placeKey, saveIdentityRef, stripTimecodes } from '../src';

const G: Grounding = {
  personaId: 'p',
  timezone: 'Europe/London',
  localDate: '2026-11-18',
  localTime: '18:05',
  weekday: 'Wednesday',
  season: 'autumn',
  timeOfDay: 'evening',
  place: { city: 'Halifax', region: 'West Yorkshire', country: 'United Kingdom', lat: 53.7, lon: -1.86 },
  weather: { summary: 'Light rain', tempC: 6, precipitation: true, isDay: false, source: 'fake' },
  sunrise: '07:32',
  sunset: '16:08',
  holidays: [],
  block: 'Grounding: Halifax, Wednesday 18 November 2026, 18:05, autumn evening, dark since 16:08, light rain, 6°C.',
};

const CTX: CompileContext = {
  personaId: 'p',
  name: 'Nora Vale',
  identity: 'silver bob, round tortoiseshell glasses, a small scar through the left eyebrow',
  outfits: ['a moss-green cardigan'],
  settings: ['a small terraced-house kitchen'],
  stylisation: 'Photoreal, soft natural light',
  framing: 'chest-up',
  accent: 'Yorkshire',
  cameraStyles: ['handheld', 'selfie', 'propped_phone'],
  identityRefs: ['https://cdn.example/face.png', 'https://cdn.example/body-1.png', 'https://cdn.example/body-2.png'],
  location: { place: 'the kitchen', description: 'narrow galley kitchen, green tiles', refs: ['https://cdn.example/kitchen-a.png', 'https://cdn.example/kitchen-b.png'] },
};

describe('prompt compiler: images', () => {
  it('emits the five image blocks in order, with the grounding block, the camera style and only the persona’s own refs', () => {
    const c = compileImage({ personaId: 'p', scene: 'making tea, looking up mid-laugh', location: 'the kitchen', camera: 'propped_phone', grounding: G, mood: ['muted sage palette', 'cosy knitwear'] }, CTX);
    expect(Object.keys(c.blocks)).toEqual([...IMAGE_PROMPT_BLOCKS]);
    for (const k of IMAGE_PROMPT_BLOCKS) expect(c.blocks[k]!.length).toBeGreaterThan(10);
    expect(c.text.indexOf(c.blocks.subject!)).toBeLessThan(c.text.indexOf(c.blocks.lighting!));
    expect(c.blocks.lighting).toContain(G.block);
    expect(c.blocks.lighting).toMatch(/after dark/);
    expect(c.blocks.wardrobe).toMatch(/autumn at 6°C/);
    expect(c.blocks.setting).toMatch(/locked reference frames/);
    expect(c.blocks.setting).toMatch(/muted sage palette/); // mood as text descriptors only
    expect(c.blocks.camera).toMatch(/propped on a counter/);
    expect(c.camera).toBe('propped_phone');
    expect(c.references).toEqual([...CTX.identityRefs, ...CTX.location!.refs]);
    expect(c.settings).toMatchObject({ resolution: '720p', guidance: 0.8 });
    expect(c.text).toMatch(/No readable text, logos or watermarks/);
  });

  it('drops the identity refs on a no-people shot and notes missing grounding / identity', () => {
    const c = compileImage({ personaId: 'p', scene: 'a coffee on the windowsill, no people', grounding: null }, { ...CTX, location: null });
    expect(c.references).toEqual([]);
    expect(c.blocks.subject).toMatch(/no people in frame/);
    expect(c.notes.join(' ')).toMatch(/no grounding/);
    const bare = compileImage({ personaId: 'p', scene: 'reading a letter' }, { ...CTX, identityRefs: [], location: null });
    expect(bare.notes.join(' ')).toMatch(/no identity stack yet/);
  });
});

describe('prompt compiler: video', () => {
  it('a talking prompt: five blocks, the verbatim line, the accent, 2.5–3 wps, no captions, the grounding block', () => {
    const line = 'Right, love, here is the thing nobody tells you about saving on a small wage.';
    const c = compileVideo({ personaId: 'p', startFrame: 'Nora at the counter', action: 'turns to the camera', line, durationS: 2, grounding: G }, CTX);
    expect(Object.keys(c.blocks)).toEqual([...VIDEO_PROMPT_BLOCKS]);
    expect(c.blocks.action).toContain(`"${line}"`);
    expect(c.blocks.action).toMatch(/fluent Yorkshire accent/);
    expect(c.blocks.audio).toMatch(/Yorkshire accent/);
    expect(c.blocks.action).toMatch(/2\.5–3 words a second/);
    expect(c.text).toContain(NO_CAPTIONS);
    expect(c.text).toContain(G.block);
    // Duration comes from the word count at the slow end of the pace, never shorter than the line needs.
    expect(c.settings.duration_s).toBe(speechSeconds(line.split(/\s+/).length));
    expect(checkVideoPrompt(c, { line }).filter((x) => !x.pass)).toEqual([]);
  });

  it('every video prompt carries no-captions; no timecodes survive; clips are ≤ 10 s and long lines are split', () => {
    const silent = compileVideo({ personaId: 'p', startFrame: '0:00 Nora at the sink', action: '[2s] she dries a mug, then at 4 s looks up', durationS: 14 }, CTX);
    expect(silent.text).toContain(NO_CAPTIONS);
    expect(silent.blocks.audio).toMatch(/no speech/);
    expect(silent.settings.duration_s).toBe(CLIP_MAX_S);
    expect(silent.blocks.start_frame).not.toMatch(/0:00/);
    expect(silent.blocks.action).not.toMatch(/\[2s\]|at 4 s/);
    expect(checkVideoPrompt(silent).filter((x) => !x.pass)).toEqual([]);

    const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    const split = compileVideo({ personaId: 'p', startFrame: 'Nora', action: 'talks', line: long, durationS: 5 }, CTX);
    expect(split.settings.duration_s).toBe(CLIP_MAX_S);
    expect(split.settings.split).toBe(2);
    expect(split.notes.join(' ')).toMatch(/split it into 2 clips/);
    expect(checkVideoPrompt(split, { line: long }).find((x) => x.check === 'speech_pace')!.pass).toBe(false);
  });

  it('the accent falls back to the bible, then the World Bible country, then neutral English', () => {
    expect(accentPhrase('a soft Scottish accent')).toBe('fluent soft Scottish accent');
    const noBible = { ...CTX, accent: null };
    expect(compileVideo({ personaId: 'p', startFrame: 'x', action: 'y', line: 'Hello there, love.', durationS: 3, grounding: G }, noBible).blocks.action).toMatch(/fluent British English accent/);
    expect(compileVideo({ personaId: 'p', startFrame: 'x', action: 'y', line: 'Hello there.', durationS: 3 }, noBible).blocks.action).toMatch(/fluent neutral English accent/);
    expect(compileVideo({ personaId: 'p', startFrame: 'x', action: 'y', line: 'Hi.', durationS: 3, accent: 'Texan' }, CTX).blocks.audio).toMatch(/fluent Texan accent/);
  });

  it('strips timecodes but keeps clock times and the 9:16 aspect', () => {
    expect(stripTimecodes('0:03 she smiles at 6:30 pm in 9:16')).toBe('she smiles at 6:30 pm in 9:16');
    expect(stripTimecodes('0–3 s: wave. Then nod')).toBe('wave. Then nod');
  });
});

describe('createPromptCompiler on StudioServices', () => {
  it('loads the bible, the identity stack and the location lock; grounding comes from the world service; pins never become references', async () => {
    const world: WorldService = {
      ...nullWorld(),
      grounding: async () => G,
      moodBoard: async () => ({ pins: [{ id: 'pin1', url: 'https://pinterest.example/pin/1', imageUrl: 'https://i.pinimg.example/face.jpg', title: 'a stranger', description: '', board: null, source: 'apify' }], descriptors: ['sage'] }),
    };
    const t = await createTestStudio({ prompts: createPromptCompiler, world: () => world });
    const p = await makeTestPersona(t, { name: 'Nora Vale' });
    await attachSampleBible(t.db, p.id);
    await t.db.query(`UPDATE persona_bible SET content = jsonb_set(content, '{voice,accent}', $2::jsonb) WHERE persona_id = $1`, [p.id, json('Yorkshire')]);
    await saveIdentityRef(t.db, { personaId: p.id, kind: 'face', label: 'face close-up', prompt: 'p', url: 'https://hf.example/face.png' });
    await saveIdentityRef(t.db, { personaId: p.id, kind: 'full_body', label: 'full body front', prompt: 'p', url: 'https://hf.example/body.png' });
    await saveIdentityRef(t.db, { personaId: p.id, kind: 'full_body', label: 'drifted', prompt: 'p', url: 'https://hf.example/drift.png', status: 'candidate' });
    await ensureLocations(t.db, p.id, [{ place: 'The Kitchen', description: 'green tiles' }]);
    await lockLocation(t.db, p.id, placeKey('the kitchen'), { refs: [{ url: 'https://hf.example/kitchen.png', assetKey: null, angle: 'wide' }], candidates: [], chosen: 0, at: new Date() });

    const img = await t.services.prompts.image({ personaId: p.id, scene: 'pouring tea', location: 'kitchen', mood: (await world.moodBoard({ personaId: p.id })).descriptors });
    expect(img.text).toContain(G.block);
    expect(img.references).toEqual(['https://hf.example/face.png', 'https://hf.example/body.png', 'https://hf.example/kitchen.png']);
    expect(img.references.join(' ')).not.toMatch(/pinimg|pinterest/);
    expect(img.blocks.subject).toContain('Nora Vale');

    const vid = await t.services.prompts.video({ personaId: p.id, startFrame: 'Nora', action: 'talks', line: 'Kettle on, love.', durationS: 3 });
    expect(vid.blocks.action).toMatch(/fluent Yorkshire accent/);
    expect(vid.text).toContain(NO_CAPTIONS);
    expect(vid.text).toContain(G.block);
  });
});
