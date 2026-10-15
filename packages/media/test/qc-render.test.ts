import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  captionCues,
  EXPORT,
  FfmpegToolkit,
  gradeFilter,
  gradeFromKit,
  gradeQ3,
  gradeQ4,
  insideSafeZone,
  NEUTRAL_GRADE,
  ocrMatch,
  parseEbur128,
  parseIntervals,
  parseLookPrompts,
  placeText,
  type Q4Input,
  resolveBins,
  splitSpeech,
  videoArgs,
} from '../src';

const info = (o: Partial<Q4Input['info']> = {}) => ({ width: 1080, height: 1920, fps: 30, durationS: 24, hasAudio: true, hasVideo: true, ...o });
const base = (o: Partial<Q4Input> = {}): Q4Input => ({
  format: 'voiceover',
  voiced: true,
  info: info(),
  analysis: { info: info(), loudness: { integrated: -14.2, truePeak: -1.6, lra: 5 }, silences: [], blacks: [], freezes: [] },
  texts: [placeText('Every dollar gets a job', 'caption', 1, 3)],
  ocr: [{ atS: 2, expected: 'Every dollar gets a job', read: 'EVERY DOLLAR\nGETS A JOB' }],
  segments: [
    { ref: 'clip:0', startS: 0, durationS: 8 },
    { ref: 'clip:1', startS: 8, durationS: 8 },
  ],
  coverOk: true,
  aiFlag: true,
  ctaKeyword: 'PLAN',
  caption: 'Comment PLAN for the starter.',
  hashtags: ['#money', '#budget', '#finance'],
  ...o,
});

describe('QC Q4 grader', () => {
  it('passes a clean reel', () => {
    const r = gradeQ4(base());
    expect(r.pass).toBe(true);
    expect(r.fixes).toEqual([]);
  });

  it('loudness off target → re-normalise; true peak too → still one fix', () => {
    const r = gradeQ4(base({ analysis: { ...base().analysis!, loudness: { integrated: -18, truePeak: -0.2, lra: 5 } } }));
    expect(r.pass).toBe(false);
    expect(r.checks.filter((c) => !c.pass).map((c) => c.check)).toEqual(['loudness', 'true_peak']);
    expect(r.fixes).toEqual([{ kind: 'normalize_audio' }]);
  });

  it('a long silence inside the speech → re-voice; leading/trailing room is fine', () => {
    const a = base().analysis!;
    expect(gradeQ4(base({ analysis: { ...a, silences: [{ start: 0, end: 0.2 }, { start: 23.5, end: 24 }] } })).pass).toBe(true);
    const r = gradeQ4(base({ analysis: { ...a, silences: [{ start: 9, end: 10.1 }] } }));
    expect(r.fixes).toEqual([{ kind: 'revoice' }]);
  });

  it('frozen or black frames name the clip to regenerate', () => {
    const r = gradeQ4(base({ analysis: { ...base().analysis!, freezes: [{ start: 9, end: 11 }] } }));
    expect(r.checks.find((c) => c.check === 'frozen_frames')).toMatchObject({ pass: false, severity: 'blocker', location: '0:09.0' });
    expect(r.fixes).toEqual([{ kind: 'regenerate', refs: ['clip:1'] }]);
  });

  it('wrong size, missing AI flag and misread captions fail', () => {
    const r = gradeQ4(base({ info: info({ width: 720, height: 1280 }), aiFlag: false, ocr: [{ atS: 2, expected: 'Every dollar gets a job', read: 'Evrey dolar' }] }));
    expect(r.checks.filter((c) => !c.pass).map((c) => c.check).sort()).toEqual(['ai_flag', 'caption_ocr', 'resolution']);
    expect(r.fixes.map((f) => f.kind).sort()).toEqual(['captions', 'rerender']);
  });

  it('carousels: 6–8 slides at 1080×1350; static needs no audio checks', () => {
    const slide = { width: 1080, height: 1350, fps: 0, durationS: 0, hasAudio: false, hasVideo: true };
    const ok = gradeQ4(base({ format: 'carousel', voiced: false, analysis: null, info: slide, slides: Array(7).fill(slide), texts: [], ocr: [] }));
    expect(ok.pass).toBe(true);
    const few = gradeQ4(base({ format: 'carousel', voiced: false, analysis: null, info: slide, slides: Array(4).fill(slide), texts: [], ocr: [] }));
    expect(few.checks.find((c) => c.check === 'slide_count')!.pass).toBe(false);
    const stat = gradeQ4(base({ format: 'static', voiced: false, analysis: null, info: info({ durationS: 0, fps: 0, hasAudio: false }), texts: [], ocr: [] }));
    expect(stat.pass).toBe(true);
  });

  it('OCR match tolerates case, line breaks and extra words, not misspellings', () => {
    expect(ocrMatch('Comment PLAN', 'comment plan\nsave this')).toBe(1);
    expect(ocrMatch('Every dollar gets a job', 'Every dolar gets a jbo')).toBeLessThan(0.8);
  });
});

describe('QC Q3 grader', () => {
  it('flags face drift, extra faces and frozen clips per clip', () => {
    const r = gradeQ3(
      [
        { ref: 'talk:0', samples: [{ atS: 0.5, faces: 1, similarity: 0.82 }], freezes: [] },
        { ref: 'talk:1', samples: [{ atS: 0.5, faces: 2, similarity: 0.4 }], freezes: [{ start: 3, end: 5 }] },
      ],
      { hasReference: true },
    );
    expect(r.pass).toBe(false);
    expect(r.redo).toEqual(['talk:1']);
    expect(r.checks.filter((c) => !c.pass).map((c) => c.check)).toEqual(['face_similarity', 'artefacts', 'frozen_frames']);
  });
});

describe('layout and timing', () => {
  it('captions sit inside the platform safe zone and cover the track', () => {
    const cues = captionCues('If your paycheck is gone by the twentieth, try this. Comment PLAN and I will send you the starter.', 9);
    expect(cues.length).toBeGreaterThan(4);
    expect(cues.every((c) => insideSafeZone(c))).toBe(true);
    expect(cues[0]!.startS).toBeLessThan(0.2);
    expect(cues.at(-1)!.endS).toBeLessThanOrEqual(9);
    expect(insideSafeZone(placeText('Comment PLAN', 'cta', 0, 1))).toBe(true);
    expect(insideSafeZone(placeText('A headline that is long enough to wrap twice on a phone screen', 'headline', 0, 1, EXPORT.carousel), EXPORT.carousel)).toBe(true);
    expect(insideSafeZone({ ...placeText('x', 'caption', 0, 1), box: { x: 10, y: 100, w: 300, h: 80 } })).toBe(false);
  });

  it('splits speech into talking clips of ≤ 15 s at sentence ends', () => {
    const text = 'One two three four five six seven eight. Nine ten eleven twelve thirteen fourteen. Fifteen sixteen seventeen eighteen nineteen twenty.';
    const parts = splitSpeech(text, 28, 15);
    expect(parts).toHaveLength(2);
    expect(parts.every((p) => p.endS - p.startS <= 15)).toBe(true);
    expect(parts[1]!.startS).toBeCloseTo(parts[0]!.endS, 1);
    expect(splitSpeech('Short line.', 6, 15)).toHaveLength(1);
  });

  it('grades lean toward the persona accent, gently', () => {
    const g = gradeFromKit({ colors: { bg: '#FAF7F2', ink: '#1C1A17', accent: '#2F6FB0', accent2: '#2F6FB0' } });
    expect(g.bm).toBeGreaterThan(0);
    expect(Math.max(Math.abs(g.rm), Math.abs(g.gm), Math.abs(g.bm))).toBeLessThanOrEqual(0.06);
    expect(gradeFilter(NEUTRAL_GRADE)).toBe('eq=brightness=0.000:contrast=1.000:saturation=1.000:gamma=1.000,colorbalance=rm=0.000:gm=0.000:bm=0.000');
  });

  it('reads look prompts from fenced blocks', () => {
    expect(parseLookPrompts('# Look\n```\nPhotorealistic character reference sheet, three panels, the same woman.\n```\ntext\n```text\nshort\n```')).toEqual([
      'Photorealistic character reference sheet, three panels, the same woman.',
    ]);
  });
});

describe('FFmpeg graph and parsers', () => {
  it('builds one filter graph: fit to 1080×1920, grade, sharpen, timed text layers, loudnorm, AI metadata', () => {
    const args = videoArgs(
      {
        ...EXPORT.video,
        durationS: 8,
        segments: [
          { file: 'a.mp4', kind: 'video', startS: 0, durationS: 5, ref: 'clip:0' },
          { file: 'b.png', kind: 'image', startS: 5, durationS: 3, motion: 'push' },
        ],
        audio: { file: 'voice.mp3' },
        texts: [placeText('Hello', 'caption', 0.1, 2)],
        grade: NEUTRAL_GRADE,
        sharpen: true,
        loudnorm: 'single',
        metadata: { comment: 'AI-generated' },
      },
      ['t0.png'],
      'out.mp4',
    );
    const graph = args[args.indexOf('-filter_complex') + 1]!;
    expect(graph).toContain('scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920');
    expect(graph).toContain('concat=n=2:v=1:a=0[base]');
    expect(graph).toContain('unsharp=5:5:0.85');
    expect(graph).toContain("overlay=0:0:format=auto:enable='between(t,0.10,2.00)'");
    expect(graph).toContain('[3:a]aresample=48000,loudnorm=I=-14:TP=-1.5:LRA=11,aformat');
    expect(graph).toContain('zoompan');
    expect(args).toEqual(expect.arrayContaining(['-r', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-metadata', 'comment=AI-generated', '-movflags', '+faststart']));
  });

  it('parses ebur128, silencedetect, blackdetect and freezedetect output', () => {
    const ebu = `[Parsed_ebur128_0] Summary:\n\n  Integrated loudness:\n    I:         -14.3 LUFS\n    Threshold: -24.5 LUFS\n\n  Loudness range:\n    LRA:         4.1 LU\n\n  True peak:\n    Peak:       -1.4 dBFS`;
    expect(parseEbur128(ebu)).toEqual({ integrated: -14.3, lra: 4.1, truePeak: -1.4 });
    expect(parseIntervals('[silencedetect] silence_start: 3.2\n[silencedetect] silence_end: 4.1 | silence_duration: 0.9', 'silence')).toEqual([{ start: 3.2, end: 4.1 }]);
    expect(parseIntervals('[blackdetect] black_start:0 black_end:0.4 black_duration:0.4', 'black')).toEqual([{ start: 0, end: 0.4 }]);
    expect(parseIntervals('lavfi.freezedetect.freeze_start: 2.5\nlavfi.freezedetect.freeze_duration: 1\nlavfi.freezedetect.freeze_end: 3.5', 'freeze')).toEqual([{ start: 2.5, end: 3.5 }]);
    expect(parseIntervals('lavfi.freezedetect.freeze_start: 7', 'freeze', 9)).toEqual([{ start: 7, end: 9 }]);
  });
});

// The real binaries (pinned npm static builds) when present: render a tiny reel and a card, then measure them.
const bins = resolveBins();
describe.skipIf(!bins)('FFmpeg toolkit (real binaries)', () => {
  it('renders, analyses and normalises a 3 s reel and a 4:5 card', async () => {
    const sharp = (await import('sharp')).default;
    const dir = mkdtempSync(join(tmpdir(), 'ios-ffmpeg-'));
    const tk = new FfmpegToolkit(bins!);
    const img = join(dir, 'bg.png');
    await sharp({ create: { width: 720, height: 1280, channels: 3, background: '#3a6ea5' } }).png().toFile(img);
    const tone = join(dir, 'tone.mp3');
    const { run } = await import('../src/ffmpeg');
    await run(bins!.ffmpeg, ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=3', '-af', 'volume=0.3', '-c:a', 'libmp3lame', tone]);
    const out = join(dir, 'reel.mp4');
    const reel = await tk.renderVideo(
      {
        ...EXPORT.video,
        durationS: 3,
        segments: [{ file: img, kind: 'image', startS: 0, durationS: 3, motion: 'push' }],
        audio: { file: tone },
        texts: [placeText('Comment PLAN', 'cta', 0.2, 2.8)],
        grade: gradeFromKit({ colors: { bg: '#FAF7F2', ink: '#1C1A17', accent: '#2F6FB0', accent2: '#2F6FB0' } }),
        sharpen: true,
        loudnorm: 'single',
        metadata: { comment: 'AI-generated' },
      },
      out,
    );
    expect(reel).toMatchObject({ width: 1080, height: 1920, fps: 30, hasAudio: true });
    expect(reel.durationS).toBeCloseTo(3, 0);
    const a = await tk.analyze(out, { audio: true });
    expect(a.loudness).not.toBeNull();
    expect(a.blacks).toEqual([]);
    const norm = join(dir, 'norm.mp4');
    await tk.normalizeAudio(out, norm);
    const b = await tk.analyze(norm, { audio: true });
    expect(Math.abs(b.loudness!.integrated - -14)).toBeLessThan(1.5);
    const frame = await tk.frame(out, 1, join(dir, 'cover'));
    expect(frame.contentType).toBe('image/jpeg');
    const card = await tk.renderCard(
      { ...EXPORT.carousel, background: img, colors: { bg: '#FAF7F2', ink: '#1C1A17', accent: '#2F6FB0' }, layout: 'cover', title: 'Sinking funds', grade: NEUTRAL_GRADE, sharpen: true, texts: [placeText('Sinking funds', 'headline', 0, 0, EXPORT.carousel)] },
      join(dir, 'slide.jpg'),
    );
    expect(card).toMatchObject({ width: 1080, height: 1350 });
    const cut = join(dir, 'cut.mp3');
    await tk.cutAudio(tone, 1, 2.5, cut);
    expect((await tk.probe(cut)).durationS).toBeCloseTo(1.5, 0);
  }, 120_000);
});
