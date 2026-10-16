import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Analysis, CardSpec, FaceMatcher, Interval, MediaInfo, MediaToolkit, OcrProvider, TextBox, VideoComposition } from './toolkit';

/**
 * Deterministic stand-ins for FFmpeg, OCR and face embeddings. Each "media file" is a small JSON manifest describing
 * what a real render would contain (size, fps, duration, loudness, captions, frozen spans, the face on screen), so
 * every format renders, gets analysed and goes through Q3/Q4 without binaries. Frames are SVG thumbnails with the
 * manifest in a comment, which the dashboard can show as a real image.
 *
 * Tests inject defects: `onFetch` marks a provider result (e.g. a frozen or off-face talking clip) and `renders`
 * overrides the analysis of the next renders in order (e.g. `{ integrated: -19 }` for one quiet render).
 */

export interface FakeFace {
  readonly identity: string;
  readonly similarity: number;
}

export interface FakeManifest {
  readonly ios_fake: 1;
  readonly kind: 'image' | 'video' | 'audio';
  readonly url?: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly durationS: number;
  readonly hasAudio: boolean;
  readonly hasVideo: boolean;
  readonly loudness: Analysis['loudness'];
  readonly silences: readonly Interval[];
  readonly blacks: readonly Interval[];
  readonly freezes: readonly Interval[];
  readonly texts?: readonly TextBox[];
  readonly face?: FakeFace | null;
  /** Talking clips: faces per frame by time (the clip's face). */
  readonly segments?: ReadonlyArray<{ startS: number; durationS: number; face: FakeFace | null; ref?: string }>;
  /** OCR reads this instead of the burned-in text (a caption render defect). */
  readonly ocrOverride?: string | null;
  /** (IOS-5) The picture-in-picture box, when the render has one. */
  readonly pip?: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
}

export type FakeRenderOverride = Partial<{
  integrated: number;
  truePeak: number;
  silences: Interval[];
  blacks: Interval[];
  freezes: Interval[];
  width: number;
  height: number;
  fps: number;
  durationS: number;
  ocrText: string;
}>;

const SVG_MARK = '<!--ios-fake:';

export function readManifest(file: string): FakeManifest {
  const raw = readFileSync(file, 'utf8');
  const at = raw.indexOf(SVG_MARK);
  const json = at >= 0 ? raw.slice(at + SVG_MARK.length, raw.indexOf('-->', at)) : raw;
  const m = JSON.parse(json) as FakeManifest;
  if (m.ios_fake !== 1) throw new Error(`not a fake media file: ${file}`);
  return m;
}

async function write(file: string, m: FakeManifest): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(m));
}

const infoOf = (m: FakeManifest): MediaInfo => ({ width: m.width, height: m.height, fps: m.fps, durationS: m.durationS, hasAudio: m.hasAudio, hasVideo: m.hasVideo });

const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);

export class FakeToolkit implements MediaToolkit {
  readonly name = 'fake-toolkit';
  readonly calls: Array<{ method: string; args: unknown }> = [];
  constructor(
    private readonly opts: {
      onFetch?: (url: string, hint: { kind: 'image' | 'video' | 'audio'; durationS?: number }) => Partial<FakeManifest> | undefined;
      renders?: FakeRenderOverride[];
    } = {},
  ) {}

  async fetch(url: string, dest: string, hint: { kind: 'image' | 'video' | 'audio'; durationS?: number }) {
    this.calls.push({ method: 'fetch', args: { url, hint } });
    const talking = /\/talking\//.test(url);
    // Talking clips and Soul ID stills/clips show the persona's face.
    const persona = talking || /\/soul\//.test(url);
    const base: FakeManifest = {
      ios_fake: 1,
      kind: hint.kind,
      url,
      width: hint.kind === 'audio' ? 0 : 720,
      height: hint.kind === 'audio' ? 0 : 1280,
      fps: hint.kind === 'video' ? 30 : 0,
      durationS: hint.kind === 'image' ? 0 : (hint.durationS ?? 5),
      hasAudio: hint.kind === 'audio' || talking,
      hasVideo: hint.kind !== 'audio',
      loudness: hint.kind === 'audio' || talking ? { integrated: -17.2, truePeak: -2.4, lra: 5 } : null,
      silences: [],
      blacks: [],
      freezes: [],
      face: persona ? { identity: 'persona', similarity: 0.86 } : null,
    };
    await write(dest, { ...base, ...(this.opts.onFetch?.(url, hint) ?? {}) });
  }

  async probe(file: string) {
    return infoOf(readManifest(file));
  }

  async renderVideo(comp: VideoComposition, out: string) {
    this.calls.push({ method: 'renderVideo', args: { segments: comp.segments.length, pip: comp.pip?.segments.length ?? 0, texts: comp.texts.length, durationS: comp.durationS, grade: comp.grade, sharpen: comp.sharpen } });
    const freezes: Interval[] = [];
    const blacks: Interval[] = [];
    const segments: NonNullable<FakeManifest['segments']>[number][] = [];
    // (IOS-5) Picture-in-picture segments run on the same timeline; the persona's face on screen comes from them.
    const pipRefs = new Set((comp.pip?.segments ?? []).map((s) => s));
    for (const s of [...comp.segments, ...(comp.pip?.segments ?? [])]) {
      const src = readManifest(s.file);
      const off = s.offsetS ?? 0;
      const map = (iv: Interval): Interval | null => {
        const a = Math.max(iv.start, off);
        const b = Math.min(iv.end, off + s.durationS);
        return b > a ? { start: s.startS + a - off, end: s.startS + b - off } : null;
      };
      for (const f of src.freezes) {
        const m = map(f);
        if (m) freezes.push(m);
      }
      for (const f of src.blacks) {
        const m = map(f);
        if (m) blacks.push(m);
      }
      if (pipRefs.has(s) || !comp.pip?.segments.length) segments.push({ startS: s.startS, durationS: s.durationS, face: src.face ?? null, ref: s.ref });
    }
    const audio = comp.audio ? readManifest(comp.audio.file) : null;
    const o = this.opts.renders?.shift() ?? {};
    const m: FakeManifest = {
      ios_fake: 1,
      kind: 'video',
      width: o.width ?? comp.width,
      height: o.height ?? comp.height,
      fps: o.fps ?? comp.fps,
      durationS: o.durationS ?? comp.durationS,
      hasAudio: true,
      hasVideo: true,
      loudness: audio
        ? { integrated: o.integrated ?? (comp.loudnorm === 'single' ? -14.2 : audio.loudness?.integrated ?? -20), truePeak: o.truePeak ?? (comp.loudnorm === 'single' ? -1.6 : audio.loudness?.truePeak ?? -3), lra: 5 }
        : { integrated: -70, truePeak: -70, lra: 0 },
      silences: o.silences ?? audio?.silences ?? [],
      blacks: o.blacks ?? blacks,
      freezes: o.freezes ?? freezes,
      texts: comp.texts,
      segments,
      ocrOverride: o.ocrText ?? null,
      ...(comp.pip ? { pip: comp.pip.box } : {}),
    };
    await write(out, m);
    return infoOf(m);
  }

  async renderCard(spec: CardSpec, out: string) {
    this.calls.push({ method: 'renderCard', args: { layout: spec.layout, title: spec.title, banner: spec.banner ?? null, background: !!spec.background } });
    const o = this.opts.renders?.shift() ?? {};
    const m: FakeManifest = {
      ios_fake: 1,
      kind: 'image',
      width: o.width ?? spec.width,
      height: o.height ?? spec.height,
      fps: 0,
      durationS: 0,
      hasAudio: false,
      hasVideo: true,
      loudness: null,
      silences: [],
      blacks: [],
      freezes: [],
      texts: spec.texts,
      ocrOverride: o.ocrText ?? null,
    };
    await write(out, m);
    return infoOf(m);
  }

  async analyze(file: string) {
    const m = readManifest(file);
    return { info: infoOf(m), loudness: m.loudness, silences: m.silences, blacks: m.blacks, freezes: m.freezes };
  }

  async frame(file: string, atS: number, outBase: string) {
    const out = `${outBase}.svg`;
    const m = readManifest(file);
    const texts = (m.texts ?? []).filter((t) => m.kind === 'image' || (atS >= t.startS && atS < t.endS));
    const seg = m.segments?.find((s) => atS >= s.startS && atS < s.startS + s.durationS) ?? null;
    const frame: FakeManifest = {
      ...m,
      kind: 'image',
      durationS: 0,
      texts,
      face: seg ? seg.face : (m.face ?? null),
      segments: undefined,
    };
    const label = texts.map((t) => t.text).join(' / ') || (m.url ?? 'frame');
    const w = m.width || 720;
    const h = m.height || 1280;
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${SVG_MARK}${JSON.stringify(frame)}-->` +
      `<rect width="100%" height="100%" fill="#2b2a33"/><rect x="0" y="${Math.round(h * 0.55)}" width="100%" height="${Math.round(h * 0.18)}" fill="#3d3b4a"/>` +
      `<text x="50%" y="50%" fill="#f4efe6" font-family="Helvetica, Arial, sans-serif" font-size="${Math.round(w / 18)}" text-anchor="middle">${esc(label.slice(0, 40))}</text></svg>`;
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, svg);
    return { path: out, contentType: 'image/svg+xml' };
  }

  async cutAudio(file: string, startS: number, endS: number, out: string) {
    const m = readManifest(file);
    await write(out, { ...m, durationS: Math.round((endS - startS) * 100) / 100 });
  }

  async normalizeAudio(file: string, out: string) {
    this.calls.push({ method: 'normalizeAudio', args: {} });
    const m = readManifest(file);
    await write(out, { ...m, loudness: { integrated: -14.0, truePeak: -1.5, lra: m.loudness?.lra ?? 5 } });
  }
}

/** Reads back the text a fake frame shows (or the render's OCR override). */
export class FakeOcr implements OcrProvider {
  readonly name = 'fake-ocr';
  async read(imagePath: string) {
    const m = readManifest(imagePath);
    const text = m.ocrOverride ?? (m.texts ?? []).map((t) => t.text).join('\n');
    return { text, confidence: text ? 0.97 : 0 };
  }
}

/** Similarity is what the fake clip carries (tests lower it to simulate face drift). */
export class FakeFaceMatcher implements FaceMatcher {
  readonly name = 'fake-face';
  async compare(_referencePath: string, imagePath: string) {
    const m = readManifest(imagePath);
    return m.face ? { faces: 1, similarity: m.face.similarity } : { faces: 0, similarity: null };
  }
}

/** True when a file is one of the fake manifests (JSON or a fake SVG frame). */
export async function isFakeFile(file: string): Promise<boolean> {
  try {
    const head = (await readFile(file, 'utf8')).slice(0, 4000);
    return head.includes('"ios_fake":1');
  } catch {
    return false;
  }
}
