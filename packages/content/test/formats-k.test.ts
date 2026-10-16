import { createTestStudio, makeTestPersona } from '@ios/agents/testing';
import { OPTIONAL_FORMATS, type PostFormat } from '@ios/core';
import { describe, expect, it } from 'vitest';
import { fillTemplate, HOOK_TEMPLATES, templatesFor } from '../src/hooks';
import { loadPersonaContext } from '../src/persona';
import { asksBakedText, checkScript, hasTimecodes, motionChecks, twoHandedActions } from '../src/qc';
import { attachSampleBible } from '../src/sample';
import {
  anonymiseHandle,
  enforceScript,
  fakeScript,
  FORMAT_RULES,
  mentionsOutlet,
  newsDeskHeadline,
  PHOTO_DUMP,
  sanitizeOverlay,
  type ScriptBrief,
  type ScriptDraft,
  showsHandle,
  SPOKEN,
  visualBrief,
} from '../src/script';

/** IOS-5 stream K: script rules and Q1 for the format library, the timing and motion rules, the hook templates. */

async function briefFor(format: PostFormat, title = 'Sinking funds') {
  const t = await createTestStudio();
  const p = await makeTestPersona(t, { name: 'Nora Vale' });
  await attachSampleBible(t.db, p.id);
  const ctx = await loadPersonaContext(t.db, p.id);
  const hook = { text: 'Your paycheck is gone by the 20th?', type: 'question' as const, score: 80, reasons: [] };
  const brief: ScriptBrief = { ctx, title, pillar: 'Budget basics', format, purpose: 'reach', ctaKeyword: 'PLAN', ctaDelivers: 'Paycheck Plan Starter (free)', hook, variants: [], knowledge: [] };
  return { brief, ctx };
}

const q1 = (d: ScriptDraft, b: ScriptBrief) => checkScript(d, { format: b.format, expectedKeyword: 'PLAN', ctx: b.ctx, evidenceIds: [] });
const failing = (d: ScriptDraft, b: ScriptBrief) => q1(d, b).checks.filter((c) => !c.pass && c.severity !== 'minor').map((c) => c.check);

describe('format library scripts (fake mode) pass Q1 in their own shape', () => {
  it.each(OPTIONAL_FORMATS)('%s: fakeScript passes Q1; enforceScript keeps it passing', async (format) => {
    const { brief } = await briefFor(format);
    const d = fakeScript(brief);
    expect(failing(d, brief)).toEqual([]);
    expect(failing(enforceScript(d, brief), brief)).toEqual([]);
    expect(FORMAT_RULES[format]).toBeTruthy();
    expect(motionChecks(d.visualBrief).every((c) => c.pass)).toBe(true);
  });

  it('spoken library formats carry a voice track; photo dumps are 5–10 captioned photos with the CTA in the caption', async () => {
    expect(SPOKEN).toEqual(expect.arrayContaining(['facecam_screen', 'reply_comment', 'news_greenscreen']));
    const { brief } = await briefFor('photo_dump');
    const d = fakeScript(brief);
    expect(d.carousel!.length).toBeGreaterThanOrEqual(PHOTO_DUMP.min);
    expect(d.carousel!.length).toBeLessThanOrEqual(PHOTO_DUMP.max);
    expect(d.carousel!.some((s) => /PLAN/.test(s.title))).toBe(false);
    expect(d.caption).toMatch(/Comment PLAN/);
    const tooFew: ScriptDraft = { ...d, carousel: d.carousel!.slice(0, 3), onScreenText: d.onScreenText.slice(0, 3) };
    expect(failing(tooFew, brief)).toContain('length');
    const fixed = enforceScript(tooFew, brief);
    expect(fixed.carousel!.length).toBeGreaterThanOrEqual(PHOTO_DUMP.min);
  });

  it('text notes ≤ 25 words, memes ≤ 15, facecam 3–6 slide lines', async () => {
    const note = await briefFor('text_note');
    const long: ScriptDraft = { ...fakeScript(note.brief), onScreenText: [`${note.brief.hook.text} ${'and then some more words '.repeat(6)}`] };
    expect(failing(long, note.brief)).toContain('length');
    expect(failing(enforceScript(long, note.brief), note.brief)).toEqual([]);
    const meme = await briefFor('meme');
    const m = fakeScript(meme.brief);
    expect(m.onScreenText[0]!.split(/\s+/).length).toBeLessThanOrEqual(15);
    const face = await briefFor('facecam_screen');
    const f = fakeScript(face.brief);
    expect(f.onScreenText.length).toBeGreaterThanOrEqual(3);
    expect(f.onScreenText.length).toBeLessThanOrEqual(6);
    expect(failing({ ...f, onScreenText: [f.hook] }, face.brief)).toContain('screen_lines');
  });

  it('news: never names a real outlet; reply: never shows a viewer handle', async () => {
    const news = await briefFor('news_greenscreen');
    const d = fakeScript(news.brief);
    const named: ScriptDraft = { ...d, body: d.body.replace(/^(.*?[.?!])/, '$1 According to Reuters, rates fell.'), caption: `${d.caption} (via BBC News)` };
    expect(failing(named, news.brief)).toContain('no_outlet');
    const fixed = enforceScript(named, news.brief);
    expect(mentionsOutlet(`${fixed.body} ${fixed.caption}`)).toBeNull();
    const reply = await briefFor('reply_comment');
    const r = fakeScript(reply.brief);
    expect(failing({ ...r, caption: `${r.caption} @jane_doe99` }, reply.brief)).toContain('handle_anonymised');
  });
});

describe('Q1 timing and motion rules (PRD §3.15.5)', () => {
  it('speech pace sets the clip count at 2.5–3 wps; the accent is reported', async () => {
    const { brief } = await briefFor('talking');
    const res = q1(fakeScript(brief), brief);
    const pace = res.checks.find((c) => c.check === 'speech_pace')!;
    expect(pace.pass).toBe(true);
    expect(pace.message).toMatch(/2\.5–3 words a second: \d clip\(s\) of ≤ 10 s/);
    expect(res.checks.find((c) => c.check === 'accent')!.severity).toBe('minor');
  });

  it('flags timecodes and baked-in text (majors) and two-handed fine-motor actions (minor)', () => {
    expect(hasTimecodes('0:03 she waves')).toBe(true);
    expect(hasTimecodes('[2s] cut to the desk')).toBe(true);
    expect(hasTimecodes('0–3 s: wave')).toBe(true);
    expect(hasTimecodes('Talking reel, 9:16, about 30 s, at 6:30 pm light, 18:30')).toBe(false);
    expect(asksBakedText('A sign that says OPEN on the door.')).toBe(true);
    expect(asksBakedText('No on-image text. Text overlay added in edit.')).toBe(false);
    expect(twoHandedActions('She is tying her shoelaces, then knitting by the fire.')).toEqual(['tying her shoelaces', 'knitting']);
    expect(twoHandedActions('Never typing on camera.')).toEqual([]);
    const checks = Object.fromEntries(motionChecks('0:02 she types. A banner reading SALE. Typing fast.').map((c) => [c.check, c]));
    expect(checks.no_timecodes!.pass).toBe(false);
    expect(checks.no_baked_text!.pass).toBe(false);
    expect(checks.two_handed_action).toMatchObject({ pass: false, severity: 'minor' });
  });

  it('the default visual briefs never trip the rules', async () => {
    const { ctx } = await briefFor('talking');
    for (const f of ['talking', 'activity_text', 'voiceover', 'static', 'carousel', ...OPTIONAL_FORMATS] as PostFormat[]) expect(motionChecks(visualBrief(ctx, f, 'Sinking funds')).filter((c) => !c.pass)).toEqual([]);
  });
});

describe('overlay safety helpers', () => {
  it('anonymises handles, sanitises viewer text, writes News Desk headlines in our words', () => {
    expect(anonymiseHandle('jane_doe99')).toBe('@••••••');
    expect(showsHandle('@•••••• asked')).toBe(false);
    expect(showsHandle('@jane asked')).toBe(true);
    expect(sanitizeOverlay('@jane_doe99 how do I start?? email me jane@x.com or www.spam.com or call +44 7700 900123')).toBe('how do I start?? email me or or call');
    expect(sanitizeOverlay('@a https://x.y')).toBe('');
    expect(sanitizeOverlay('word '.repeat(60)).length).toBeLessThanOrEqual(121);
    expect(newsDeskHeadline('Interest rates cut again - BBC News')).toBe('Interest rates cut again');
    expect(newsDeskHeadline('Saving rates rise - and why it matters')).toBe('Saving rates rise - and why it matters');
    expect(newsDeskHeadline('Reuters: inflation falls')).toBe('a news report: inflation falls');
    expect(mentionsOutlet('the sun is out and the mirror is clean')).toBeNull();
  });

  it('hook templates fill a topic and list a format’s fits first', () => {
    expect(HOOK_TEMPLATES.length).toBeGreaterThanOrEqual(10);
    expect(templatesFor('meme')[0]!.formats).toContain('meme');
    expect(fillTemplate(HOOK_TEMPLATES.find((t) => t.id === 'three_mistakes')!, 'Budgeting')).toBe('3 mistakes most people make with budgeting');
  });
});
