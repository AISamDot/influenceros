import { execFile } from 'node:child_process';
import type { HiggsfieldOperation, ImageVideoProvider, MediaAspect, MediaResolution, MediaResult, TalkingProvider, VoiceProvider } from '@ios/providers';
import { GEN_RESOLUTION, type MediaModels, mediaModels, TALK_CLIP_MAX_S } from './config';

/**
 * Live Higgsfield adapter: shells out to the official CLI (`npm i -g @higgsfield/cli`, never `curl | sh`), argv only,
 * never a shell. Keys reach the child only through its environment (HIGGSFIELD_API_KEY / HIGGSFIELD_API_SECRET), never
 * argv, logs or prompts. Every call asks for `--json`; generations block with `--wait` and return the result URL and
 * the credits the job actually cost (settled through the governor by the caller).
 *
 * The CLI's flag names follow its model schemas (`higgsfield model get <id>`); the ones used here are the documented
 * snake_case parameters (`--prompt`, `--image`, `--audio`, `--duration`, `--resolution`, `--aspect_ratio`).
 */

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
}
export type ChildEnv = Readonly<Record<string, string | undefined>>;
export type Exec = (bin: string, args: readonly string[], opts: { env: ChildEnv; timeoutMs: number }) => Promise<ExecResult>;

export const execCli: Exec = (bin, args, opts) =>
  new Promise((resolve, reject) =>
    execFile(bin, [...args], { env: opts.env as unknown as NodeJS.ProcessEnv, timeout: opts.timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') reject(new Error(`Higgsfield CLI not found (${bin}): install it with \`npm i -g @higgsfield/cli\` or set HIGGSFIELD_CLI`));
        else reject(new Error(`higgsfield ${args[0] ?? ''} ${args[1] ?? ''} failed: ${String(stderr || err.message).split('\n').slice(-4).join(' | ').slice(0, 400)}`));
      } else resolve({ stdout, stderr });
    }),
  );

/** First JSON value in CLI output (some versions print a progress line before it). */
export function parseCliJson(stdout: string): unknown {
  const t = stdout.trim();
  for (const start of [t.indexOf('{'), t.indexOf('[')].filter((i) => i >= 0).sort((a, b) => a - b)) {
    try {
      return JSON.parse(t.slice(start));
    } catch {
      const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
      if (end > start) {
        try {
          return JSON.parse(t.slice(start, end + 1));
        } catch {
          /* try the next start */
        }
      }
    }
  }
  throw new Error(`higgsfield: no JSON in CLI output (${t.slice(0, 120)})`);
}

/** Depth-first search for the first value whose key matches. */
function find(v: unknown, keys: readonly string[], test: (x: unknown) => boolean, depth = 0): unknown {
  if (depth > 6 || v === null || typeof v !== 'object') return undefined;
  if (Array.isArray(v)) {
    for (const x of v) {
      const r = find(x, keys, test, depth + 1);
      if (r !== undefined) return r;
    }
    return undefined;
  }
  const o = v as Record<string, unknown>;
  for (const k of keys) if (k in o && test(o[k])) return o[k];
  for (const x of Object.values(o)) {
    const r = find(x, keys, test, depth + 1);
    if (r !== undefined) return r;
  }
  return undefined;
}

const isUrl = (x: unknown) => typeof x === 'string' && /^https:\/\//.test(x);
const isNum = (x: unknown) => (typeof x === 'number' && Number.isFinite(x)) || (typeof x === 'string' && /^\d+(\.\d+)?$/.test(x));

export interface CliJob {
  readonly jobId: string;
  readonly url: string | null;
  readonly credits: number;
  readonly status: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationS: number | null;
}

export function readJob(v: unknown): CliJob {
  const id = find(v, ['job_id', 'jobId', 'id', 'request_id', 'reference_id'], (x) => typeof x === 'string' || typeof x === 'number');
  const url = find(v, ['url', 'result_url', 'output_url', 'video_url', 'image_url', 'raw', 'min'], isUrl);
  const credits = find(v, ['credits', 'credits_used', 'cost', 'price', 'credit_cost', 'total_cost'], isNum);
  const status = find(v, ['status', 'state'], (x) => typeof x === 'string');
  const num = (keys: string[]) => {
    const n = find(v, keys, isNum);
    return n === undefined ? null : Number(n);
  };
  return {
    jobId: id === undefined ? '' : String(id),
    url: (url as string | undefined) ?? null,
    credits: credits === undefined ? 0 : Number(credits),
    status: (status as string | undefined) ?? null,
    width: num(['width']),
    height: num(['height']),
    durationS: num(['duration', 'duration_s', 'durationS']),
  };
}

const ASPECT_SIZE: Record<MediaAspect, [number, number]> = { '9:16': [720, 1280], '1:1': [720, 720], '4:5': [720, 900] };

export interface HiggsfieldCliOptions {
  apiKey: string;
  apiSecret: string;
  /** CLI binary: HIGGSFIELD_CLI, else `higgsfield` on PATH. */
  bin?: string;
  exec?: Exec;
  models?: MediaModels;
  timeoutMs?: number;
}

export class HiggsfieldCli implements ImageVideoProvider {
  readonly name = 'higgsfield-cli';
  readonly #key: string;
  readonly #secret: string;
  readonly bin: string;
  readonly models: MediaModels;
  readonly #exec: Exec;
  readonly #timeoutMs: number;
  constructor(o: HiggsfieldCliOptions) {
    this.#key = o.apiKey;
    this.#secret = o.apiSecret;
    this.bin = o.bin ?? (process.env.HIGGSFIELD_CLI?.trim() || 'higgsfield');
    this.models = o.models ?? mediaModels();
    this.#exec = o.exec ?? execCli;
    this.#timeoutMs = o.timeoutMs ?? 20 * 60_000;
  }

  /** Runs one CLI command; the keys go in the child environment only. */
  async run(args: readonly string[]): Promise<unknown> {
    const env: ChildEnv = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'en_US.UTF-8', HIGGSFIELD_API_KEY: this.#key, HIGGSFIELD_API_SECRET: this.#secret };
    const { stdout } = await this.#exec(this.bin, [...args, '--json'], { env, timeoutMs: this.#timeoutMs });
    return parseCliJson(stdout);
  }

  private params(p: Record<string, string | number | readonly string[] | undefined>): string[] {
    const out: string[] = [];
    for (const [k, v] of Object.entries(p)) {
      if (v === undefined || v === '') continue;
      for (const one of Array.isArray(v) ? v : [v]) out.push(`--${k}`, String(one));
    }
    return out;
  }

  /** `generate create <model> … --wait`: one finished job. */
  async create(model: string, p: Record<string, string | number | readonly string[] | undefined>): Promise<CliJob> {
    const job = readJob(await this.run(['generate', 'create', model, ...this.params(p), '--wait']));
    if (job.status && /fail|error|nsfw|cancel/i.test(job.status)) throw new Error(`higgsfield ${model}: job ${job.jobId} ${job.status}`);
    if (!job.url) throw new Error(`higgsfield ${model}: job ${job.jobId || '?'} returned no result URL`);
    return job;
  }

  async createSoulId(req: { name: string; referenceImageUrls: readonly string[]; prompts?: readonly string[] }) {
    // Soul ID trains on face photos; without references, the character sheet is generated from the look prompts first.
    let credits = 0;
    const images = [...req.referenceImageUrls];
    for (const prompt of images.length ? [] : (req.prompts ?? []).slice(0, 5)) {
      const still = await this.create(this.models.soul, { prompt: prompt.slice(0, 3500), aspect_ratio: '9:16', resolution: GEN_RESOLUTION });
      credits += still.credits;
      images.push(still.url!);
    }
    if (!images.length) throw new Error('Soul ID needs reference images or look prompts');
    const job = readJob(await this.run(['soul-id', 'create', '--name', req.name.slice(0, 60), ...this.params({ image: images }), '--wait']));
    if (!job.jobId) throw new Error('higgsfield soul-id create returned no id');
    return { soulId: job.jobId, credits: credits + job.credits };
  }

  async generateStill(req: { soulId?: string; prompt: string; aspect?: MediaAspect; model?: string; referenceImageUrls?: readonly string[]; resolution?: MediaResolution }): Promise<MediaResult> {
    const aspect = req.aspect ?? '9:16';
    const job = await this.create(req.model ?? (req.soulId ? this.models.soul : this.models.still), {
      prompt: req.prompt.slice(0, 3500),
      aspect_ratio: aspect,
      resolution: req.resolution ?? GEN_RESOLUTION,
      soul_id: req.soulId,
      image: req.referenceImageUrls,
    });
    const [w, h] = ASPECT_SIZE[aspect];
    return { jobId: job.jobId, url: job.url!, width: job.width ?? w, height: job.height ?? h, credits: job.credits };
  }

  async imageToVideo(req: { imageUrl: string; prompt: string; durationS: number; model?: string; resolution?: MediaResolution; aspect?: MediaAspect }): Promise<MediaResult> {
    const models = req.model ? [req.model] : [this.models.activity, ...this.models.activityFallback];
    let last: unknown;
    for (const model of models) {
      try {
        const job = await this.create(model, { image: req.imageUrl, prompt: req.prompt.slice(0, 2000), duration: req.durationS, resolution: req.resolution ?? GEN_RESOLUTION, aspect_ratio: req.aspect ?? '9:16' });
        return { jobId: job.jobId, url: job.url!, width: job.width ?? 720, height: job.height ?? 1280, durationS: job.durationS ?? req.durationS, credits: job.credits };
      } catch (err) {
        last = err; // Kling 3.0 Turbo → Kling → Wan
      }
    }
    throw last instanceof Error ? last : new Error('image-to-video failed');
  }

  async talkingWithAudio(req: { imageUrl: string; audioUrl: string; resolution?: MediaResolution; durationS?: number; model?: string; prompt?: string }): Promise<MediaResult> {
    if (req.durationS !== undefined && req.durationS > TALK_CLIP_MAX_S + 0.5) throw new Error(`talking clip is ${req.durationS} s: split the voice track into clips of ${TALK_CLIP_MAX_S} s or less`);
    const job = await this.create(req.model ?? this.models.talking, {
      image: req.imageUrl,
      audio: req.audioUrl,
      prompt: req.prompt?.slice(0, 1000),
      resolution: req.resolution ?? GEN_RESOLUTION,
      duration: req.durationS === undefined ? undefined : Math.ceil(req.durationS),
    });
    return { jobId: job.jobId, url: job.url!, width: job.width ?? 720, height: job.height ?? 1280, durationS: job.durationS ?? req.durationS, credits: job.credits };
  }

  async costProbe(req: { operation: HiggsfieldOperation; durationS?: number; model?: string; resolution?: MediaResolution }) {
    const model = req.model ?? (req.operation === 'talking_with_audio' ? this.models.talking : req.operation === 'image_to_video' ? this.models.activity : this.models.soul);
    const args =
      req.operation === 'soul_id'
        ? ['soul-id', 'cost']
        : ['generate', 'cost', model, ...this.params({ prompt: 'cost probe', resolution: req.resolution ?? GEN_RESOLUTION, duration: req.operation === 'still' ? undefined : req.durationS })];
    return { credits: readJob(await this.run(args)).credits };
  }

  async upload(req: { filePath: string; contentType?: string }) {
    const url = find(await this.run(['upload', req.filePath]), ['url', 'public_url', 'file_url'], isUrl);
    if (typeof url !== 'string') throw new Error('higgsfield upload returned no URL');
    return { url };
  }
}

/** The talking provider on Higgsfield Seedance (the default; fal Kling AI Avatar v2 is the pluggable fallback). */
export class HiggsfieldSeedanceTalking implements TalkingProvider {
  readonly name = 'higgsfield-seedance' as const;
  constructor(private readonly hf: ImageVideoProvider) {}
  async render(req: { imageUrl: string; audioUrl: string; durationS: number; resolution?: import('@ios/providers').MediaResolution; prompt?: string }) {
    const r = await this.hf.talkingWithAudio({ imageUrl: req.imageUrl, audioUrl: req.audioUrl, durationS: req.durationS, resolution: req.resolution ?? GEN_RESOLUTION, prompt: req.prompt });
    return { jobId: r.jobId, url: r.url, durationS: r.durationS ?? req.durationS, credits: r.credits, costUsd: 0 };
  }
}

/**
 * Higgsfield TTS (the voice option beside ElevenLabs): voices are Higgsfield presets, so `designVoice` maps the
 * description to a preset id. Billed in Higgsfield credits (reported as costUsd 0; credits are on the generation).
 */
export class HiggsfieldTtsVoice implements VoiceProvider {
  readonly name = 'higgsfield-tts';
  constructor(private readonly hf: HiggsfieldCli) {}
  async designVoice(req: { description: string }) {
    const d = req.description.toLowerCase();
    const voiceId = /\b(male|man|he|him|butler|gentleman)\b/.test(d) ? (/\b(old|elder|72|older|senior)\b/.test(d) ? 'mature_male' : 'warm_male') : /\b(old|elder|older|senior)\b/.test(d) ? 'mature_female' : 'warm_female';
    return { voiceId };
  }
  async tts(req: { voiceId: string; text: string; modelId?: string }) {
    const job = await this.hf.create(req.modelId ?? this.hf.models.tts, { text: req.text.slice(0, 5000), voice: req.voiceId });
    const words = req.text.trim().split(/\s+/).filter(Boolean).length;
    return { url: job.url!, durationS: job.durationS ?? Math.max(1, Math.round((words / 155) * 60)), characters: req.text.length, costUsd: 0 };
  }
}
