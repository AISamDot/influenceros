import { createTestStudio, makeTestPersona } from '@ios/agents/testing';
import { createFakeProviders } from '@ios/providers';
import { describe, expect, it } from 'vitest';
import { loadPersonaContext } from '../src/persona';
import { q1WithFixes } from '../src/pipeline';
import { alignWords, checkScript, diffTokens, gradeVoice, voiceCheck } from '../src/qc';
import { attachSampleBible } from '../src/sample';
import { enforceScript, fakeScript, type ScriptBrief, type ScriptDraft } from '../src/script';
import { numberToWords, ttsNormalize, yearToWords } from '../src/tts';

const VOICE = { voice: { wpm: 160, lexicon: [], avoid: ['hustle'], catchphrases: [], energy: '' } };

function talking(over: Partial<ScriptDraft> = {}): ScriptDraft {
  const hook = 'Your paycheck is gone by the 20th?';
  return {
    hook,
    body: `${hook} Here is the calm fix. First, move your fixed bills into one account on payday. Then, give yourself a weekly allowance for everything else. Finally, check in for fifteen minutes every Sunday and adjust. Small and automatic beats big and heroic. Comment PLAN and I'll send you the free starter.`,
    caption: `${hook}\n\nThree accounts, one weekly check-in.\n\nComment PLAN for the free starter.`,
    ctaKeyword: 'PLAN',
    hashtags: ['#personalfinance', '#budgeting', '#moneytips'],
    onScreenText: [hook],
    carousel: null,
    visualBrief: 'Talking reel, 9:16. No logos, brands, real people or celebrity lookalikes.',
    claims: [],
    ...over,
  };
}
const grade = (d: ScriptDraft, evidenceIds: string[] = [], expectedKeyword = 'PLAN') => checkScript(d, { format: 'talking', expectedKeyword, ctx: VOICE, evidenceIds });
const failed = (d: ScriptDraft, evidenceIds: string[] = [], kw = 'PLAN') =>
  grade(d, evidenceIds, kw)
    .checks.filter((c) => !c.pass)
    .map((c) => c.check);

describe('QC Q1: script checks', () => {
  it('passes a clean spoken script and produces TTS-safe voice text', () => {
    const g = grade(talking({ body: talking().body.replace('fifteen minutes', '15 minutes') }));
    expect(g.pass).toBe(true);
    expect(g.wordCount).toBeGreaterThanOrEqual(40);
    expect(g.wordCount).toBeLessThanOrEqual(90);
    expect(g.estSeconds).toBeGreaterThanOrEqual(15);
    expect(g.voiceover).toContain('fifteen minutes');
    expect(g.voiceover).toContain('Comment PLAN');
    expect(g.checks.find((c) => c.check === 'tts_pronunciation')?.message).toMatch(/15 → fifteen/);
  });

  it('flags the hook not being first, a missing or wrong CTA, length and repeats', () => {
    expect(failed(talking({ body: talking().body.replace('Your paycheck is gone by the 20th? ', 'So. ') }))).toContain('hook_first');
    expect(failed(talking({ body: talking().body.replace("Comment PLAN and I'll send you the free starter.", 'Thanks for watching.') }))).toContain('cta');
    expect(failed(talking(), [], 'SHEET')).toContain('cta_keyword');
    expect(failed(talking({ body: 'Your paycheck is gone by the 20th? Comment PLAN.' }))).toContain('length');
    expect(failed(talking({ body: `${talking().body} ${'Keep going and keep it simple every single week. '.repeat(8)}` }))).toEqual(expect.arrayContaining(['length', 'repeated_lines']));
  });

  it('accepts a two-sentence hook the script opens with, and the maker fix does not repeat it', async () => {
    const hook = 'Stop. Your paycheck is gone by the 20th?';
    const d = talking({ hook, body: `Stop. ${talking().body}`, onScreenText: [hook] });
    expect(failed(d)).not.toContain('hook_first');
    expect(failed(d)).not.toContain('repeated_lines');
    const t = await createTestStudio();
    const p = await makeTestPersona(t);
    await attachSampleBible(t.db, p.id);
    const ctx = await loadPersonaContext(t.db, p.id);
    await t.db.close();
    const fixed = enforceScript(d, { ctx, format: 'talking', purpose: 'trust', ctaKeyword: 'PLAN', ctaDelivers: 'the free starter', knowledge: [], title: 'Payday', pillar: null });
    expect(fixed.body.startsWith(hook)).toBe(true);
    expect(fixed.body.indexOf(hook, 1)).toBe(-1);
    expect(failed(fixed)).not.toEqual(expect.arrayContaining(['hook_first']));
  });

  it('flags uncited factual claims and accepts cited ones', () => {
    const claim = 'Research shows 60% of people run out of money before payday.';
    const body = talking().body.replace('Small and automatic beats big and heroic.', claim);
    expect(failed(talking({ body }))).toContain('claims_cited');
    const cited = talking({ body, claims: [{ text: claim, evidenceId: 'node-1' }] });
    expect(failed(cited, ['node-1'])).not.toContain('claims_cited');
    expect(failed(cited, [])).toContain('claims_cited'); // the id must be a real knowledge hit
  });

  it('enforces English only, the persona voice and spelling', () => {
    expect(grade(talking({ body: `${talking().body} Это важно.` })).checks.find((c) => c.check === 'english_only')).toMatchObject({ pass: false, severity: 'blocker' });
    expect(failed(talking({ body: talking().body.replace('the calm fix', 'the hustle fix') }))).toContain('persona_voice');
    expect(failed(talking({ caption: `${talking().caption} Seperate the the accounts.` }))).toContain('spelling');
  });

  it('checks activity, static and carousel shapes', () => {
    const activity: ScriptDraft = { ...talking(), hook: 'POV: payday is calm now', onScreenText: ['POV: payday is calm now', 'Bills move on day one', 'Comment PLAN for the starter'], body: '' };
    expect(checkScript(activity, { format: 'activity_text', expectedKeyword: 'PLAN', ctx: VOICE, evidenceIds: [] }).pass).toBe(true);
    const carousel: ScriptDraft = { ...talking(), carousel: [{ title: 'Hook', body: 'x' }], onScreenText: [] };
    expect(checkScript(carousel, { format: 'carousel', expectedKeyword: 'PLAN', ctx: VOICE, evidenceIds: [] }).checks.find((c) => c.check === 'length')?.pass).toBe(false);
  });

  it('runs the maker fix loop (max 2) until the script passes, saving a report per pass', async () => {
    const t = await createTestStudio();
    const p = await makeTestPersona(t);
    await attachSampleBible(t.db, p.id);
    const ctx = await loadPersonaContext(t.db, p.id);
    const hook = { text: 'Your paycheck is gone by the 20th?', type: 'question' as const, score: 80, reasons: [] };
    const brief: ScriptBrief = { ctx, title: 'Sinking funds', pillar: 'Budget basics', format: 'talking', purpose: 'reach', ctaKeyword: 'PLAN', ctaDelivers: 'Paycheck Plan Starter (free)', hook, variants: [], knowledge: [] };
    const bad: ScriptDraft = { ...fakeScript(brief), body: 'So. Studies show 80% of budgets fail. Thanks for watching.', caption: 'No keyword here.' };
    const script = await t.db.one<{ id: string }>(`INSERT INTO script (persona_id, body) VALUES ($1, 'x') RETURNING id`, [p.id]);
    const res = await q1WithFixes(t.services, { brief, draft: bad, scriptId: script.id, evidenceIds: [] });
    expect(res.grade.pass).toBe(true);
    expect(res.loops).toBe(1);
    expect(res.draft.body.startsWith(hook.text)).toBe(true);
    expect(res.draft.body).toMatch(/Comment PLAN/);
    expect(res.draft.body).not.toMatch(/Studies show/);
    const reports = await t.db.query<{ pass: boolean }>(`SELECT pass FROM qc_report WHERE subject_id = $1 AND stage = 'Q1' ORDER BY created_at`, [script.id]);
    expect(reports.map((r) => r.pass)).toEqual([false, true]);
    const defects = await t.db.query<{ type: string }>(`SELECT type FROM qc_defect WHERE persona_id = $1`, [p.id]);
    expect(defects.map((d) => d.type)).toEqual(expect.arrayContaining(['hook_first', 'cta', 'claims_cited']));
    await t.db.close();
  });
});

describe('TTS pronunciation normaliser', () => {
  it('speaks numbers, money, percentages, times and symbols', () => {
    expect(numberToWords(1234)).toBe('one thousand two hundred thirty-four');
    expect(numberToWords(3.5)).toBe('three point five');
    expect(yearToWords(2027)).toBe('twenty twenty-seven');
    const { text, risks } = ttsNormalize('Save $1,200 by 2027: 40% of $5K/month & 3 tips at 7:30am, 24/7 (e.g. ETF vs. APR). #money https://x.co', { keep: ['PLAN'] });
    expect(text).toBe(
      'Save one thousand two hundred dollars by twenty twenty-seven: forty percent of five thousand dollars a month and three tips at seven thirty a.m., twenty-four seven (for example, E-T-F versus A-P-R).',
    );
    expect(risks.map((r) => r.kind)).toEqual(expect.arrayContaining(['money', 'percent', 'time', 'number', 'acronym', 'abbreviation', 'hashtag', 'url']));
    expect(ttsNormalize('Comment PLAN now').text).toBe('Comment PLAN now');
    // UK pence (Dot): never "five zero p" or "zero pounds ninety-nine".
    expect(ttsNormalize('A 50p tin, or £0.99 for two.').text).toBe('A fifty p tin, or ninety-nine p for two.');
  });
});

describe('QC Q2: voice re-transcription diff', () => {
  it('aligns words and computes the word-error rate', () => {
    expect(diffTokens("Don't spend $40 on it!")).toEqual(['dont', 'spend', 'forty', 'dollars', 'on', 'it']);
    const ops = alignWords(['a', 'b', 'c'], ['a', 'x', 'c', 'd']);
    expect(ops.map((o) => o.op)).toEqual(['ok', 'sub', 'ok', 'ins']);
  });

  it('passes a perfect read and catches a misheard word through FakeTranscriber', async () => {
    const providers = createFakeProviders({ mishear: (text) => text.replace(/\bsinking\b/i, 'sinkhole') });
    const t = await createTestStudio({ providers });
    const p = await makeTestPersona(t, { name: 'Nora Vale' });
    const text = "Sinking funds are small monthly savings for big bills you already know are coming. Name each one, divide by the months left, and automate it. Comment PLAN and I'll send you the free starter.";
    const script = await t.db.one<{ id: string }>(`INSERT INTO script (persona_id, body, voiceover, cta_keyword) VALUES ($1, $2, $2, 'PLAN') RETURNING id`, [p.id, text]);

    // Clean read: the plain fake (no mishear) returns exactly what FakeVoice synthesised.
    const clean = createFakeProviders();
    const audio = await clean.voice.tts({ voiceId: 'v1', text });
    const ok = await voiceCheck({ ...t.services, providers: clean }, { studioId: t.studioId, personaId: p.id, scriptId: script.id, audioUrl: audio.url });
    expect(ok.pass).toBe(true);
    expect(ok.wer).toBe(0);

    // Misheard read: "sinking" → "sinkhole" is a content word, so Q2 fails before any avatar credits are spent.
    const bad = await providers.voice.tts({ voiceId: 'v1', text });
    const res = await voiceCheck(t.services, { studioId: t.studioId, personaId: p.id, scriptId: script.id, audioUrl: bad.url });
    expect(res.pass).toBe(false);
    expect(res.misheard).toEqual([{ expected: 'sinking', heard: 'sinkhole', atS: 0 }]);
    const mis = res.checks.find((c) => c.check === 'mispronunciation');
    expect(mis).toMatchObject({ pass: false, severity: 'major', location: '0:00.0' });
    expect(providers.transcribe.callsTo('transcribe')).toHaveLength(1);
    const report = await t.db.one<{ stage: string; pass: boolean; details: { wer: number } }>(`SELECT stage, pass, details FROM qc_report WHERE id = $1`, [res.reportId]);
    expect(report).toMatchObject({ stage: 'Q2', pass: false });
    expect(report.details.wer).toBeGreaterThan(0);
    // Transcription is metered as media spend.
    const debit = await t.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM credit_ledger WHERE unit = 'media_usd' AND operation = 'transcribe' AND entry_type = 'debit'`);
    expect(debit.n).toBe(2);
    await t.db.close();
  });

  it('treats a cut-off ending as a blocker and a wrong voice as a blocker', () => {
    const expected = 'Name each fund and automate the transfer every payday.';
    const words = diffTokens('Name each fund and automate the transfer').map((w, i) => ({ word: w, startS: i * 0.4, endS: i * 0.4 + 0.35 }));
    const cut = gradeVoice(expected, { text: words.map((w) => w.word).join(' '), words, durationS: 3 });
    expect(cut.checks.find((c) => c.check === 'cut_off')).toMatchObject({ pass: false, severity: 'blocker' });
    expect(cut.pass).toBe(false);
    const full = diffTokens(expected).map((w, i) => ({ word: w, startS: i * 0.4, endS: i * 0.4 + 0.35 }));
    const wrongVoice = gradeVoice(expected, { text: expected, words: full, durationS: 3.6 }, { voiceId: 'v2', expectedVoiceId: 'v1' });
    expect(wrongVoice.checks.find((c) => c.check === 'voice_id')).toMatchObject({ pass: false, severity: 'blocker' });
  });
});
