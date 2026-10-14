import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type {
  EmailProvider,
  HiggsfieldOperation,
  ImageVideoProvider,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  MediaResult,
  ModelTier,
  Platform,
  Providers,
  PublishProvider,
  PublishRequest,
  ResearchProvider,
  StoreEvent,
  StoreProduct,
  StoreProvider,
  TalkingProvider,
  VoiceProvider,
} from './types';

/**
 * Deterministic fakes: same inputs → same outputs, realistic shapes, no network. Each records its calls in
 * `calls` so tests can assert what was (or was not) sent.
 */
export interface RecordedCall {
  readonly method: string;
  readonly args: unknown;
}

abstract class Recorder {
  readonly calls: RecordedCall[] = [];
  #seq = 0;
  protected record(method: string, args: unknown): string {
    this.calls.push({ method, args });
    this.#seq += 1;
    return shortHash(`${this.constructor.name}:${method}:${this.#seq}:${stableStringify(args)}`);
  }
  callsTo(method: string): RecordedCall[] {
    return this.calls.filter((c) => c.method === method);
  }
  reset(): void {
    this.calls.length = 0;
    this.#seq = 0;
  }
}

export function shortHash(s: string, len = 12): string {
  return createHash('sha256').update(s).digest('hex').slice(0, len);
}

function stableStringify(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === 'object' && !Array.isArray(val) && !(val instanceof Date)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : val,
  );
}

// ─── LLM ───

/** USD per million tokens (input, output), by tier. Mirrors the PRD §7.2 tiering; exact prices land in IOS-2. */
export const LLM_PRICES: Readonly<Record<ModelTier, { model: string; inPerM: number; outPerM: number }>> = {
  fast: { model: 'claude-haiku-5-5', inPerM: 1, outPerM: 5 },
  standard: { model: 'claude-sonnet-5-5', inPerM: 3, outPerM: 15 },
  strong: { model: 'claude-opus-5-5', inPerM: 5, outPerM: 25 },
};

export const estimateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

export function llmCostUsd(tier: ModelTier, inputTokens: number, outputTokens: number): number {
  const p = LLM_PRICES[tier];
  return Math.round(((inputTokens * p.inPerM + outputTokens * p.outPerM) / 1_000_000) * 1e6) / 1e6;
}

export class FakeLlm extends Recorder implements LlmProvider {
  readonly name = 'fake-llm';
  constructor(private readonly responder?: (req: LlmRequest) => string) {
    super();
  }
  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.record('complete', req);
    const last = req.messages.at(-1)?.content ?? '';
    const text = this.responder?.(req) ?? `[${req.tier}] Noted: ${last.slice(0, 160)}`;
    const inputTokens = estimateTokens((req.system ?? '') + req.messages.map((m) => m.content).join('\n'));
    const outputTokens = estimateTokens(text);
    return {
      text,
      model: `fake:${LLM_PRICES[req.tier].model}`,
      inputTokens,
      outputTokens,
      costUsd: llmCostUsd(req.tier, inputTokens, outputTokens),
    };
  }
}

// ─── Higgsfield ───

export const HIGGSFIELD_CREDITS = {
  soul_id: 40,
  still: 2,
  /** per started 5 s */
  image_to_video: 6,
  /** per started 10 s at 720p */
  talking_with_audio: 30,
} as const satisfies Record<HiggsfieldOperation, number>;

export function higgsfieldCredits(op: HiggsfieldOperation, durationS = 5): number {
  if (op === 'image_to_video') return HIGGSFIELD_CREDITS.image_to_video * Math.ceil(durationS / 5);
  if (op === 'talking_with_audio') return HIGGSFIELD_CREDITS.talking_with_audio * Math.ceil(durationS / 10);
  return HIGGSFIELD_CREDITS[op];
}

export class FakeHiggsfield extends Recorder implements ImageVideoProvider {
  readonly name = 'fake-higgsfield';
  async createSoulId(req: { name: string; referenceImageUrls: readonly string[] }) {
    const id = this.record('createSoulId', req);
    return { soulId: `soul_${id}`, credits: higgsfieldCredits('soul_id') };
  }
  async generateStill(req: { soulId?: string; prompt: string; aspect?: '9:16' | '1:1' | '4:5' }): Promise<MediaResult> {
    const id = this.record('generateStill', req);
    const [w, h] = req.aspect === '1:1' ? [1080, 1080] : req.aspect === '4:5' ? [1080, 1350] : [1080, 1920];
    return { jobId: `hf_${id}`, url: `https://fake.higgsfield.local/stills/${id}.png`, width: w, height: h, credits: higgsfieldCredits('still') };
  }
  async imageToVideo(req: { imageUrl: string; prompt: string; durationS: number; model?: string }): Promise<MediaResult> {
    const id = this.record('imageToVideo', req);
    return {
      jobId: `hf_${id}`,
      url: `https://fake.higgsfield.local/clips/${id}.mp4`,
      width: 1080,
      height: 1920,
      durationS: req.durationS,
      credits: higgsfieldCredits('image_to_video', req.durationS),
    };
  }
  async talkingWithAudio(req: { imageUrl: string; audioUrl: string; resolution?: '720p' | '1080p'; durationS?: number }): Promise<MediaResult> {
    const id = this.record('talkingWithAudio', req);
    const durationS = req.durationS ?? 30;
    return {
      jobId: `hf_${id}`,
      url: `https://fake.higgsfield.local/talking/${id}.mp4`,
      width: 720,
      height: 1280,
      durationS,
      credits: higgsfieldCredits('talking_with_audio', durationS),
    };
  }
  async costProbe(req: { operation: HiggsfieldOperation; durationS?: number }) {
    this.record('costProbe', req);
    return { credits: higgsfieldCredits(req.operation, req.durationS) };
  }
}

// ─── Talking (pluggable) ───

export class FakeTalking extends Recorder implements TalkingProvider {
  constructor(readonly name: TalkingProvider['name'] = 'fal-kling-avatar') {
    super();
  }
  async render(req: { imageUrl: string; audioUrl: string; durationS: number }) {
    const id = this.record('render', req);
    const viaFal = this.name === 'fal-kling-avatar';
    return {
      jobId: `talk_${id}`,
      url: `https://fake.${viaFal ? 'fal' : 'higgsfield'}.local/talking/${id}.mp4`,
      durationS: req.durationS,
      credits: viaFal ? 0 : higgsfieldCredits('talking_with_audio', req.durationS),
      costUsd: viaFal ? Math.round(req.durationS * 0.0562 * 100) / 100 : 0,
    };
  }
}

// ─── Voice ───

export class FakeVoice extends Recorder implements VoiceProvider {
  readonly name = 'fake-elevenlabs';
  async designVoice(req: { description: string }) {
    const id = this.record('designVoice', req);
    return { voiceId: `voice_${id}` };
  }
  async tts(req: { voiceId: string; text: string }) {
    const id = this.record('tts', req);
    const words = req.text.trim().split(/\s+/).filter(Boolean).length;
    return {
      url: `https://fake.elevenlabs.local/audio/${id}.mp3`,
      durationS: Math.max(1, Math.round((words / 150) * 60)),
      characters: req.text.length,
      costUsd: Math.round(req.text.length * 0.00018 * 10000) / 10000,
    };
  }
}

// ─── Publish (Zernio) ───

interface FakePost {
  req: PublishRequest;
  status: 'scheduled' | 'live' | 'failed';
}

export class FakeZernio extends Recorder implements PublishProvider {
  readonly name = 'fake-zernio';
  readonly posts = new Map<string, FakePost>();
  /** Set to make the next N publish calls throw (for retry tests). */
  failNext = 0;

  private guard(req: PublishRequest): void {
    // The type already forces `true`; this catches untyped callers.
    if (req.aiLabel !== true) throw new Error('AI label is required on every post');
  }
  async schedule(req: PublishRequest) {
    this.guard(req);
    const id = this.record('schedule', req);
    this.posts.set(id, { req, status: 'scheduled' });
    return { externalId: id, status: 'scheduled' as const };
  }
  /** idempotencyKey → externalId of the post it created. */
  private readonly byKey = new Map<string, string>();
  async publish(req: PublishRequest) {
    this.guard(req);
    const seen = req.idempotencyKey ? this.byKey.get(req.idempotencyKey) : undefined;
    if (seen) return { externalId: seen, status: 'published' as const };
    if (this.failNext > 0) {
      this.failNext -= 1;
      this.record('publish:failed', req);
      throw new Error('fake zernio: upstream 503');
    }
    const id = this.record('publish', req);
    this.posts.set(id, { req, status: 'live' });
    if (req.idempotencyKey) this.byKey.set(req.idempotencyKey, id);
    return { externalId: id, status: 'published' as const };
  }
  async verify(externalId: string) {
    this.record('verify', { externalId });
    const p = this.posts.get(externalId);
    if (!p) return { status: 'failed' as const, url: null, aiLabel: false };
    return {
      status: p.status === 'live' ? ('live' as const) : ('processing' as const),
      url: p.status === 'live' ? `https://fake.${p.req.platform}.local/p/${externalId}` : null,
      aiLabel: p.req.aiLabel,
    };
  }
  async listComments(externalId: string) {
    this.record('listComments', { externalId });
    return [
      { id: `c_${shortHash(externalId + '1')}`, authorRef: 'user_a', text: 'Where can I get the template?', at: new Date(0) },
      { id: `c_${shortHash(externalId + '2')}`, authorRef: 'user_b', text: 'This helped, thanks!', at: new Date(0) },
    ];
  }
  async replyToComment(req: { externalId: string; commentId: string; text: string }) {
    return { id: `r_${this.record('replyToComment', req)}` };
  }
  async sendDm(req: { accountRef: string; userRef: string; text: string }) {
    return { id: `dm_${this.record('sendDm', req)}` };
  }
}

// ─── Store (Lemon Squeezy) ───

export const FAKE_WEBHOOK_SECRET = 'fake-webhook-secret';

export class FakeLemonSqueezy extends Recorder implements StoreProvider {
  readonly name = 'fake-lemonsqueezy';
  constructor(
    readonly products: StoreProduct[] = [],
    private readonly webhookSecret = FAKE_WEBHOOK_SECRET,
  ) {
    super();
  }
  async listProducts() {
    this.record('listProducts', {});
    return [...this.products];
  }
  async getProduct(id: string) {
    this.record('getProduct', { id });
    return this.products.find((p) => p.id === id) ?? null;
  }
  sign(rawBody: string): string {
    return createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
  }
  verifyWebhook(rawBody: string, signature: string): boolean {
    const expected = Buffer.from(this.sign(rawBody), 'hex');
    const got = Buffer.from(signature, 'hex');
    return expected.length === got.length && timingSafeEqual(expected, got);
  }
  parseWebhook(rawBody: string): StoreEvent {
    return JSON.parse(rawBody) as StoreEvent;
  }
}

// ─── Email (Resend) ───

export class FakeResend extends Recorder implements EmailProvider {
  readonly name = 'fake-resend';
  async send(req: { from: string; to: string; subject: string; html: string; tags?: Record<string, string> }) {
    return { id: `em_${this.record('send', req)}` };
  }
}

// ─── Research (Apify) ───

export class FakeApify extends Recorder implements ResearchProvider {
  readonly name = 'fake-apify';
  async runActor(req: { actor: string; input: Record<string, unknown> }) {
    const id = this.record('runActor', req);
    return { runId: `run_${id}`, items: [{ actor: req.actor, sample: true }] };
  }
  async topPosts(req: { niche: string; platform: Platform; limit?: number }) {
    const id = this.record('topPosts', req);
    const hooks = ['Nobody tells you this about', 'I tried this for 30 days:', 'Stop doing this if you want', 'The 3-step fix for'];
    return Array.from({ length: req.limit ?? 5 }, (_, i) => ({
      url: `https://fake.${req.platform}.local/top/${id}-${i}`,
      hook: `${hooks[i % hooks.length]} ${req.niche}`,
      format: i % 2 === 0 ? 'talking' : 'carousel',
      views: 250_000 - i * 31_000,
      postedAt: new Date(Date.UTC(2026, 9, 1 + i)),
    }));
  }
}

export interface FakeProviders extends Providers {
  readonly llm: FakeLlm;
  readonly imageVideo: FakeHiggsfield;
  readonly talking: FakeTalking;
  readonly voice: FakeVoice;
  readonly publish: FakeZernio;
  readonly store: FakeLemonSqueezy;
  readonly email: FakeResend;
  readonly research: FakeApify;
}

export function createFakeProviders(opts: { talking?: TalkingProvider['name']; llmResponder?: (req: LlmRequest) => string } = {}): FakeProviders {
  return {
    llm: new FakeLlm(opts.llmResponder),
    imageVideo: new FakeHiggsfield(),
    talking: new FakeTalking(opts.talking ?? 'fal-kling-avatar'),
    voice: new FakeVoice(),
    publish: new FakeZernio(),
    store: new FakeLemonSqueezy(),
    email: new FakeResend(),
    research: new FakeApify(),
  };
}
