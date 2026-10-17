import { troupeEnv } from '@troupe/env';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Q4_TARGETS } from './config';
import type { Analysis, CardSpec, ColorGrade, Interval, MediaInfo, MediaToolkit, Segment, TextBox, VideoComposition } from './toolkit';
import { wrap } from './toolkit';

/**
 * The real render worker on the Mac (adapted from Brand OS creative-worker `video/ffmpeg.ts`): FFmpeg filter graphs for
 * the reels, sharp (libvips) for stills, cards and the text layers. Binaries come from pinned npm static builds
 * (`ffmpeg-static`, `ffprobe-static`), overridable with TROUPE_FFMPEG / TROUPE_FFPROBE; never brew or curl. Argv only.
 *
 * Every export: H.264 High yuv420p, 30 fps, 2 s GOP, AAC 48 kHz stereo, faststart, upscaled from 720p with lanczos and an
 * unsharp pass, the persona grade (eq + colorbalance), captions as full-frame PNG layers inside the safe zones, and
 * the AI-generated marker in the container metadata.
 */

export interface FfmpegBins {
  readonly ffmpeg: string;
  readonly ffprobe: string;
}

export function resolveBins(env: Readonly<Record<string, string | undefined>> = process.env): FfmpegBins | null {
  const req = createRequire(import.meta.url);
  let ffmpeg = troupeEnv('FFMPEG', env)?.trim() || null;
  let ffprobe = troupeEnv('FFPROBE', env)?.trim() || null;
  try {
    ffmpeg ??= req('ffmpeg-static') as string | null;
  } catch {
    /* not installed */
  }
  try {
    ffprobe ??= (req('ffprobe-static') as { path: string }).path;
  } catch {
    /* not installed */
  }
  return ffmpeg && ffprobe && existsSync(/*turbopackIgnore: true*/ ffmpeg) && existsSync(/*turbopackIgnore: true*/ ffprobe) ? { ffmpeg, ffprobe } : null;
}

export function run(bin: string, args: readonly string[], timeoutMs = 20 * 60_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) =>
    execFile(bin, [...args], { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${bin.split('/').at(-1)} failed: ${stderr.split('\n').slice(-6).join(' | ').slice(0, 600)}`));
      else resolve({ stdout, stderr });
    }),
  );
}

// ───────────────────────────── Parsers (pure; tested on captured output) ─────────────────────────────

/** EBU R128 summary with `ebur128=peak=true`: integrated loudness, LRA and true peak. */
export function parseEbur128(stderr: string): { integrated: number; truePeak: number; lra: number } {
  const sum = stderr.slice(stderr.lastIndexOf('Summary:'));
  const num = (re: RegExp) => {
    const m = re.exec(sum);
    if (!m) throw new Error(`ebur128 summary lacks ${re}`);
    return m[1] === '-inf' ? -70 : Number(m[1]);
  };
  return { integrated: num(/I:\s+(-?[\d.]+|-inf) LUFS/), lra: num(/LRA:\s+(-?[\d.]+) LU/), truePeak: num(/Peak:\s+(-?[\d.]+|-inf) dBFS/) };
}

export function parseIntervals(stderr: string, kind: 'black' | 'silence' | 'freeze', totalS = Number.POSITIVE_INFINITY): Interval[] {
  const out: Interval[] = [];
  if (kind === 'black') {
    for (const m of stderr.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)) out.push({ start: Number(m[1]), end: Number(m[2]) });
    return out;
  }
  const [s, e] = kind === 'silence' ? [/silence_start: (-?[\d.]+)/, /silence_end: ([\d.]+)/] : [/freeze_start: ([\d.]+)/, /freeze_end: ([\d.]+)/];
  let start: number | null = null;
  for (const line of stderr.split('\n')) {
    const a = s.exec(line);
    if (a) start = Math.max(0, Number(a[1]));
    const b = e.exec(line);
    if (b && start !== null) {
      out.push({ start, end: Number(b[1]) });
      start = null;
    }
  }
  if (start !== null) out.push({ start, end: totalS });
  return out;
}

export function parseLoudnormJson(stderr: string): Record<string, string> {
  const a = stderr.lastIndexOf('{');
  const b = stderr.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('loudnorm printed no JSON');
  return JSON.parse(stderr.slice(a, b + 1)) as Record<string, string>;
}

const fpsOf = (r: string | undefined): number => {
  const [a, b] = (r ?? '0/1').split('/').map(Number);
  return b ? Math.round((a! / b!) * 100) / 100 : 0;
};

// ───────────────────────────── Filters ─────────────────────────────

export function gradeFilter(g: ColorGrade): string {
  const f = (n: number) => n.toFixed(3);
  return `eq=brightness=${f(g.brightness)}:contrast=${f(g.contrast)}:saturation=${f(g.saturation)}:gamma=${f(g.gamma)},colorbalance=rm=${f(g.rm)}:gm=${f(g.gm)}:bm=${f(g.bm)}`;
}
export const SHARPEN = 'unsharp=5:5:0.85:5:5:0.0';

const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);

/**
 * A full-frame transparent SVG with one text block. Over footage: white on a dark rounded plate (the CTA in the
 * accent). On a solid card (`solid`): ink on the persona background, the CTA in the accent, no plate.
 */
export function textSvg(t: TextBox, frame: { width: number; height: number }, o: { accent?: string; solid?: { ink: string } } = {}): string {
  const perLine = Math.max(8, Math.floor((t.box.w - t.fontSize) / (t.fontSize * 0.56)));
  const lines = wrap(t.text, perLine);
  const lh = t.fontSize * 1.25;
  const top = t.box.y + t.fontSize * 0.3 + t.fontSize;
  const accent = o.accent ?? '#F4C430';
  // (IOS-5) A comment sticker is dark ink on a white plate, wherever it sits.
  const sticker = t.style === 'sticker';
  const fill = sticker ? '#16151A' : t.style === 'cta' ? accent : o.solid ? o.solid.ink : '#FFFFFF';
  const plate = sticker
    ? `<rect x="${t.box.x + 4}" y="${t.box.y + 6}" width="${t.box.w}" height="${t.box.h}" rx="${Math.round(t.fontSize * 0.5)}" fill="rgba(0,0,0,0.25)"/><rect x="${t.box.x}" y="${t.box.y}" width="${t.box.w}" height="${t.box.h}" rx="${Math.round(t.fontSize * 0.5)}" fill="#FFFFFF"/>`
    : o.solid
      ? ''
      : `<rect x="${t.box.x}" y="${t.box.y}" width="${t.box.w}" height="${t.box.h}" rx="${Math.round(t.fontSize * 0.35)}" fill="${t.style === 'caption' ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.45)'}"/>`;
  const stroke = o.solid || sticker ? '' : ` stroke="rgba(0,0,0,0.6)" stroke-width="${Math.max(1, Math.round(t.fontSize / 22))}" paint-order="stroke"`;
  const tspans = lines.map((l, i) => `<tspan x="${t.box.x + t.box.w / 2}" y="${Math.round(top + i * lh)}">${esc(l)}</tspan>`).join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${frame.width}" height="${frame.height}">${plate}` +
    `<text font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-weight="800" font-size="${t.fontSize}" fill="${fill}" text-anchor="middle"${stroke}>${tspans}</text></svg>`
  );
}

/**
 * (IOS-5) Layout chrome drawn under the text: the News Desk banner (our own generic desk, never an outlet's logo), the
 * slide window of a facecam backdrop, the ruled lines of a note card.
 */
export function cardChrome(spec: Pick<CardSpec, 'width' | 'height' | 'layout' | 'banner' | 'colors'>): string | null {
  const { width: W, height: H } = spec;
  const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${body}</svg>`;
  if (spec.layout === 'news') {
    const label = esc((spec.banner ?? 'NEWS DESK').slice(0, 24));
    return svg(
      `<rect x="0" y="${Math.round(H * 0.1)}" width="${W}" height="${Math.round(H * 0.05)}" fill="#C8102E"/>` +
        `<text x="96" y="${Math.round(H * 0.1 + H * 0.035)}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-weight="800" font-size="${Math.round(H * 0.026)}" fill="#FFFFFF" letter-spacing="4">${label}</text>` +
        `<rect x="0" y="${Math.round(H * 0.33)}" width="${W}" height="4" fill="#C8102E" opacity="0.8"/>`,
    );
  }
  if (spec.layout === 'screen') {
    const x = 70;
    const y = Math.round(H * 0.13);
    const w = W - 140;
    const h = Math.round(H * 0.74);
    return svg(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="28" fill="#FFFFFF" opacity="0.92"/>` +
        `<rect x="${x}" y="${y}" width="${w}" height="64" rx="28" fill="${spec.colors.accent}" opacity="0.85"/>` +
        [0, 1, 2].map((i) => `<circle cx="${x + 44 + i * 34}" cy="${y + 32}" r="10" fill="#FFFFFF" opacity="0.8"/>`).join(''),
    );
  }
  if (spec.layout === 'note') {
    const lines = Array.from({ length: 14 }, (_, i) => `<rect x="90" y="${Math.round(H * 0.2 + i * 78)}" width="${W - 180}" height="2" fill="#D9D2C3"/>`).join('');
    return svg(`${lines}<rect x="150" y="${Math.round(H * 0.17)}" width="3" height="${Math.round(H * 0.66)}" fill="#E8A9A0"/>`);
  }
  return null;
}

/** The FFmpeg argv for one reel (pure, so the graph is unit-tested without the binary). */
export function videoArgs(comp: VideoComposition, layers: readonly string[], out: string): string[] {
  const { width: W, height: H, fps } = comp;
  const D = comp.durationS.toFixed(3);
  const args = ['-hide_banner', '-nostats', '-y'];
  const pip = comp.pip?.segments.length ? comp.pip : null;
  const input = (s: Segment) => {
    if (s.kind === 'image') args.push('-loop', '1', '-framerate', String(fps), '-t', s.durationS.toFixed(3), '-i', s.file);
    else args.push('-stream_loop', '-1', '-ss', (s.offsetS ?? 0).toFixed(3), '-t', s.durationS.toFixed(3), '-i', s.file);
  };
  comp.segments.forEach(input);
  pip?.segments.forEach(input);
  const pipN = pip?.segments.length ?? 0;
  for (const l of layers) args.push('-loop', '1', '-framerate', String(fps), '-t', D, '-i', l);
  const audioIndex = comp.segments.length + pipN + layers.length;
  if (comp.audio) args.push('-i', comp.audio.file);
  else args.push('-f', 'lavfi', '-t', D, '-i', 'anullsrc=r=48000:cl=stereo');

  const parts: string[] = [];
  comp.segments.forEach((s, i) => {
    const frames = Math.max(1, Math.round(s.durationS * fps));
    const pad = /^#[0-9a-f]{6}$/i.test(s.padColor ?? '') ? `0x${s.padColor!.slice(1)}` : 'black';
    const fit =
      s.fit === 'contain'
        ? `scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${pad}`
        : `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H}`;
    const motion =
      s.kind === 'image' && s.motion === 'push'
        ? `scale=${Math.round(W * 1.15)}:-2:flags=lanczos,zoompan=z='min(zoom+0.0006,1.08)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${fps},`
        : '';
    parts.push(`[${i}:v]${fit},${motion}setsar=1,fps=${fps},format=yuv420p,trim=duration=${s.durationS.toFixed(3)},setpts=PTS-STARTPTS[s${i}]`);
  });
  parts.push(`${comp.segments.map((_, i) => `[s${i}]`).join('')}concat=n=${comp.segments.length}:v=1:a=0[base]`);
  let main = 'base';
  if (pip) {
    // (IOS-5) The persona's track scaled into its box over the main track (facecam over screen, News Desk green-screen).
    const { x, y, w, h } = pip.box;
    pip.segments.forEach((s, j) => {
      const k = comp.segments.length + j;
      parts.push(`[${k}:v]scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h},setsar=1,fps=${fps},format=yuv420p,trim=duration=${s.durationS.toFixed(3)},setpts=PTS-STARTPTS[p${j}]`);
    });
    parts.push(`${pip.segments.map((_, j) => `[p${j}]`).join('')}concat=n=${pip.segments.length}:v=1:a=0,drawbox=x=0:y=0:w=iw:h=ih:color=white@0.9:t=6[pip]`);
    parts.push(`[base][pip]overlay=${x}:${y}:format=auto:eof_action=pass[withpip]`);
    main = 'withpip';
  }
  parts.push(`[${main}]${gradeFilter(comp.grade)}${comp.sharpen ? `,${SHARPEN}` : ''}[g0]`);
  let cur = 'g0';
  comp.texts.forEach((t, k) => {
    const next = `o${k}`;
    parts.push(`[${cur}][${comp.segments.length + pipN + k}:v]overlay=0:0:format=auto:enable='between(t,${t.startS.toFixed(2)},${t.endS.toFixed(2)})'[${next}]`);
    cur = next;
  });
  parts.push(`[${cur}]format=yuv420p[vout]`);
  const loud = comp.loudnorm === 'single' && comp.audio ? `loudnorm=I=${Q4_TARGETS.lufs}:TP=-1.5:LRA=11,` : '';
  parts.push(`[${audioIndex}:a]aresample=48000,${loud}aformat=sample_rates=48000:channel_layouts=stereo,apad,atrim=duration=${D},asetpts=PTS-STARTPTS[aout]`);

  args.push('-filter_complex', parts.join(';'), '-map', '[vout]', '-map', '[aout]');
  args.push('-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '19', '-r', String(fps), '-g', String(fps * 2), '-keyint_min', String(fps * 2), '-sc_threshold', '0');
  args.push('-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709');
  args.push('-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2', '-t', D, '-movflags', '+faststart', '-map_metadata', '-1');
  for (const [k, v] of Object.entries(comp.metadata)) args.push('-metadata', `${k}=${v}`);
  args.push(out);
  return args;
}

export class FfmpegToolkit implements MediaToolkit {
  readonly name = 'ffmpeg';
  constructor(
    readonly bins: FfmpegBins,
    private readonly fetchFn: (input: string, init?: RequestInit) => Promise<Response> = (i, init) => fetch(i, init),
  ) {}

  async fetch(url: string, dest: string) {
    if (!/^https:\/\//.test(url)) throw new Error('media fetch: only https URLs');
    const res = await this.fetchFn(url);
    if (!res.ok) throw new Error(`media fetch failed (${res.status})`);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, new Uint8Array(await res.arrayBuffer()));
  }

  async probe(file: string): Promise<MediaInfo> {
    const { stdout } = await run(this.bins.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
    const p = JSON.parse(stdout) as { streams: Array<{ codec_type: string; width?: number; height?: number; r_frame_rate?: string; duration?: string }>; format: { duration?: string } };
    const v = p.streams.find((s) => s.codec_type === 'video');
    return {
      width: v?.width ?? 0,
      height: v?.height ?? 0,
      fps: fpsOf(v?.r_frame_rate),
      durationS: Number(p.format.duration ?? v?.duration ?? 0),
      hasAudio: p.streams.some((s) => s.codec_type === 'audio'),
      hasVideo: !!v,
    };
  }

  private async layer(svg: string, out: string): Promise<string> {
    const sharp = (await import('sharp')).default;
    await sharp(Buffer.from(svg)).png().toFile(out);
    return out;
  }

  async renderVideo(comp: VideoComposition, out: string) {
    await mkdir(dirname(out), { recursive: true });
    const dir = `${out}.layers`;
    await mkdir(dir, { recursive: true });
    try {
      const layers: string[] = [];
      for (const [i, t] of comp.texts.entries()) layers.push(await this.layer(textSvg(t, comp, { accent: comp.grade.accent }), join(dir, `t${i}.png`)));
      await run(this.bins.ffmpeg, videoArgs(comp, layers, out));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    return this.probe(out);
  }

  async renderCard(spec: CardSpec, out: string) {
    const sharp = (await import('sharp')).default;
    await mkdir(dirname(out), { recursive: true });
    const { width: W, height: H } = spec;
    // (IOS-5) A meme puts its photo under a white band that carries the line.
    const meme = spec.layout === 'meme' && !!spec.background;
    const band = meme ? Math.min(Math.round(H * 0.42), Math.max(...spec.texts.map((t) => t.box.y + t.box.h), Math.round(H * 0.2)) + 40) : 0;
    let base = meme
      ? sharp({ create: { width: W, height: H, channels: 3, background: '#FFFFFF' } }).composite([
          { input: await sharp(spec.background!).resize(W, H - band, { fit: 'cover', kernel: 'lanczos3' }).toBuffer(), top: band, left: 0 },
        ])
      : spec.background
        ? sharp(spec.background).resize(W, H, { fit: 'cover', kernel: 'lanczos3' })
        : sharp({ create: { width: W, height: H, channels: 3, background: spec.layout === 'news' ? '#0E1A2B' : spec.layout === 'note' ? '#FBF8F1' : spec.colors.bg } });
    if (meme) base = sharp(await base.png().toBuffer());
    if (spec.background && !meme) {
      const g = spec.grade;
      base = base
        .modulate({ brightness: 1 + g.brightness, saturation: g.saturation })
        .linear(g.contrast, -(128 * g.contrast) + 128)
        .recomb([
          [1 + g.rm, 0, 0],
          [0, 1 + g.gm, 0],
          [0, 0, 1 + g.bm],
        ]);
    }
    if (spec.sharpen) base = base.sharpen({ sigma: 0.8 });
    const scrim = spec.background && !meme && spec.texts.length
      ? `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0.45" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.55"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#s)"/></svg>`
      : null;
    const solid = meme ? { ink: '#111111' } : spec.background ? undefined : { ink: spec.layout === 'news' ? '#FFFFFF' : spec.layout === 'note' ? '#1F1D1A' : spec.colors.ink };
    const chrome = cardChrome(spec);
    const pager =
      spec.index && spec.total && spec.total > 1
        ? `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><text x="${W - 190}" y="${Math.round(H * 0.94)}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-weight="700" font-size="34" fill="${spec.background ? '#FFFFFF' : spec.colors.ink}" opacity="0.7" text-anchor="end">${spec.index}/${spec.total}</text></svg>`
        : null;
    const layers = [
      ...(scrim ? [{ input: Buffer.from(scrim) }] : []),
      ...(chrome ? [{ input: Buffer.from(chrome) }] : []),
      ...spec.texts.map((t) => ({ input: Buffer.from(textSvg(t, spec, { accent: spec.colors.accent, solid })) })),
      ...(pager ? [{ input: Buffer.from(pager) }] : []),
    ];
    await base.composite(layers).jpeg({ quality: 92, mozjpeg: true }).toFile(out);
    const meta = await sharp(out).metadata();
    return { width: meta.width ?? W, height: meta.height ?? H, fps: 0, durationS: 0, hasAudio: false, hasVideo: true };
  }

  async analyze(file: string, opts: { audio: boolean }): Promise<Analysis> {
    const info = await this.probe(file);
    let loudness: Analysis['loudness'] = null;
    let silences: Interval[] = [];
    if (opts.audio && info.hasAudio) {
      const a = await run(this.bins.ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', `ebur128=peak=true,silencedetect=n=-45dB:d=${Q4_TARGETS.silenceMaxS}`, '-f', 'null', '-']);
      loudness = parseEbur128(a.stderr);
      silences = parseIntervals(a.stderr, 'silence', info.durationS);
    }
    let blacks: Interval[] = [];
    let freezes: Interval[] = [];
    if (info.hasVideo && info.durationS > 0) {
      const v = await run(this.bins.ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-an', '-vf', `blackdetect=d=${Q4_TARGETS.blackMaxS}:pic_th=0.98,freezedetect=n=-60dB:d=${Q4_TARGETS.freezeMaxS}`, '-f', 'null', '-']);
      blacks = parseIntervals(v.stderr, 'black');
      freezes = parseIntervals(v.stderr, 'freeze', info.durationS);
    }
    return { info, loudness, silences, blacks, freezes };
  }

  async frame(file: string, atS: number, outBase: string) {
    const out = `${outBase}.jpg`;
    await mkdir(dirname(out), { recursive: true });
    const info = await this.probe(file);
    if (info.durationS === 0) {
      const sharp = (await import('sharp')).default;
      await sharp(file).jpeg({ quality: 90 }).toFile(out);
    } else {
      await run(this.bins.ffmpeg, ['-hide_banner', '-nostats', '-y', '-ss', Math.min(atS, Math.max(0, info.durationS - 0.05)).toFixed(3), '-i', file, '-frames:v', '1', '-q:v', '2', out]);
    }
    return { path: out, contentType: 'image/jpeg' };
  }

  async cutAudio(file: string, startS: number, endS: number, out: string) {
    await run(this.bins.ffmpeg, ['-hide_banner', '-nostats', '-y', '-ss', startS.toFixed(3), '-t', (endS - startS).toFixed(3), '-i', file, '-vn', '-c:a', 'libmp3lame', '-b:a', '160k', out]);
  }

  async normalizeAudio(file: string, out: string) {
    const target = `I=${Q4_TARGETS.lufs}:TP=-1.5:LRA=11`;
    const m = parseLoudnormJson((await run(this.bins.ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', `loudnorm=${target}:print_format=json`, '-f', 'null', '-'])).stderr);
    const second = `loudnorm=${target}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo`;
    await run(this.bins.ffmpeg, ['-hide_banner', '-nostats', '-y', '-i', file, '-map', '0:v', '-map', '0:a', '-c:v', 'copy', '-af', second, '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out]);
  }
}
