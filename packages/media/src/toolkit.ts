import type { PersonaKit } from '@ios/agents';
import { EXPORT, SAFE_ZONE } from './config';

/**
 * Local media tooling behind one interface (docs/IOS-34-CONTRACTS.md §5.3: FFmpeg, OCR and face embeddings stay inside
 * the owning package, each with a fake). `FfmpegToolkit` runs the pinned static FFmpeg build on the Mac worker;
 * `FakeToolkit` writes small JSON stand-ins so every format renders end to end in tests without binaries.
 */

export interface Interval {
  readonly start: number;
  readonly end: number;
}

/** The persona's colour grade: FFmpeg `eq` + `colorbalance` midtones (and the same values for stills via sharp). */
export interface ColorGrade {
  readonly brightness: number;
  readonly contrast: number;
  readonly saturation: number;
  readonly gamma: number;
  /** colorbalance midtone shifts, −0.1…0.1. */
  readonly rm: number;
  readonly gm: number;
  readonly bm: number;
  /** The accent the grade leans toward (for the dashboard swatch). */
  readonly accent: string;
}

export const NEUTRAL_GRADE: ColorGrade = { brightness: 0, contrast: 1, saturation: 1, gamma: 1, rm: 0, gm: 0, bm: 0, accent: '#808080' };

const hexRgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];

/** A gentle grade leaning toward the persona's accent colour: a signature look without changing skin tones much. */
export function gradeFromKit(kit: Pick<PersonaKit, 'colors'>): ColorGrade {
  const [r, g, b] = hexRgb(kit.colors.accent);
  const mean = (r + g + b) / 3;
  const shift = (c: number) => Math.round(Math.max(-0.06, Math.min(0.06, (c - mean) * 0.12)) * 1000) / 1000;
  const [br, bg, bb] = hexRgb(kit.colors.bg);
  const warmBg = br + bg / 2 > bb * 1.5;
  return { brightness: 0.01, contrast: 1.06, saturation: warmBg ? 1.04 : 1.0, gamma: 1, rm: shift(r), gm: shift(g), bm: shift(b), accent: kit.colors.accent };
}

/** (IOS-5) 'sticker': a viewer comment on a white sticker (reply posts); 'note': the centred text of a note card. */
export type TextStyle = 'caption' | 'headline' | 'cta' | 'sticker' | 'note';

/** A burned-in text block at a fixed place on the frame. */
export interface TextBox {
  readonly text: string;
  readonly startS: number;
  readonly endS: number;
  readonly style: TextStyle;
  readonly fontSize: number;
  readonly box: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
}

export interface Segment {
  /** Local file. */
  readonly file: string;
  readonly kind: 'video' | 'image';
  /** Timeline position. */
  readonly startS: number;
  readonly durationS: number;
  /** In-point inside the source. */
  readonly offsetS?: number;
  /** Slow push-in on stills. */
  readonly motion?: 'push' | 'none';
  /**
   * How the source fills the frame: 'cover' (default) scales up and crops; 'contain' fits it whole and pads with
   * `padColor` (#RRGGBB), so a 4:5 slide keeps its text inside a 9:16 video.
   */
  readonly fit?: 'cover' | 'contain';
  readonly padColor?: string;
  /** What the segment is (state key), so Q4 can map a defect back to the clip that caused it. */
  readonly ref?: string;
}

export interface VideoComposition {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly durationS: number;
  /** Visual track, back to back. */
  readonly segments: readonly Segment[];
  readonly audio: { readonly file: string } | null;
  readonly texts: readonly TextBox[];
  /**
   * (IOS-5) Picture-in-picture: a second track (the persona's talking clips) scaled into `box` over the main track
   * (screen slides or a News Desk card). Segments are timed on the same timeline.
   */
  readonly pip?: { readonly segments: readonly Segment[]; readonly box: { readonly x: number; readonly y: number; readonly w: number; readonly h: number } } | null;
  readonly grade: ColorGrade;
  readonly sharpen: boolean;
  /** 'single' at render; Q4's re-normalise fix runs the two-pass `normalizeAudio`. */
  readonly loudnorm: 'single' | 'none';
  /** Container metadata (AI-generated marker). */
  readonly metadata: Readonly<Record<string, string>>;
}

export interface CardSpec {
  readonly width: number;
  readonly height: number;
  readonly background: string | null;
  readonly colors: { readonly bg: string; readonly ink: string; readonly accent: string };
  /** (IOS-5) 'note' text card, 'meme' (band above a photo), 'news' (News Desk card), 'screen' (slide backdrop), 'photo' (photo-dump still). */
  readonly layout: 'static' | 'cover' | 'slide' | 'cta' | 'note' | 'meme' | 'news' | 'screen' | 'photo';
  /** (IOS-5) A label the layout draws (the News Desk banner). Never a real outlet's name. */
  readonly banner?: string;
  readonly title: string;
  readonly body?: string;
  readonly footer?: string;
  readonly index?: number;
  readonly total?: number;
  readonly grade: ColorGrade;
  readonly sharpen: boolean;
  /** Text boxes the card draws (also what Q4's OCR expects). */
  readonly texts: readonly TextBox[];
}

export interface MediaInfo {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly durationS: number;
  readonly hasAudio: boolean;
  readonly hasVideo: boolean;
}

export interface Analysis {
  readonly info: MediaInfo;
  /** EBU R128 integrated loudness (LUFS) and true peak (dBTP); null without audio. */
  readonly loudness: { readonly integrated: number; readonly truePeak: number; readonly lra: number } | null;
  readonly silences: readonly Interval[];
  readonly blacks: readonly Interval[];
  readonly freezes: readonly Interval[];
}

export interface MediaToolkit {
  readonly name: string;
  /** Downloads a provider result (https) to a local file. */
  fetch(url: string, dest: string, hint: { kind: 'image' | 'video' | 'audio'; durationS?: number }): Promise<void>;
  probe(file: string): Promise<MediaInfo>;
  renderVideo(comp: VideoComposition, out: string): Promise<MediaInfo>;
  renderCard(spec: CardSpec, out: string): Promise<MediaInfo>;
  analyze(file: string, opts: { audio: boolean }): Promise<Analysis>;
  /** One frame as an image at `outBase` + the toolkit's extension; returns the path and content type. */
  frame(file: string, atS: number, outBase: string): Promise<{ path: string; contentType: string }>;
  cutAudio(file: string, startS: number, endS: number, out: string): Promise<void>;
  /** Two-pass loudnorm to −14 LUFS / −1.5 dBTP, video stream copied. */
  normalizeAudio(file: string, out: string): Promise<void>;
}

/** OCR on frames (Q4 caption check, carousel/static spelling). */
export interface OcrProvider {
  readonly name: string;
  read(imagePath: string): Promise<{ text: string; confidence: number }>;
}

/** Face similarity against the persona's reference (Q3). */
export interface FaceMatcher {
  readonly name: string;
  compare(referencePath: string, imagePath: string): Promise<{ faces: number; similarity: number | null }>;
}

// ───────────────────────────── Layout: captions and on-screen text inside the safe zones ─────────────────────────────

const CHAR_W = 0.56;

/** Box for a text block: centred horizontally inside the safe zone, wrapped to the safe width. */
export function textBox(text: string, style: TextStyle, frame: { width: number; height: number }, scale = 1): TextBox['box'] & { fontSize: number } {
  const base = style === 'caption' ? 62 : style === 'headline' ? 74 : style === 'sticker' ? 46 : style === 'note' ? 64 : 58;
  const fontSize = Math.round(base * scale * (frame.width / EXPORT.video.width));
  const sx = (frame.width / EXPORT.video.width) * SAFE_ZONE.left;
  const safeW = frame.width - sx - (frame.width / EXPORT.video.width) * SAFE_ZONE.right;
  const perLine = Math.max(8, Math.floor(safeW / (fontSize * CHAR_W)));
  const lines = wrap(text, perLine).length;
  const w = Math.min(safeW, Math.ceil(Math.min(text.length, perLine) * fontSize * CHAR_W) + fontSize);
  const h = Math.ceil(lines * fontSize * 1.25 + fontSize * 0.6);
  const scaleY = frame.height / EXPORT.video.height;
  const y =
    style === 'headline' || style === 'sticker'
      ? Math.round(SAFE_ZONE.top * scaleY + 30 * scaleY)
      : style === 'note'
        ? Math.round(frame.height * 0.45 - h / 2)
      : style === 'cta'
        ? Math.round(frame.height - SAFE_ZONE.bottom * scaleY - h - 20 * scaleY)
        : Math.round(frame.height * 0.6 - h / 2);
  const x = Math.round(sx + (safeW - w) / 2);
  return { x, y, w, h, fontSize };
}

export function wrap(text: string, perLine: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (cur && `${cur} ${w}`.length > perLine) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  return lines;
}

export function placeText(text: string, style: TextStyle, startS: number, endS: number, frame: { width: number; height: number } = EXPORT.video, scale = 1): TextBox {
  const { fontSize, ...box } = textBox(text, style, frame, scale);
  return { text, startS, endS, style, fontSize, box };
}

/** Is every text box inside the platform safe zone? */
export function insideSafeZone(t: TextBox, frame: { width: number; height: number } = EXPORT.video): boolean {
  const kx = frame.width / EXPORT.video.width;
  const ky = frame.height / EXPORT.video.height;
  return (
    t.box.x >= SAFE_ZONE.left * kx - 1 &&
    t.box.x + t.box.w <= frame.width - SAFE_ZONE.right * kx + 1 &&
    t.box.y >= SAFE_ZONE.top * ky - 1 &&
    t.box.y + t.box.h <= frame.height - SAFE_ZONE.bottom * ky + 1
  );
}

/**
 * Caption cues for a voice track: short chunks (≤ 4 words, ≤ 26 characters) timed in proportion to their length
 * over the track, leaving a small lead-in. Q4 OCRs each cue and compares it with the transcript.
 */
export function captionCues(text: string, durationS: number, opts: { leadS?: number; scale?: number; frame?: { width: number; height: number } } = {}): TextBox[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const chunks: string[] = [];
  let cur: string[] = [];
  for (const w of words) {
    if (cur.length && (cur.length >= 4 || `${cur.join(' ')} ${w}`.length > 26 || /[.!?]$/.test(cur.at(-1)!))) {
      chunks.push(cur.join(' '));
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) chunks.push(cur.join(' '));
  const lead = opts.leadS ?? 0.1;
  const span = Math.max(0.5, durationS - lead - 0.1);
  const total = chunks.reduce((a, c) => a + c.length + 2, 0) || 1;
  let t = lead;
  return chunks.map((c) => {
    const d = (span * (c.length + 2)) / total;
    const cue = placeText(c, 'caption', round2(t), round2(t + d), opts.frame, opts.scale);
    t += d;
    return cue;
  });
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** Splits spoken text into ≤ maxS parts at sentence ends, by words-per-second (talking clips are ≤ 15 s). */
export function splitSpeech(text: string, durationS: number, maxS: number): Array<{ text: string; startS: number; endS: number }> {
  const parts = Math.max(1, Math.ceil(durationS / maxS - 1e-9));
  const sentences = text.match(/[^.!?]+[.!?]*/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
  const totalWords = text.split(/\s+/).filter(Boolean).length || 1;
  const perWord = durationS / totalWords;
  const groups: string[][] = Array.from({ length: parts }, () => []);
  let wordsSoFar = 0;
  for (const s of sentences) {
    const n = s.split(/\s+/).filter(Boolean).length;
    const mid = (wordsSoFar + n / 2) * perWord;
    groups[Math.min(parts - 1, Math.floor(mid / (durationS / parts)))]!.push(s);
    wordsSoFar += n;
  }
  const out: Array<{ text: string; startS: number; endS: number }> = [];
  let t = 0;
  for (const g of groups.filter((x) => x.length)) {
    const n = g.join(' ').split(/\s+/).length;
    const d = n * perWord;
    out.push({ text: g.join(' '), startS: round2(t), endS: round2(Math.min(durationS, t + d)) });
    t += d;
  }
  // A single long sentence can still exceed the cap: cut evenly by time instead, each part carrying its share of the
  // words (every talking prompt states its line, accent and pace).
  if (out.some((p) => p.endS - p.startS > maxS + 0.01)) {
    const d = durationS / parts;
    const all = text.split(/\s+/).filter(Boolean);
    const per = Math.ceil(all.length / parts);
    return Array.from({ length: parts }, (_, i) => ({ text: all.slice(i * per, (i + 1) * per).join(' '), startS: round2(i * d), endS: round2(Math.min(durationS, (i + 1) * d)) }));
  }
  return out;
}
