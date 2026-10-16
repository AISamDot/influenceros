import { CLIP_MAX_S, type QcCheck, SPEECH_WPS, speechSeconds, type StudioServices } from '@ios/agents';
import { type CostRef, metered, type PostFormat, scriptShape } from '@ios/core';
import { json } from '@ios/db';
import type { TranscriptWord } from '@ios/providers';
import type { PersonaContext } from './persona';
import { FACECAM_LINES, MEME_WORDS, mentionsOutlet, ON_SCREEN_WORDS, PHOTO_DUMP, SECONDS, showsHandle, SPOKEN, TEXT_NOTE_WORDS, uncitedClaims, WORDS, type ScriptDraft } from './script';
import { residualTtsRisks, ttsNormalize, type TtsRisk } from './tts';
import { asRecord, asString, sentences, similarity, wordCount } from './util';

/**
 * Quality Control (PRD §3.6, FR-21). Independent of the makers: it grades, it never writes the fix itself.
 * Q1 (script, before any voice spend) and Q2 (voice: re-transcribe and diff, before any avatar spend).
 * Severity: blocker (never ships), major (fixed by the maker, max 2 loops), minor (logged).
 */

export interface QcResult {
  readonly pass: boolean;
  readonly score: number;
  readonly checks: QcCheck[];
}

export const qcPass = (checks: readonly QcCheck[]): boolean => !checks.some((c) => !c.pass && (c.severity === 'blocker' || c.severity === 'major'));
export const qcScore = (checks: readonly QcCheck[]): number =>
  Math.max(0, 100 - checks.filter((c) => !c.pass).reduce((a, c) => a + (c.severity === 'blocker' ? 25 : c.severity === 'major' ? 10 : 3), 0));

const ok = (check: string, severity: QcCheck['severity'], message: string, location?: string): QcCheck => ({ check, pass: true, severity, message, ...(location ? { location } : {}) });
const fail = (check: string, severity: QcCheck['severity'], message: string, location?: string): QcCheck => ({ check, pass: false, severity, message, ...(location ? { location } : {}) });

const NON_LATIN = /[\p{Script=Arabic}\p{Script=Cyrillic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Devanagari}\p{Script=Hebrew}\p{Script=Thai}\p{Script=Greek}]/u;
const FOREIGN = new Set(['el', 'los', 'las', 'que', 'por', 'para', 'una', 'est', 'les', 'und', 'der', 'die', 'das', 'nicht', 'ist', 'pero', 'muy', 'avec', 'pour', 'dans', 'sont']);
const MISSPELLINGS: Record<string, string> = {
  teh: 'the', recieve: 'receive', seperate: 'separate', definately: 'definitely', occured: 'occurred', untill: 'until', wich: 'which',
  alot: 'a lot', thier: 'their', becuase: 'because', beleive: 'believe', goverment: 'government', tommorow: 'tomorrow', accomodate: 'accommodate',
  neccessary: 'necessary', existance: 'existence', wierd: 'weird', enviroment: 'environment', persue: 'pursue', calender: 'calendar',
  buisness: 'business', foward: 'forward', freind: 'friend', excercise: 'exercise', grammer: 'grammar', libary: 'library', truely: 'truly',
};

// ───────────────────────────── Timing and motion rules (IOS-5 stream K; PRD §3.15.5) ─────────────────────────────

/** Timecodes ("0:03", "[2s]", "at 4 s", "0–3 s:") never go in a visual brief or a video prompt: actions bind to words. */
const TIMECODE_RE =
  /(?<![\d:.])(?!9:16\b)0?\d:[0-5]\d(?::[0-5]\d)?(?!\d|\s?(?:am|pm)\b)|\[\s*\d+(?:\.\d+)?\s*s?\s*\]|\b(?:at|from|until)\s+\d+(?:\.\d+)?\s?(?:s|secs?|seconds)\b|\b\d+(?:\.\d+)?\s?(?:s|secs?)?\s?[-–]\s?\d+(?:\.\d+)?\s?(?:s|secs?|seconds)\s*[:)]/i;
export const hasTimecodes = (text: string): boolean => TIMECODE_RE.test(text);

/** A generation asked to carry readable text (captions are added in the edit, so they can be re-captioned per platform). */
const BAKED_TEXT_RE =
  /\b(?:text|captions?|subtitles?|title|words?|letters|lettering|sign|label|banner)\s+(?:that\s+)?(?:says|saying|reads|reading)\b|\b(?:with|showing|displaying)\s+(?:the\s+)?(?:words?|text|captions?|lettering)\b|["“][^"”]{3,}["”]\s+(?:written|printed|painted|spelled)\b/i;
export function asksBakedText(text: string): boolean {
  return sentences(text).some((s) => !/^(?:no|never|avoid|without|don'?t)\b/i.test(s.trim()) && BAKED_TEXT_RE.test(s));
}

/** Two-handed fine-motor actions: high-risk for video models (melted fingers), so they are flagged to simplify or split. */
const TWO_HANDED_RE =
  /\b(?:ty(?:ing|e)\s+(?:(?:her|his|my|the)\s+)?(?:shoe)?laces?|tying\s+a\s+(?:tie|knot|bow)|knit(?:s|ting)?|crochet(?:s|ing)?|sew(?:s|ing)|thread(?:s|ing)?\s+a\s+needle|braid(?:s|ing)|plait(?:s|ing)|shuffl(?:e|es|ing)\s+(?:a\s+deck|cards)|typing|play(?:s|ing)?\s+(?:the\s+)?(?:piano|guitar|violin)|fold(?:s|ing)\s+(?:paper|origami|a\s+(?:shirt|towel|letter|napkin))|origami|button(?:s|ing)\s+(?:up\s+)?(?:a|her|his)\s+(?:shirt|coat|cardigan)|chopping|peel(?:s|ing)\s+an?\s+\w+|wrap(?:s|ping)\s+a\s+(?:gift|present)|count(?:s|ing)\s+(?:cash|money|notes|coins|banknotes))\b/i;
export function twoHandedActions(text: string): string[] {
  return sentences(text)
    .filter((s) => !/^(?:no|never|avoid|without|don'?t)\b/i.test(s.trim()))
    .flatMap((s) => [...s.matchAll(new RegExp(TWO_HANDED_RE.source, 'gi'))].map((m) => m[0]));
}

/** The visual-brief rules every format shares: no timecodes, no baked-in text, two-handed actions flagged. */
export function motionChecks(visualBrief: string): QcCheck[] {
  const checks: QcCheck[] = [];
  checks.push(
    hasTimecodes(visualBrief)
      ? fail('no_timecodes', 'major', 'The visual brief carries timecodes: bind actions to the words that trigger them instead.')
      : ok('no_timecodes', 'major', 'No timecodes in the visual brief.'),
  );
  checks.push(
    asksBakedText(visualBrief)
      ? fail('no_baked_text', 'major', 'The visual brief asks for text inside the generation: captions and on-screen text are added in the edit.')
      : ok('no_baked_text', 'major', 'No text baked into generations.'),
  );
  const hands = twoHandedActions(visualBrief);
  checks.push(
    hands.length
      ? fail('two_handed_action', 'minor', `High-risk two-handed action ("${hands[0]}"): simplify it or split it into separate shots.`)
      : ok('two_handed_action', 'minor', 'No two-handed fine-motor actions.'),
  );
  return checks;
}

/** The spoken text Q1 grades, plus where the CTA must be. */
function surfaces(d: ScriptDraft, format: PostFormat): { primary: string[]; ctaHost: string } {
  const shape = scriptShape(format);
  if (SPOKEN.includes(format)) {
    const lines = sentences(d.body);
    return { primary: lines, ctaHost: lines.slice(-2).join(' ') };
  }
  if (shape === 'activity_text') return { primary: d.onScreenText, ctaHost: d.onScreenText.at(-1) ?? '' };
  if (format === 'photo_dump') {
    // The photos carry the story; the caption carries the CTA.
    const items = d.carousel?.length ? d.carousel.map((s) => s.title) : d.onScreenText;
    return { primary: items, ctaHost: d.caption };
  }
  if (shape === 'carousel') {
    const slides = (d.carousel ?? []).map((s) => `${s.title}. ${s.body}`);
    return { primary: slides, ctaHost: slides.at(-1) ?? '' };
  }
  return { primary: d.onScreenText.length ? d.onScreenText : [d.body], ctaHost: d.caption };
}

/**
 * Q1 script checks (pure): English only, hook first, length vs duration, the right CTA keyword, no repeated lines,
 * TTS pronunciation risks (rewritten into `voiceover`), claims needing citations, persona voice, spelling, caption.
 */
export function checkScript(
  d: ScriptDraft,
  o: { format: PostFormat; expectedKeyword: string; ctx: Pick<PersonaContext, 'voice'> & Partial<Pick<PersonaContext, 'bible'>>; evidenceIds: readonly string[] },
): QcResult & { voiceover: string | null; ttsRisks: TtsRisk[]; wordCount: number; estSeconds: number | null } {
  const checks: QcCheck[] = [];
  const shape = scriptShape(o.format);
  const all = [d.body, d.caption, ...d.onScreenText, ...(d.carousel ?? []).flatMap((s) => [s.title, s.body])].join('\n');
  const { primary, ctaHost } = surfaces(d, o.format);

  // English only.
  const tokens = all.toLowerCase().match(/[a-zà-ÿ]+/g) ?? [];
  const foreign = tokens.filter((t) => FOREIGN.has(t)).length;
  checks.push(
    NON_LATIN.test(all) || (tokens.length >= 10 && foreign / tokens.length > 0.12)
      ? fail('english_only', 'blocker', 'Not in English: every post is English only.')
      : ok('english_only', 'blocker', 'English.'),
  );

  // Hook in the first line (a hook can be several sentences: "Stop. Your savings account is losing money.").
  const hookSentences = Math.max(1, sentences(d.hook).length);
  const first = primary.slice(0, hookSentences).join(' ');
  checks.push(
    first && (first.startsWith(d.hook) || similarity(first, d.hook) >= 0.8)
      ? ok('hook_first', 'major', 'Opens with the hook.')
      : fail('hook_first', 'major', `The first line must be the hook ("${d.hook}").`, 'line 1'),
  );
  const hookWords = wordCount(d.hook);
  checks.push(
    hookWords <= 12 ? ok('hook_length', 'minor', `Hook is ${hookWords} words.`) : fail('hook_length', hookWords > 16 ? 'major' : 'minor', `Hook is ${hookWords} words (aim for 12 or fewer).`, 'line 1'),
  );

  // Length vs target duration.
  const words = wordCount(SPOKEN.includes(o.format) ? d.body : primary.join(' '));
  let estSeconds: number | null = null;
  if (SPOKEN.includes(o.format)) {
    estSeconds = Math.round((words / o.ctx.voice.wpm) * 600) / 10;
    checks.push(
      words >= WORDS.min && words <= WORDS.max
        ? ok('length', 'major', `${words} words.`)
        : fail('length', 'major', `${words} words: spoken scripts are ${WORDS.min}–${WORDS.max} words.`),
    );
    checks.push(
      estSeconds >= SECONDS.min - 1 && estSeconds <= SECONDS.max + 2
        ? ok('duration', 'minor', `About ${estSeconds} s at ${o.ctx.voice.wpm} wpm.`)
        : fail('duration', 'minor', `About ${estSeconds} s at ${o.ctx.voice.wpm} wpm (target ${SECONDS.min}–${SECONDS.max} s).`),
    );
    // (IOS-5) Clip length is set from the word count at 2.5–3 words a second; clips are ≤ 10 s and stitched.
    const slow = speechSeconds(words);
    const fast = Math.round((words / SPEECH_WPS.max) * 10) / 10;
    const clips = Math.max(1, Math.ceil(slow / CLIP_MAX_S - 1e-9));
    checks.push(
      slow >= 12 && slow <= 60
        ? ok('speech_pace', 'major', `${fast}–${slow} s of speech at ${SPEECH_WPS.min}–${SPEECH_WPS.max} words a second: ${clips} clip(s) of ≤ ${CLIP_MAX_S} s.`)
        : fail('speech_pace', 'major', `${fast}–${slow} s of speech at ${SPEECH_WPS.min}–${SPEECH_WPS.max} words a second: spoken posts run 12–60 s.`),
    );
    const accent = asString(asRecord(asRecord(o.ctx.bible).voice).accent).trim();
    checks.push(
      accent
        ? ok('accent', 'minor', `Accent in every talking prompt: ${accent}.`)
        : fail('accent', 'minor', 'No accent in the bible: talking prompts fall back to a neutral English accent.'),
    );
    if (o.format === 'facecam_screen') {
      const n = d.onScreenText.length;
      const long = d.onScreenText.filter((l) => wordCount(l) > FACECAM_LINES.words);
      checks.push(
        n >= FACECAM_LINES.min && n <= FACECAM_LINES.max && !long.length
          ? ok('screen_lines', 'major', `${n} slide lines for the screen.`)
          : fail('screen_lines', 'major', `Facecam posts need ${FACECAM_LINES.min}–${FACECAM_LINES.max} slide lines of at most ${FACECAM_LINES.words} words (${n} lines${long.length ? `, ${long.length} too long` : ''}).`),
      );
    }
  } else if (shape === 'activity_text') {
    const long = d.onScreenText.filter((l) => wordCount(l) > 8);
    const n = d.onScreenText.length;
    checks.push(
      n >= 3 && n <= 5 && !long.length
        ? ok('length', 'major', `${n} on-screen lines.`)
        : fail('length', 'major', `Activity posts need 3–5 on-screen lines of at most 8 words (${n} lines${long.length ? `, ${long.length} too long` : ''}).`),
    );
  } else if (o.format === 'photo_dump') {
    const n = primary.length;
    const long = primary.slice(1).filter((l) => wordCount(l) > PHOTO_DUMP.captionWords);
    checks.push(
      n >= PHOTO_DUMP.min && n <= PHOTO_DUMP.max && !long.length
        ? ok('length', 'major', `${n} photos.`)
        : fail('length', 'major', `Photo dumps have ${PHOTO_DUMP.min}–${PHOTO_DUMP.max} photos with captions of at most ${PHOTO_DUMP.captionWords} words (${n}${long.length ? `, ${long.length} too long` : ''}).`),
    );
  } else if (shape === 'carousel') {
    const n = d.carousel?.length ?? 0;
    checks.push(n >= 6 && n <= 8 ? ok('length', 'major', `${n} slides.`) : fail('length', 'major', `Carousels have 6–8 slides (${n}).`));
  } else {
    const n = wordCount(d.onScreenText[0] ?? d.body);
    const max = o.format === 'text_note' ? TEXT_NOTE_WORDS : o.format === 'meme' ? MEME_WORDS : ON_SCREEN_WORDS.static;
    const what = o.format === 'text_note' ? 'The note' : o.format === 'meme' ? 'The meme line' : 'The image line';
    checks.push(n <= max ? ok('length', 'major', `${what} is ${n} words.`) : fail('length', 'major', `${what} is ${n} words (${max} max).`));
  }
  if (o.format === 'news_greenscreen') {
    const outlet = mentionsOutlet(all);
    checks.push(
      outlet
        ? fail('no_outlet', 'major', `Names a real news outlet (${outlet}): the News Desk card is our own, with the headline in our words.`)
        : ok('no_outlet', 'major', 'No real outlet named; the headline is in our own words.'),
    );
  }
  if (o.format === 'reply_comment') {
    checks.push(
      showsHandle(all)
        ? fail('handle_anonymised', 'major', "Shows a viewer's @handle: the comment overlay anonymises it and the script never names the commenter.")
        : ok('handle_anonymised', 'major', 'No viewer handle in the script.'),
    );
  }

  // CTA: every post has one, with the slot's keyword.
  const kw = o.expectedKeyword.toUpperCase();
  const ctaRe = new RegExp(`\\bcomment\\s+["“']?${kw}\\b`, 'i');
  const anyKw = ctaHost.match(/\b[Cc]omment\s+["“']?([A-Z]{2,12})\b/);
  checks.push(
    ctaRe.test(ctaHost)
      ? ok('cta', 'major', `Ends with "Comment ${kw}".`)
      : anyKw
        ? fail('cta_keyword', 'major', `CTA uses ${anyKw[1]}, the slot's keyword is ${kw}.`, 'last line')
        : fail('cta', 'major', `No CTA: end with "Comment ${kw} …".`, 'last line'),
  );
  checks.push(new RegExp(`\\b${kw}\\b`).test(d.caption) ? ok('caption_cta', 'minor', 'Caption repeats the keyword.') : fail('caption_cta', 'minor', `Caption should repeat the keyword ${kw}.`));

  // No repeated lines.
  const seen = new Map<string, number>();
  const repeats: string[] = [];
  for (const s of primary.map((x) => x.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim()).filter(Boolean)) {
    seen.set(s, (seen.get(s) ?? 0) + 1);
    if (seen.get(s) === 2) repeats.push(s);
  }
  checks.push(repeats.length ? fail('repeated_lines', 'major', `Repeated line: "${repeats[0]}".`) : ok('repeated_lines', 'major', 'No repeated lines.'));

  // TTS pronunciation: rewritten here (fixing text is free), residual risks fail.
  let voiceover: string | null = null;
  let ttsRisks: TtsRisk[] = [];
  if (SPOKEN.includes(o.format)) {
    const n = ttsNormalize(d.body, { keep: [kw] });
    voiceover = n.text;
    ttsRisks = n.risks;
    const residual = residualTtsRisks(n.text);
    checks.push(
      residual.length
        ? fail('tts_pronunciation', 'major', `TTS would stumble on: ${residual.join(' ')}`)
        : ok('tts_pronunciation', 'minor', ttsRisks.length ? `Rewrote ${ttsRisks.length} for the voice: ${ttsRisks.slice(0, 4).map((r) => `${r.token} → ${r.spoken}`).join('; ')}` : 'Nothing TTS would mispronounce.'),
    );
  }

  // Claims needing citations.
  const uncited = uncitedClaims(all, d.claims, o.evidenceIds);
  checks.push(
    uncited.length
      ? fail('claims_cited', 'major', `Factual claim without a cited source: "${uncited[0]}"${uncited.length > 1 ? ` (+${uncited.length - 1})` : ''}.`)
      : ok('claims_cited', 'major', d.claims.length ? `${d.claims.length} claim(s), each cited.` : 'No factual claims (opinion / general education).'),
  );

  // Persona voice.
  const avoid = o.ctx.voice.avoid.filter((w) => w && all.toLowerCase().includes(w.toLowerCase()));
  checks.push(avoid.length ? fail('persona_voice', 'major', `Off-voice words: ${avoid.join(', ')}.`) : ok('persona_voice', 'major', 'In voice.'));

  // Spelling and typos.
  const typos = tokens.filter((t) => MISSPELLINGS[t]).map((t) => `${t} → ${MISSPELLINGS[t]}`);
  const doubled = all.match(/\b(\w+)\s+\1\b/i);
  checks.push(
    typos.length || doubled
      ? fail('spelling', 'minor', [typos.length ? `Typos: ${[...new Set(typos)].join(', ')}` : '', doubled ? `Doubled word "${doubled[1]}"` : ''].filter(Boolean).join('; '))
      : ok('spelling', 'minor', 'No typos found.'),
  );

  // Caption and hashtags.
  const capLen = d.caption.length;
  checks.push(capLen > 0 && capLen <= 2200 ? ok('caption', 'minor', `${capLen} characters.`) : fail('caption', capLen ? 'minor' : 'major', capLen ? 'Caption over 2,200 characters.' : 'Missing caption.'));
  checks.push(
    d.hashtags.length >= 3 && d.hashtags.length <= 5 ? ok('hashtags', 'minor', `${d.hashtags.length} hashtags.`) : fail('hashtags', 'minor', `${d.hashtags.length} hashtags (use 3–5).`),
  );

  // Visual brief: never ask for a real person or a "real" look.
  const asksReal = sentences(d.visualBrief).some(
    (s) => !/^(?:no|never|avoid|without|don'?t)\b/i.test(s) && /\b(?:a real (?:person|people)|real people|photo of a real|celebrity|lookalike|looks? like [A-Z][a-z]+ [A-Z])/i.test(s),
  );
  checks.push(
    asksReal
      ? fail('visual_brief', 'major', 'The visual brief asks for a real person or lookalike.')
      : ok('visual_brief', 'minor', d.visualBrief ? 'Visual brief set.' : 'Default visual brief.'),
  );

  checks.push(...motionChecks(d.visualBrief));

  return { pass: qcPass(checks), score: qcScore(checks), checks, voiceover, ttsRisks, wordCount: words, estSeconds };
}

/** Writes a qc_report and mirrors each failed check as a qc_defect. */
export async function saveQcReport(
  services: StudioServices,
  r: { personaId: string; subjectType: 'script' | 'asset' | 'post' | 'product' | 'story_frame'; subjectId: string; stage: 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'QP'; pass: boolean; score: number; checks: readonly QcCheck[]; extra?: Record<string, unknown> },
): Promise<string> {
  return services.db.transaction(async (tx) => {
    const row = await tx.one<{ id: string }>(
      `INSERT INTO qc_report (persona_id, subject_type, subject_id, stage, score, pass, details) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING id`,
      [r.personaId, r.subjectType, r.subjectId, r.stage, r.score, r.pass, json({ checks: r.checks, ...(r.extra ?? {}) })],
    );
    for (const c of r.checks.filter((x) => !x.pass)) {
      await tx.query(
        `INSERT INTO qc_defect (qc_report_id, persona_id, type, severity, location, fix_action) VALUES ($1, $2, $3, $4, $5, $6)`,
        [row.id, r.personaId, c.check, c.severity, c.location ?? null, c.message.slice(0, 500)],
      );
    }
    return row.id;
  });
}

// ─────────────────────────────── Q2 voice ───────────────────────────────

const STOP = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'so', 'to', 'of', 'in', 'on', 'at', 'for', 'is', 'it', 'its', 'this', 'that', 'you', 'your', 'i', 'im',
  'we', 'be', 'are', 'was', 'with', 'as', 'by', 'if', 'then', 'do', 'dont', 'just', 'up', 'out', 'my', 'me', 'all', 'one', 'can', 'will', 'have',
]);

/** Lower-case word tokens for diffing (numbers spoken, punctuation and apostrophes dropped). */
export function diffTokens(text: string): string[] {
  return ttsNormalize(text)
    .text.toLowerCase()
    .replace(/[-–—]/g, ' ')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

export type AlignOp = { op: 'ok' | 'sub' | 'del' | 'ins'; ref?: string; hyp?: string; refIndex?: number; hypIndex?: number };

/** Word-level Levenshtein alignment of what should have been said (ref) against what was heard (hyp). */
export function alignWords(ref: readonly string[], hyp: readonly string[]): AlignOp[] {
  const n = ref.length;
  const m = hyp.length;
  const d: number[][] = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
  const ops: AlignOp[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i]![j] === d[i - 1]![j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) {
      ops.push({ op: ref[i - 1] === hyp[j - 1] ? 'ok' : 'sub', ref: ref[i - 1], hyp: hyp[j - 1], refIndex: i - 1, hypIndex: j - 1 });
      i -= 1;
      j -= 1;
    } else if (i > 0 && d[i]![j] === d[i - 1]![j]! + 1) {
      ops.push({ op: 'del', ref: ref[i - 1], refIndex: i - 1 });
      i -= 1;
    } else {
      ops.push({ op: 'ins', hyp: hyp[j - 1], hypIndex: j - 1 });
      j -= 1;
    }
  }
  return ops.reverse();
}

const ts = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

export interface VoiceCheck extends QcResult {
  readonly wer: number;
  readonly wpm: number;
  readonly transcript: string;
  readonly misheard: ReadonlyArray<{ expected: string; heard: string | null; atS: number | null }>;
  readonly durationS: number;
}

/**
 * Q2 (pure part): diff the transcript against the script. Word-error rate ≤ 8%; any misheard content word or key
 * term (CTA keyword, names) is a major; a cut-off ending or the wrong voice is a blocker; pace and long pauses.
 */
export function gradeVoice(
  expectedText: string,
  heard: { text: string; words: readonly TranscriptWord[]; durationS: number },
  o: { keyTerms?: readonly string[]; expectedVoiceId?: string | null; voiceId?: string | null; werThreshold?: number } = {},
): VoiceCheck {
  const ref = diffTokens(expectedText);
  const hypWords = heard.words.length ? heard.words : diffTokens(heard.text).map((w) => ({ word: w, startS: 0, endS: 0 }));
  const hyp = hypWords.flatMap((w) => diffTokens(w.word));
  // Timestamps per hyp token (a heard "word" can split into several tokens).
  const times: number[] = hypWords.flatMap((w) => diffTokens(w.word).map(() => w.startS));
  const ops = alignWords(ref, hyp);
  const errors = ops.filter((x) => x.op !== 'ok').length;
  const wer = ref.length ? Math.round((errors / ref.length) * 1000) / 1000 : hyp.length ? 1 : 0;
  const key = new Set((o.keyTerms ?? []).flatMap((k) => diffTokens(k)));
  const misheard = ops
    .filter((x) => x.op === 'sub' || x.op === 'del')
    .map((x) => ({ expected: x.ref!, heard: x.op === 'sub' ? x.hyp! : null, atS: x.hypIndex !== undefined ? (times[x.hypIndex] ?? null) : null }));
  const important = misheard.filter((m) => key.has(m.expected) || (m.expected.length >= 4 && !STOP.has(m.expected)));
  const checks: QcCheck[] = [];
  const threshold = o.werThreshold ?? 0.08;

  checks.push(
    wer <= threshold
      ? ok('transcript_match', 'major', `Word-error rate ${(wer * 100).toFixed(1)}%.`)
      : fail('transcript_match', wer > 0.25 ? 'blocker' : 'major', `Word-error rate ${(wer * 100).toFixed(1)}% (max ${threshold * 100}%).`),
  );
  checks.push(
    important.length
      ? fail(
          'mispronunciation',
          'major',
          `Misheard: ${important.slice(0, 4).map((m) => `"${m.expected}" → ${m.heard ? `"${m.heard}"` : 'missing'}`).join(', ')}. Regenerate the TTS line.`,
          important[0]!.atS !== null ? ts(important[0]!.atS) : undefined,
        )
      : misheard.length
        ? fail('mispronunciation', 'minor', `Minor differences: ${misheard.slice(0, 3).map((m) => `"${m.expected}" → ${m.heard ?? 'missing'}`).join(', ')}.`)
        : ok('mispronunciation', 'major', 'Every word heard as written.'),
  );
  const tail = ops.slice(-2);
  const cut = ref.length >= 3 && tail.length === 2 && tail.every((x) => x.op === 'del');
  checks.push(cut ? fail('cut_off', 'blocker', `The ending is cut off ("${ref.slice(-3).join(' ')}").`, 'end') : ok('cut_off', 'blocker', 'Nothing cut off at the end.'));

  const dur = heard.durationS || (hypWords.at(-1)?.endS ?? 0);
  const wpm = dur > 0 ? Math.round((hyp.length / dur) * 60) : 0;
  checks.push(
    wpm >= 130 && wpm <= 190
      ? ok('pace', 'minor', `${wpm} wpm.`)
      : fail('pace', wpm < 110 || wpm > 210 ? 'major' : 'minor', `${wpm} wpm (target 130–190).`),
  );
  const pauses: string[] = [];
  for (let k = 1; k < hypWords.length; k++) {
    const gap = hypWords[k]!.startS - hypWords[k - 1]!.endS;
    if (gap > 0.7) pauses.push(`${ts(hypWords[k - 1]!.endS)} (${gap.toFixed(1)} s)`);
  }
  checks.push(pauses.length ? fail('long_pauses', 'minor', `Pauses over 0.7 s at ${pauses.slice(0, 3).join(', ')}.`) : ok('long_pauses', 'minor', 'No long pauses.'));
  if (o.expectedVoiceId && o.voiceId) {
    checks.push(
      o.expectedVoiceId === o.voiceId ? ok('voice_id', 'blocker', 'Persona voice.') : fail('voice_id', 'blocker', `Wrong voice: ${o.voiceId} (expected ${o.expectedVoiceId}).`),
    );
  }
  return { pass: qcPass(checks), score: Math.round((1 - Math.min(1, wer)) * 100), checks, wer, wpm, transcript: heard.text, misheard, durationS: dur };
}

/**
 * Q2: re-transcribe the voice track through the TranscribeProvider (Whisper-style; metered as media_usd) and grade
 * it against the script. Saves a qc_report (stage Q2) on the script, or on the asset when `assetId` is given.
 */
export async function voiceCheck(
  services: StudioServices,
  args: {
    studioId: string;
    personaId: string;
    scriptId: string;
    audioUrl: string;
    expectedText?: string;
    assetId?: string;
    voiceId?: string | null;
    expectedVoiceId?: string | null;
    keyTerms?: readonly string[];
    costRef?: CostRef;
  },
): Promise<VoiceCheck & { reportId: string }> {
  const script = await services.db.one<{ voiceover: string | null; body: string; cta_keyword: string | null; slot_id: string | null }>(
    'SELECT voiceover, body, cta_keyword, slot_id FROM script WHERE id = $1 AND persona_id = $2',
    [args.scriptId, args.personaId],
  );
  const expected = args.expectedText ?? script.voiceover ?? script.body;
  const persona = await services.db.one<{ name: string }>('SELECT name FROM persona WHERE id = $1', [args.personaId]);
  const estimate = Math.max(0.001, ((wordCount(expected) / 150) * 60 * 0.006) / 60) * 2;
  const heard = await metered(
    services.db,
    { studioId: args.studioId, personaId: args.personaId, agent: 'quality-control', ref: args.costRef ?? (script.slot_id ? { type: 'calendar_slot', id: script.slot_id } : undefined) },
    { unit: 'media_usd', estimate, provider: services.providers.transcribe.name, operation: 'transcribe' },
    () => services.providers.transcribe.transcribe({ audioUrl: args.audioUrl, language: 'en', prompt: [script.cta_keyword, persona.name].filter(Boolean).join(', ') }),
    (r) => r.costUsd,
  );
  const graded = gradeVoice(expected, heard, {
    keyTerms: [...(args.keyTerms ?? []), script.cta_keyword ?? '', persona.name].filter(Boolean),
    voiceId: args.voiceId,
    expectedVoiceId: args.expectedVoiceId,
  });
  const reportId = await saveQcReport(services, {
    personaId: args.personaId,
    subjectType: args.assetId ? 'asset' : 'script',
    subjectId: args.assetId ?? args.scriptId,
    stage: 'Q2',
    pass: graded.pass,
    score: graded.score,
    checks: graded.checks,
    extra: { wer: graded.wer, wpm: graded.wpm, transcript: graded.transcript.slice(0, 4000), misheard: graded.misheard.slice(0, 20), audio_url: args.audioUrl, script_id: args.scriptId },
  });
  return { ...graded, reportId };
}
