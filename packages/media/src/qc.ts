import type { QcCheck } from '@troupe/agents';
import { alignWords, diffTokens, MEME_WORDS, mentionsOutlet, qcPass, qcScore, showsHandle, TEXT_NOTE_WORDS } from '@troupe/content';
import type { PostFormat } from '@troupe/core';
import { FORMAT_SPEC, formatFrame, Q3_TARGETS, Q4_TARGETS, SAFE_ZONE, SLIDE_RANGE } from './config';
import { type Analysis, insideSafeZone, type Interval, type MediaInfo, type TextBox } from './toolkit';

/**
 * QC Q3 (avatar) and Q4 (final) graders (PRD §3.6, FR-21). Pure: the render job measures (FFmpeg, OCR, face
 * similarity), these decide. Each failing check names the maker's fix, so the auto-fix loop (≤ 2) knows what to redo:
 * re-normalise audio, re-time/re-size captions, regenerate a clip, re-voice, or re-render.
 */

const ok = (check: string, severity: QcCheck['severity'], message: string, location?: string): QcCheck => ({ check, pass: true, severity, message, ...(location ? { location } : {}) });
const fail = (check: string, severity: QcCheck['severity'], message: string, location?: string): QcCheck => ({ check, pass: false, severity, message, ...(location ? { location } : {}) });

export const ts = (s: number): string => `${Math.floor(s / 60)}:${(Math.max(0, s) % 60).toFixed(1).padStart(4, '0')}`;
const span = (iv: Interval) => `${ts(iv.start)}–${Number.isFinite(iv.end) ? ts(iv.end) : 'end'}`;
const len = (iv: Interval) => (Number.isFinite(iv.end) ? iv.end - iv.start : Number.POSITIVE_INFINITY);

// ───────────────────────────── Q3 avatar ─────────────────────────────

export interface Q3Clip {
  readonly ref: string;
  readonly samples: ReadonlyArray<{ atS: number; faces: number; similarity: number | null }>;
  readonly freezes: readonly Interval[];
}

export interface Q3Result {
  readonly pass: boolean;
  readonly score: number;
  readonly checks: QcCheck[];
  /** Clips to regenerate. */
  readonly redo: string[];
}

export function gradeQ3(clips: readonly Q3Clip[], o: { faceMin?: number; hasReference: boolean }): Q3Result {
  const min = o.faceMin ?? Q3_TARGETS.faceMin;
  const checks: QcCheck[] = [];
  const redo = new Set<string>();
  for (const c of clips) {
    const sims = c.samples.map((s) => s.similarity).filter((x): x is number => x !== null);
    const worst = sims.length ? Math.min(...sims) : null;
    if (!o.hasReference) checks.push(ok('face_similarity', 'minor', `${c.ref}: no face reference yet, similarity not measured`));
    else if (worst === null) {
      checks.push(fail('face_similarity', 'blocker', `${c.ref}: no face found to compare with the persona reference`, ts(c.samples[0]?.atS ?? 0)));
      redo.add(c.ref);
    } else if (worst < min) {
      const at = c.samples.find((s) => s.similarity === worst)!;
      checks.push(fail('face_similarity', 'blocker', `${c.ref}: face drifted from the persona (similarity ${worst.toFixed(2)} < ${min})`, ts(at.atS)));
      redo.add(c.ref);
    } else checks.push(ok('face_similarity', 'blocker', `${c.ref}: same face as the reference (min similarity ${worst.toFixed(2)})`));

    const bad = c.samples.find((s) => s.faces !== 1);
    if (bad) {
      checks.push(fail('artefacts', 'major', `${c.ref}: ${bad.faces === 0 ? 'face missing' : `${bad.faces} faces`} in frame (one person only)`, ts(bad.atS)));
      redo.add(c.ref);
    } else checks.push(ok('artefacts', 'major', `${c.ref}: one clear face in every sampled frame`));

    const frozen = c.freezes.filter((f) => len(f) > Q3_TARGETS.freezeMaxS);
    if (frozen.length) {
      checks.push(fail('frozen_frames', 'major', `${c.ref}: frozen for ${frozen.map(span).join(', ')}`, ts(frozen[0]!.start)));
      redo.add(c.ref);
    } else checks.push(ok('frozen_frames', 'major', `${c.ref}: no frozen frames`));
  }
  return { pass: qcPass(checks), score: qcScore(checks), checks, redo: [...redo] };
}

// ───────────────────────────── Q4 final ─────────────────────────────

export type Q4Fix =
  | { kind: 'normalize_audio' }
  | { kind: 'captions' }
  | { kind: 'regenerate'; refs: string[] }
  | { kind: 'revoice' }
  | { kind: 'rerender' };

export interface OcrSample {
  readonly atS: number;
  readonly expected: string;
  readonly read: string;
  /** Slide number for carousels. */
  readonly slide?: number;
}

/** Share of the expected words OCR read back, in order (word alignment). */
export function ocrMatch(expected: string, read: string): number {
  const ref = diffTokens(expected);
  if (!ref.length) return 1;
  const ops = alignWords(ref, diffTokens(read));
  return ops.filter((o) => o.op === 'ok').length / ref.length;
}

export interface Q4Input {
  readonly format: PostFormat;
  readonly voiced: boolean;
  /** The main file (video or image); for carousels, the first slide. */
  readonly info: MediaInfo;
  readonly analysis: Analysis | null;
  readonly slides?: readonly MediaInfo[];
  readonly texts: readonly TextBox[];
  readonly ocr: readonly OcrSample[];
  /** Timeline segments (to map a frozen/black span back to its clip). */
  readonly segments?: ReadonlyArray<{ ref?: string; startS: number; durationS: number }>;
  readonly coverOk: boolean;
  readonly aiFlag: boolean;
  readonly ctaKeyword: string;
  readonly caption: string;
  readonly hashtags: readonly string[];
  /** (IOS-5) The picture-in-picture box (facecam over screen, News Desk green-screen). */
  readonly pip?: { readonly x: number; readonly y: number; readonly w: number; readonly h: number } | null;
  /** (IOS-5) Text a card layout draws outside `texts` (the News Desk banner). */
  readonly chromeText?: readonly string[];
}

export interface Q4Result {
  readonly pass: boolean;
  readonly score: number;
  readonly checks: QcCheck[];
  readonly fixes: Q4Fix[];
}

const overlaps = (iv: Interval, s: { startS: number; durationS: number }) => iv.start < s.startS + s.durationS && (Number.isFinite(iv.end) ? iv.end : 1e9) > s.startS;

export function gradeQ4(i: Q4Input): Q4Result {
  const checks: QcCheck[] = [];
  const fixes: Q4Fix[] = [];
  const spec = FORMAT_SPEC[i.format];
  const frame = formatFrame(i.format);
  const range = SLIDE_RANGE[i.format];

  // Visuals: size, fps, duration.
  const sizes = spec.kind === 'carousel' ? (i.slides ?? []) : [i.info];
  const wrongSize = sizes.find((s) => s.width !== frame.width || s.height !== frame.height);
  if (wrongSize) {
    checks.push(fail('resolution', 'blocker', `${wrongSize.width}×${wrongSize.height}, expected ${frame.width}×${frame.height}`));
    fixes.push({ kind: 'rerender' });
  } else checks.push(ok('resolution', 'blocker', `${frame.width}×${frame.height}`));
  if (spec.kind === 'video') {
    if (Math.abs(i.info.fps - Q4_TARGETS.fps) > 0.5) {
      checks.push(fail('fps', 'major', `${i.info.fps} fps, expected ${Q4_TARGETS.fps}`));
      fixes.push({ kind: 'rerender' });
    } else checks.push(ok('fps', 'major', `${Q4_TARGETS.fps} fps`));
    if (i.info.durationS < spec.minS - 0.25 || i.info.durationS > spec.maxS + 0.25) {
      checks.push(fail('duration', 'major', `${i.info.durationS.toFixed(1)} s, expected ${spec.minS}–${spec.maxS} s`));
      fixes.push({ kind: 'rerender' });
    } else checks.push(ok('duration', 'major', `${i.info.durationS.toFixed(1)} s`));
  }
  if (range) {
    const n = i.slides?.length ?? 0;
    if (n < range.min || n > range.max) checks.push(fail('slide_count', 'blocker', `${n} slides, expected ${range.min}–${range.max}`));
    else checks.push(ok('slide_count', 'blocker', `${n} slides`));
  }

  // (IOS-5) Format-library expectations.
  const shown = [...i.texts.map((t) => t.text), ...(i.chromeText ?? [])].join('\n');
  if (i.format === 'reply_comment') {
    const sticker = i.texts.find((t) => t.style === 'sticker');
    checks.push(sticker ? ok('comment_overlay', 'major', 'The comment is shown as a sticker overlay') : fail('comment_overlay', 'major', 'No comment sticker on the reply'));
    checks.push(showsHandle(shown) ? fail('handle_anonymised', 'blocker', "A viewer's @handle is visible: the overlay must anonymise it") : ok('handle_anonymised', 'blocker', "The commenter's handle is anonymised"));
  }
  if (i.format === 'news_greenscreen') {
    const outlet = mentionsOutlet(shown);
    checks.push(outlet ? fail('no_outlet_logo', 'blocker', `The card names a real outlet (${outlet}): the News Desk is our own`) : ok('no_outlet_logo', 'blocker', 'Our own News Desk card, no real outlet name or logo'));
  }
  if (i.pip !== undefined && (i.format === 'facecam_screen' || i.format === 'news_greenscreen')) {
    const b = i.pip;
    const inside = !!b && b.x >= SAFE_ZONE.left && b.x + b.w <= frame.width - SAFE_ZONE.right && b.y >= SAFE_ZONE.top && b.y + b.h <= frame.height - SAFE_ZONE.bottom;
    checks.push(inside ? ok('pip_safe_zone', 'major', 'The persona box sits inside the safe zone') : fail('pip_safe_zone', 'major', b ? 'The persona box crosses the platform safe zone' : 'No persona box on a facecam / green-screen post'));
    if (!b) fixes.push({ kind: 'rerender' });
  }
  if (i.format === 'text_note' || i.format === 'meme') {
    const max = i.format === 'text_note' ? TEXT_NOTE_WORDS : MEME_WORDS;
    const n = (i.texts[0]?.text ?? '').split(/\s+/).filter(Boolean).length;
    checks.push(n > 0 && n <= max ? ok('text_length', 'major', `${n} words on the card`) : fail('text_length', 'major', `${n} words on the card (1–${max})`));
  }

  // Audio (voiced reels): loudness, true peak, silences.
  const a = i.analysis;
  if (spec.kind === 'video' && i.voiced && a) {
    if (!a.loudness) {
      checks.push(fail('loudness', 'blocker', 'no audio track'));
      fixes.push({ kind: 'rerender' });
    } else {
      const off = Math.abs(a.loudness.integrated - Q4_TARGETS.lufs);
      if (off > Q4_TARGETS.lufsTolerance) {
        checks.push(fail('loudness', 'major', `${a.loudness.integrated.toFixed(1)} LUFS integrated, target ${Q4_TARGETS.lufs} ±${Q4_TARGETS.lufsTolerance}`));
        fixes.push({ kind: 'normalize_audio' });
      } else checks.push(ok('loudness', 'major', `${a.loudness.integrated.toFixed(1)} LUFS integrated`));
      if (a.loudness.truePeak > Q4_TARGETS.truePeakMax) {
        checks.push(fail('true_peak', 'major', `true peak ${a.loudness.truePeak.toFixed(1)} dBTP, max ${Q4_TARGETS.truePeakMax}`));
        if (!fixes.some((f) => f.kind === 'normalize_audio')) fixes.push({ kind: 'normalize_audio' });
      } else checks.push(ok('true_peak', 'major', `true peak ${a.loudness.truePeak.toFixed(1)} dBTP`));
    }
    // Leading/trailing room is fine; a gap inside the speech is not.
    const gaps = a.silences.filter((s) => len(s) > Q4_TARGETS.silenceMaxS && s.start > 0.3 && s.end < i.info.durationS - 0.4);
    if (gaps.length) {
      checks.push(fail('silence', 'major', `unintended silence ${gaps.map(span).join(', ')} (> ${Q4_TARGETS.silenceMaxS} s)`, ts(gaps[0]!.start)));
      fixes.push({ kind: 'revoice' });
    } else checks.push(ok('silence', 'major', `no silence over ${Q4_TARGETS.silenceMaxS} s`));
  }

  // Black and frozen frames: regenerate the clip that caused them.
  if (spec.kind === 'video' && a) {
    for (const [name, list, maxS] of [
      ['black_frames', a.blacks, Q4_TARGETS.blackMaxS],
      ['frozen_frames', a.freezes, Q4_TARGETS.freezeMaxS],
    ] as const) {
      const bad = list.filter((x) => len(x) > maxS);
      if (bad.length) {
        checks.push(fail(name, 'blocker', `${name === 'black_frames' ? 'black' : 'frozen'} at ${bad.map(span).join(', ')}`, ts(bad[0]!.start)));
        const refs = [...new Set((i.segments ?? []).filter((s) => s.ref && bad.some((b) => overlaps(b, s))).map((s) => s.ref!))];
        fixes.push(refs.length ? { kind: 'regenerate', refs } : { kind: 'rerender' });
      } else checks.push(ok(name, 'blocker', `no ${name === 'black_frames' ? 'black' : 'frozen'} frames`));
    }
  }

  // Captions and on-screen text: inside the safe zones, and OCR reads back what the script says.
  const outside = i.texts.filter((t) => !insideSafeZone(t, frame));
  if (outside.length) {
    checks.push(fail('safe_zone', 'major', `${outside.length} text block(s) outside the platform safe zone`, `"${outside[0]!.text.slice(0, 40)}"`));
    fixes.push({ kind: 'captions' });
  } else checks.push(ok('safe_zone', 'major', `${i.texts.length} text block(s) inside the safe zone`));
  const misread = i.ocr.filter((s) => ocrMatch(s.expected, s.read) < Q4_TARGETS.ocrMinMatch);
  if (misread.length) {
    const m = misread[0]!;
    checks.push(
      fail('caption_ocr', 'major', `burned-in text doesn't match the script at ${misread.length} point(s): expected "${m.expected.slice(0, 50)}", read "${m.read.replace(/\s+/g, ' ').slice(0, 50)}"`, m.slide ? `slide ${m.slide}` : ts(m.atS)),
    );
    fixes.push({ kind: 'captions' });
  } else checks.push(ok('caption_ocr', 'major', `${i.ocr.length} text sample(s) read back as written`));

  // Metadata: AI flag, cover, CTA, caption and hashtags.
  checks.push(i.aiFlag ? ok('ai_flag', 'blocker', 'AI-generated flag set (every platform AI flag goes out true)') : fail('ai_flag', 'blocker', 'AI-generated flag missing'));
  if (!i.coverOk) {
    checks.push(fail('cover', 'major', 'no usable cover frame (black or missing)'));
    fixes.push({ kind: 'rerender' });
  } else checks.push(ok('cover', 'major', 'cover frame chosen'));
  const kw = i.ctaKeyword.toUpperCase();
  checks.push(kw && i.caption.toUpperCase().includes(kw) ? ok('cta', 'major', `caption carries the CTA keyword ${kw}`) : fail('cta', 'major', `caption is missing the CTA keyword ${kw}`));
  checks.push(i.caption.length <= 2200 ? ok('caption_length', 'minor', `${i.caption.length} characters`) : fail('caption_length', 'minor', `${i.caption.length} characters (max 2,200)`));
  checks.push(i.hashtags.length >= 1 && i.hashtags.length <= 5 ? ok('hashtags', 'minor', `${i.hashtags.length} hashtags`) : fail('hashtags', 'minor', `${i.hashtags.length} hashtags (use 1–5)`));

  const pass = qcPass(checks);
  return { pass, score: qcScore(checks), checks, fixes: pass ? [] : dedupeFixes(fixes) };
}

function dedupeFixes(fixes: Q4Fix[]): Q4Fix[] {
  const out: Q4Fix[] = [];
  const refs = new Set<string>();
  for (const f of fixes) {
    if (f.kind === 'regenerate') f.refs.forEach((r) => refs.add(r));
    else if (!out.some((o) => o.kind === f.kind)) out.push(f);
  }
  if (refs.size) out.push({ kind: 'regenerate', refs: [...refs] });
  return out;
}
