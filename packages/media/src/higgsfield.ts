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

/** A CLI error. `timedOut`: the CLI was killed after the timeout (a submitted job may still be running and billing). */
export class HiggsfieldCliError extends Error {
  override readonly name = 'HiggsfieldCliError';
  constructor(
    message: string,
    readonly timedOut = false,
  ) {
    super(message);
  }
}

export const execCli: Exec = (bin, args, opts) =>
  new Promise((resolve, reject) =>
    execFile(bin, [...args], { env: opts.env as unknown as NodeJS.ProcessEnv, timeout: opts.timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        const code = (err as NodeJS.ErrnoException).code;
        const killed = (err as { killed?: boolean }).killed === true || !!(err as { signal?: string | null }).signal;
        if (code === 'ENOENT') reject(new Error(`Higgsfield CLI not found (${bin}): install it with \`npm i -g @higgsfield/cli\` or set HIGGSFIELD_CLI`));
        else reject(new HiggsfieldCliError(`higgsfield ${args[0] ?? ''} ${args[1] ?? ''} ${killed ? 'timed out' : 'failed'}: ${String(stderr || err.message).split('\n').slice(-4).join(' | ').slice(0, 400)}`, killed));
      } else resolve({ stdout, stderr });
    }),
  );

/**
 * An error raised before any job was submitted (unknown model, bad parameters): safe to try the next model. Anything
 * else (a job that ran and failed, a timeout after submission) may have been billed, so it is never retried on another
 * model under the same reservation.
 */
export function isPreSubmissionError(err: unknown): boolean {
  if (err instanceof HiggsfieldCliError && err.timedOut) return false;
  const m = err instanceof Error ? err.message : String(err);
  if (/\bjob\b/i.test(m)) return false;
  return /unknown model|model not found|no such model|not a valid model|invalid (?:argument|parameter|option|value)|validation|unsupported (?:model|parameter|option|resolution|duration)|usage:/i.test(m);
}

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
  /** Credits the job reported; null when the output carries no cost field for the job (unknown, never free). */
  readonly credits: number | null;
  readonly status: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationS: number | null;
}

const CREDIT_KEYS = ['credits_used', 'credits_charged', 'credit_cost', 'credits', 'cost', 'price', 'total_cost'] as const;
const asObj = (x: unknown): Record<string, unknown> | null => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : null);

/** The job record in the CLI output: `job` / `data` / `generation` / `result` when present, else the top level. */
function jobRecord(v: unknown): Record<string, unknown> {
  const top = asObj(v) ?? {};
  for (const k of ['job', 'data', 'generation', 'result']) {
    const o = asObj(top[k]);
    if (o) return o;
  }
  return top;
}

/**
 * The job's cost, read only from the job record and the top level (and their `usage` / `billing` objects), never
 * from anywhere else in the document: an account balance nested in the output must never be billed as the job cost.
 */
export function jobCredits(v: unknown): number | null {
  const top = asObj(v) ?? {};
  const job = jobRecord(v);
  for (const o of [job, asObj(job.usage), asObj(job.billing), top, asObj(top.usage), asObj(top.billing)]) {
    if (!o) continue;
    for (const k of CREDIT_KEYS) if (k in o && isNum(o[k])) return Number(o[k]);
  }
  return null;
}

export function readJob(v: unknown): CliJob {
  const id = find(v, ['job_id', 'jobId', 'id', 'request_id', 'reference_id'], (x) => typeof x === 'string' || typeof x === 'number');
  const url = find(v, ['url', 'result_url', 'output_url', 'video_url', 'image_url', 'raw', 'min'], isUrl);
  const credits = jobCredits(v);
  const status = find(v, ['status', 'state'], (x) => typeof x === 'string');
  const num = (keys: string[]) => {
    const n = find(v, keys, isNum);
    return n === undefined ? null : Number(n);
  };
  return {
    jobId: id === undefined ? '' : String(id),
    url: (url as string | undefined) ?? null,
    credits,
    status: (status as string | undefined) ?? null,
    width: num(['width']),
    height: num(['height']),
    durationS: num(['duration', 'duration_s', 'durationS']),
  };
}

/** What a paid job reports: its credits, or 0 + creditsUnknown when the CLI reported none (or 0). */
export function paidCredits(job: Pick<CliJob, 'credits'>): { credits: number; creditsUnknown?: true } {
  return job.credits !== null && job.credits > 0 ? { credits: job.credits } : { credits: 0, creditsUnknown: true };
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
    let out: unknown;
    try {
      out = await this.run(['generate', 'create', model, ...this.params(p), '--wait']);
    } catch (err) {
      // Killed while waiting: the job was submitted and keeps running (and billing). The caller's hold is debited at
      // the estimate instead of released, so a retry that buys it again still counts against the caps.
      if (err instanceof HiggsfieldCliError && err.timedOut) Object.assign(err, { settleAtEstimate: true });
      throw err;
    }
    const job = readJob(out);
    if (job.status && /fail|error|nsfw|cancel/i.test(job.status)) throw new Error(`higgsfield ${model}: job ${job.jobId} ${job.status}`);
    if (!job.url) throw new Error(`higgsfield ${model}: job ${job.jobId || '?'} returned no result URL`);
    return job;
  }

  async createSoulId(req: { name: string; referenceImageUrls: readonly string[]; prompts?: readonly string[] }) {
    // Soul ID trains on face photos; without references, the character sheet is generated from the look prompts first.
    let credits = 0;
    let unknown = false;
    const images = [...req.referenceImageUrls];
    try {
      for (const prompt of images.length ? [] : (req.prompts ?? []).slice(0, 5)) {
        const still = await this.create(this.models.soul, { prompt: prompt.slice(0, 3500), aspect_ratio: '9:16', resolution: GEN_RESOLUTION });
        if (still.credits !== null && still.credits > 0) credits += still.credits;
        else unknown = true;
        images.push(still.url!);
      }
      if (!images.length) throw new Error('Soul ID needs reference images or look prompts');
      const job = readJob(await this.run(['soul-id', 'create', '--name', req.name.slice(0, 60), ...this.params({ image: images }), '--wait']));
      if (!job.jobId) throw new Error('higgsfield soul-id create returned no id');
      if (job.credits !== null && job.credits > 0) credits += job.credits;
      else unknown = true;
      return unknown ? { soulId: job.jobId, credits, creditsUnknown: true } : { soulId: job.jobId, credits };
    } catch (err) {
      // The stills bought before the failure were spent: the governor debits them (err.credits), or the estimate when
      // a cost went unreported.
      if (err && typeof err === 'object') Object.assign(err, { credits, ...(unknown ? { settleAtEstimate: true } : {}) });
      throw err;
    }
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
    return { jobId: job.jobId, url: job.url!, width: job.width ?? w, height: job.height ?? h, ...paidCredits(job) };
  }

  async imageToVideo(req: { imageUrl: string; prompt: string; durationS: number; model?: string; resolution?: MediaResolution; aspect?: MediaAspect }): Promise<MediaResult> {
    const models = req.model ? [req.model] : [this.models.activity, ...this.models.activityFallback];
    let last: unknown;
    for (const model of models) {
      try {
        const job = await this.create(model, { image: req.imageUrl, prompt: req.prompt.slice(0, 2000), duration: req.durationS, resolution: req.resolution ?? GEN_RESOLUTION, aspect_ratio: req.aspect ?? '9:16' });
        return { jobId: job.jobId, url: job.url!, width: job.width ?? 720, height: job.height ?? 1280, durationS: job.durationS ?? req.durationS, ...paidCredits(job) };
      } catch (err) {
        // Kling 3.0 Turbo → Kling → Wan, but only when nothing was submitted (one reservation covers one job): a job
        // that ran and failed, or a timeout, is not bought again on another model.
        if (!isPreSubmissionError(err)) throw err;
        last = err;
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
    return { jobId: job.jobId, url: job.url!, width: job.width ?? 720, height: job.height ?? 1280, durationS: job.durationS ?? req.durationS, ...paidCredits(job) };
  }

  async costProbe(req: { operation: HiggsfieldOperation; durationS?: number; model?: string; resolution?: MediaResolution }) {
    const model = req.model ?? (req.operation === 'talking_with_audio' ? this.models.talking : req.operation === 'image_to_video' ? this.models.activity : this.models.soul);
    const args =
      req.operation === 'soul_id'
        ? ['soul-id', 'cost']
        : ['generate', 'cost', model, ...this.params({ prompt: 'cost probe', resolution: req.resolution ?? GEN_RESOLUTION, duration: req.operation === 'still' ? undefined : req.durationS })];
    // 0 = the probe reported no price; probePrices never stores that.
    return { credits: readJob(await this.run(args)).credits ?? 0 };
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
    return { jobId: r.jobId, url: r.url, durationS: r.durationS ?? req.durationS, credits: r.credits, costUsd: 0, ...(r.creditsUnknown ? { creditsUnknown: true } : {}) };
  }
}

/**
 * Higgsfield TTS (the voice option beside ElevenLabs): voices are Higgsfield presets, so `designVoice` maps the
 * description to a preset id. Billed in Higgsfield credits: costUsd is 0 and `credits` carries the cost, which the
 * renderer settles through the governor in hf_credits.
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
    return { url: job.url!, durationS: job.durationS ?? Math.max(1, Math.round((words / 155) * 60)), characters: req.text.length, costUsd: 0, ...paidCredits(job) };
  }
}
