import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { MemoryMediaStore } from './storage';
import {
  type AudienceProvider,
  type DistributionEvent,
  type DmMessage,
  EMBEDDING_DIM,
  type EmailProvider,
  type EmailWebhookEvent,
  type EmbeddingProvider,
  type FeedItem,
  type FeedProvider,
  type FieldMap,
  type HiggsfieldOperation,
  type ImageVideoProvider,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  type MediaAspect,
  type MediaResolution,
  type MediaResult,
  type ModelTier,
  type Platform,
  type PostMetrics,
  type Providers,
  type PublishAccount,
  type PublishComment,
  type PublishProvider,
  type PublishRequest,
  type ResearchProvider,
  type StoreEvent,
  type StoreInfo,
  type StoreProduct,
  type StoreProvider,
  type TalkingProvider,
  type TopicResearch,
  type TranscribeProvider,
  type VoiceProvider,
  type WebResearchProvider,
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

/**
 * Model routing by tier (PRD §8.4) and USD per million tokens: Anthropic list prices, Oct 2026. Cache writes bill
 * at 1.25x input and cache reads at the cache-read rate. The single source of model ids for every stream.
 */
export const LLM_PRICES: Readonly<
  Record<ModelTier, { model: string; inPerM: number; outPerM: number; cacheReadPerM: number; cacheWritePerM: number }>
> = {
  fast: { model: 'claude-haiku-5-5', inPerM: 0.1, outPerM: 0.5, cacheReadPerM: 0.01, cacheWritePerM: 0.125 },
  standard: { model: 'claude-sonnet-5-5', inPerM: 2, outPerM: 10, cacheReadPerM: 0.2, cacheWritePerM: 2.5 },
  strong: { model: 'claude-opus-5-5', inPerM: 4, outPerM: 20, cacheReadPerM: 0.2, cacheWritePerM: 5 },
};

export const estimateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

/** `inputTokens` excludes cached tokens; pass cache reads and writes separately when the API reports them. */
export function llmCostUsd(tier: ModelTier, inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0): number {
  const p = LLM_PRICES[tier];
  const micros = inputTokens * p.inPerM + outputTokens * p.outPerM + cacheReadTokens * p.cacheReadPerM + cacheWriteTokens * p.cacheWritePerM;
  return Math.round((micros / 1_000_000) * 1e6) / 1e6;
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
    const inputTokens = estimateTokens(
      (req.cached ?? []).map((b) => b.text).join('\n') + (req.system ?? '') + req.messages.map((m) => m.content).join('\n'),
    );
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
  async createSoulId(req: { name: string; referenceImageUrls: readonly string[]; prompts?: readonly string[] }) {
    const id = this.record('createSoulId', req);
    return { soulId: `soul_${id}`, credits: higgsfieldCredits('soul_id') };
  }
  async generateStill(req: { soulId?: string; prompt: string; aspect?: MediaAspect; model?: string; referenceImageUrls?: readonly string[]; resolution?: MediaResolution }): Promise<MediaResult> {
    const id = this.record('generateStill', req);
    const [w, h] = req.aspect === '1:1' ? [1080, 1080] : req.aspect === '4:5' ? [1080, 1350] : [1080, 1920];
    return { jobId: `hf_${id}`, url: `https://fake.higgsfield.local/stills/${id}.png`, width: w, height: h, credits: higgsfieldCredits('still') };
  }
  async imageToVideo(req: { imageUrl: string; prompt: string; durationS: number; model?: string; resolution?: MediaResolution; aspect?: MediaAspect }): Promise<MediaResult> {
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
  async talkingWithAudio(req: { imageUrl: string; audioUrl: string; resolution?: MediaResolution; durationS?: number; model?: string; prompt?: string }): Promise<MediaResult> {
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
  async costProbe(req: { operation: HiggsfieldOperation; durationS?: number; model?: string; resolution?: MediaResolution }) {
    this.record('costProbe', req);
    return { credits: higgsfieldCredits(req.operation, req.durationS) };
  }
  async upload(req: { filePath: string; contentType?: string }) {
    const id = this.record('upload', req);
    return { url: `https://fake.higgsfield.local/uploads/${id}` };
  }
}

// ─── Talking (pluggable) ───

export class FakeTalking extends Recorder implements TalkingProvider {
  constructor(readonly name: TalkingProvider['name'] = 'fal-kling-avatar') {
    super();
  }
  async render(req: { imageUrl: string; audioUrl: string; durationS: number; resolution?: MediaResolution; prompt?: string }) {
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
  readonly #spoken = new Map<string, string>();
  /** The text a fake audio URL was synthesised from (FakeTranscriber reads it back). */
  textFor(url: string): string | null {
    return this.#spoken.get(url) ?? null;
  }
  async designVoice(req: { description: string }) {
    const id = this.record('designVoice', req);
    return { voiceId: `voice_${id}` };
  }
  async tts(req: { voiceId: string; text: string; modelId?: string }) {
    const id = this.record('tts', req);
    const words = req.text.trim().split(/\s+/).filter(Boolean).length;
    const url = `https://fake.elevenlabs.local/audio/${id}.mp3`;
    this.#spoken.set(url, req.text);
    return {
      url,
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
  /** externalIds sent to the app inbox as drafts (draft_inbox): processing until `completeDraft`. */
  readonly drafts = new Set<string>();
  /** Comments per externalId (tests push into it). Posts without an entry get two default comments. */
  readonly comments = new Map<string, PublishComment[]>();
  /** Comment ids hidden through `hideComment`. */
  readonly hidden = new Set<string>();
  /** Metrics overrides per externalId (tests set growth); otherwise deterministic from the id. */
  readonly metrics = new Map<string, PostMetrics>();

  private guard(req: PublishRequest): void {
    // The type already forces `true`; this catches untyped callers.
    if (req.aiLabel !== true) throw new Error('AI label is required on every post');
    // Mirrors AI_FLAG_FIELDS (types.ts): an explicit platform option may only ever say true.
    const field = { tiktok: 'video_made_with_ai', instagram: 'is_ai_generated', youtube: 'containsSyntheticMedia', pinterest: 'is_ai_generated' }[req.platform];
    const opt = req.platformOptions?.[field];
    if (opt !== undefined && opt !== true) throw new Error(`refusing ${field}=${String(opt)}: the AI flag is always on`);
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
    if (seen) return { externalId: seen, status: this.drafts.has(seen) ? ('processing' as const) : ('published' as const) };
    if (this.failNext > 0) {
      this.failNext -= 1;
      this.record('publish:failed', req);
      throw new Error('fake zernio: upstream 503');
    }
    const id = this.record('publish', req);
    const draft = req.mode === 'draft_inbox';
    this.posts.set(id, { req, status: draft ? 'scheduled' : 'live' });
    if (draft) this.drafts.add(id);
    if (req.idempotencyKey) this.byKey.set(req.idempotencyKey, id);
    return { externalId: id, status: draft ? ('processing' as const) : ('published' as const) };
  }
  /** Simulates the creator posting an inbox draft from the app. */
  completeDraft(externalId: string): void {
    const p = this.posts.get(externalId);
    if (!p || !this.drafts.has(externalId)) throw new Error(`no draft ${externalId}`);
    this.drafts.delete(externalId);
    this.posts.set(externalId, { req: p.req, status: 'live' });
  }
  async verify(externalId: string) {
    this.record('verify', { externalId });
    const p = this.posts.get(externalId);
    if (!p) return { status: 'failed' as const, url: null, aiLabel: false };
    if (p.status === 'failed') return { status: 'failed' as const, url: null, aiLabel: p.req.aiLabel };
    return {
      status: p.status === 'live' ? ('live' as const) : ('processing' as const),
      url: p.status === 'live' ? `https://fake.${p.req.platform}.local/p/${externalId}` : null,
      aiLabel: p.req.aiLabel,
    };
  }
  async listComments(externalId: string): Promise<PublishComment[]> {
    this.record('listComments', { externalId });
    const set = this.comments.get(externalId);
    if (set) return set.filter((c) => !this.hidden.has(c.id));
    return [
      { id: `c_${shortHash(externalId + '1')}`, authorRef: 'user_a', text: 'Where can I get the template?', at: new Date(0) },
      { id: `c_${shortHash(externalId + '2')}`, authorRef: 'user_b', text: 'This helped, thanks!', at: new Date(0) },
    ].filter((c) => !this.hidden.has(c.id));
  }
  async replyToComment(req: { externalId: string; commentId: string; text: string }) {
    return { id: `r_${this.record('replyToComment', req)}` };
  }
  async sendDm(req: { accountRef: string; userRef: string; text: string }) {
    return { id: `dm_${this.record('sendDm', req)}` };
  }
  // IOS-4 (stream F owns this fake's behaviour)
  async uploadMedia(req: { filePath: string; contentType: string }) {
    return { mediaUrl: `https://fake.zernio.local/media/${this.record('uploadMedia', req)}` };
  }
  async hideComment(req: { externalId: string; commentId: string }) {
    this.record('hideComment', req);
    this.hidden.add(req.commentId);
    return { ok: true };
  }
  /** DMs the fake inbox returns (tests push into it). */
  readonly inbox: DmMessage[] = [];
  async listDms(req: { accountRef: string; since?: Date }): Promise<DmMessage[]> {
    this.record('listDms', req);
    return this.inbox.filter((m) => !req.since || m.at >= req.since);
  }
  async fetchMetrics(req: { externalId: string; platform: Platform }): Promise<PostMetrics> {
    this.record('fetchMetrics', req);
    const set = this.metrics.get(req.externalId);
    if (set) return { ...set };
    const n = parseInt(shortHash(req.externalId, 6), 16);
    const views = 500 + (n % 20_000);
    return {
      views,
      watchTimeS: Math.round(views * 6.5),
      likes: Math.round(views * 0.06),
      comments: Math.round(views * 0.004),
      saves: Math.round(views * 0.012),
      shares: Math.round(views * 0.008),
      follows: Math.round(views * 0.003),
      profileVisits: Math.round(views * 0.02),
      linkClicks: Math.round(views * 0.002),
    };
  }
  /** Accounts the fake vendor has connected (tests push into it). */
  readonly accounts: PublishAccount[] = [];
  async listAccounts(): Promise<PublishAccount[]> {
    this.record('listAccounts', {});
    return [...this.accounts];
  }
  sign(rawBody: string): string {
    return createHmac('sha256', FAKE_WEBHOOK_SECRET).update(rawBody).digest('hex');
  }
  verifyWebhook(rawBody: string, signature: string): boolean {
    return safeEqualHex(this.sign(rawBody), signature);
  }
  parseWebhook(rawBody: string): DistributionEvent[] {
    const v = JSON.parse(rawBody, (k, val) => (k === 'at' && typeof val === 'string' ? new Date(val) : val)) as DistributionEvent | DistributionEvent[];
    return Array.isArray(v) ? v : [v];
  }
}

function safeEqualHex(expectedHex: string, gotHex: string): boolean {
  const expected = Buffer.from(expectedHex, 'hex');
  const got = Buffer.from(/^[0-9a-f]*$/i.test(gotHex) ? gotHex : '', 'hex');
  return expected.length === got.length && timingSafeEqual(expected, got);
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
  async listProducts(req: { storeId?: string } = {}) {
    this.record('listProducts', req);
    return this.products.filter((p) => !req.storeId || !p.storeId || p.storeId === req.storeId);
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
  // IOS-4 (stream G owns this fake's behaviour)
  readonly stores: StoreInfo[] = [];
  async listStores(): Promise<StoreInfo[]> {
    this.record('listStores', {});
    return [...this.stores];
  }
  async createCheckout(req: { storeId: string; variantId: string; customData?: Readonly<Record<string, string>>; discountCode?: string }) {
    const id = this.record('createCheckout', req);
    return { url: `https://fake.lemonsqueezy.local/checkout/${id}` };
  }
  async createDiscount(req: { storeId: string; code: string; percent: number; productIds?: readonly string[]; expiresAt?: Date | null }) {
    const id = this.record('createDiscount', req);
    return { id: `disc_${id}`, code: req.code };
  }
}

// ─── Email (Resend) ───

export class FakeResend extends Recorder implements EmailProvider {
  readonly name = 'fake-resend';
  async send(req: { from: string; to: string; subject: string; html: string; tags?: Record<string, string> }) {
    return { id: `em_${this.record('send', req)}` };
  }
}

// ─── Audience email (Resend audiences; IOS-4, stream G owns this fake's behaviour) ───

export class FakeResendAudience extends Recorder implements AudienceProvider {
  readonly name = 'fake-resend-audience';
  readonly audiences = new Map<string, string>();
  readonly contacts = new Map<string, { audienceId: string; email: string; unsubscribed: boolean }>();
  async ensureAudience(req: { name: string }) {
    this.record('ensureAudience', req);
    let id = this.audiences.get(req.name);
    if (!id) {
      id = `aud_${shortHash(req.name)}`;
      this.audiences.set(req.name, id);
    }
    return { audienceId: id };
  }
  async upsertContact(req: { audienceId: string; email: string; firstName?: string; unsubscribed?: boolean }) {
    this.record('upsertContact', { ...req, email: '[redacted]' });
    const id = `ct_${shortHash(`${req.audienceId}:${req.email.toLowerCase()}`)}`;
    this.contacts.set(id, { audienceId: req.audienceId, email: req.email, unsubscribed: req.unsubscribed ?? false });
    return { contactId: id };
  }
  async send(req: { from: string; to: string; subject: string; html: string; text?: string; replyTo?: string; headers?: Readonly<Record<string, string>>; tags?: Readonly<Record<string, string>> }) {
    return { id: `em_${this.record('send', req)}` };
  }
  async sendBroadcast(req: { audienceId: string; from: string; subject: string; html: string; name?: string }) {
    return { id: `bc_${this.record('sendBroadcast', req)}` };
  }
  /** Fake signature: `svix-signature` = hex HMAC of the body with FAKE_WEBHOOK_SECRET. */
  sign(rawBody: string): string {
    return createHmac('sha256', FAKE_WEBHOOK_SECRET).update(rawBody).digest('hex');
  }
  verifyWebhook(rawBody: string, headers: Readonly<Record<string, string | null | undefined>>): boolean {
    return safeEqualHex(this.sign(rawBody), headers['svix-signature'] ?? '');
  }
  parseWebhook(rawBody: string): EmailWebhookEvent[] {
    const v = JSON.parse(rawBody) as EmailWebhookEvent | EmailWebhookEvent[];
    return (Array.isArray(v) ? v : [v]).map((e) => ({ ...e, at: new Date(e.at) }));
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

// ─── IOS-2: transcription, embeddings, web research, feeds ───

/**
 * Reads back what FakeVoice synthesised for the URL (a perfect transcript), or '' for unknown audio. Tests can
 * pass `mishear` to simulate a mispronunciation (e.g. replace a word) and exercise QC Q2.
 */
export class FakeTranscriber extends Recorder implements TranscribeProvider {
  readonly name = 'fake-whisper';
  constructor(
    private readonly lookup: (audioUrl: string) => string | null = () => null,
    private readonly mishear: (text: string) => string = (t) => t,
  ) {
    super();
  }
  async transcribe(req: { audioUrl: string; language?: 'en'; prompt?: string }) {
    this.record('transcribe', req);
    const text = this.mishear(this.lookup(req.audioUrl) ?? '');
    const tokens = text.split(/\s+/).filter(Boolean);
    const perWord = 60 / 150; // 150 wpm
    const words = tokens.map((word, i) => ({ word, startS: round3(i * perWord), endS: round3((i + 1) * perWord) }));
    const durationS = round3(tokens.length * perWord);
    return { text, words, durationS, costUsd: round3((durationS / 60) * 0.006) };
  }
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Deterministic bag-of-words embeddings: hashed tokens into EMBEDDING_DIM buckets, L2-normalised. Texts that share
 * words land close together, so retrieval tests behave sensibly without a model.
 */
export class FakeEmbeddings extends Recorder implements EmbeddingProvider {
  readonly name = 'fake-embeddings';
  readonly dimensions = EMBEDDING_DIM;
  async embed(texts: readonly string[]): Promise<number[][]> {
    this.record('embed', { count: texts.length });
    return texts.map((t) => {
      const v = new Array<number>(EMBEDDING_DIM).fill(0);
      for (const tok of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        const h = createHash('sha256').update(tok).digest();
        v[h.readUInt16BE(0) % EMBEDDING_DIM]! += h[2]! & 1 ? 1 : -1;
      }
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
  }
}

export class FakeWebResearch extends Recorder implements WebResearchProvider {
  readonly name = 'fake-web-research';
  async mapField(req: { niche: string; maxSources?: number; maxNodes?: number }): Promise<FieldMap> {
    const id = this.record('mapField', req);
    const n = req.niche;
    const levels = ['fundamental', 'intermediate', 'advanced', 'debate', 'myth', 'frontier'] as const;
    const topics = ['basics', 'habits', 'tools', 'mistakes', 'evidence', 'trends'];
    return {
      sources: Array.from({ length: Math.min(req.maxSources ?? 5, 5) }, (_, i) => ({
        name: `${n} source ${i + 1}`,
        url: `https://fake.research.local/${id}/source-${i + 1}`,
        kind: i === 0 ? 'institution' : i === 1 ? 'journal' : 'publication',
        credibility: 5 - (i % 3),
      })),
      experts: [{ name: `${n} expert`, school: 'evidence-first', why: 'widely cited', url: `https://fake.research.local/${id}/expert` }],
      curriculum: Array.from({ length: Math.min(req.maxNodes ?? 6, 6) }, (_, i) => ({
        path: `${levels[i]}/${topics[i]}`,
        title: `${n}: ${topics[i]}`,
        level: levels[i]!,
      })),
      costUsd: 0.05,
    };
  }
  async researchTopic(req: { niche: string; path: string; title: string; questions?: readonly string[]; maxSources?: number }): Promise<TopicResearch> {
    const id = this.record('researchTopic', req);
    const cite = (k: number) => ({ url: `https://fake.research.local/${id}/${k}`, title: `${req.title} (source ${k})`, quote: `A short quote about ${req.title}.` });
    return {
      synthesis: `${req.title}: a cited synthesis for ${req.niche} (fake research).`,
      facts: [
        { claim: `${req.title} works best when practised consistently.`, citations: [cite(1)] },
        { claim: `Most beginners overestimate quick results in ${req.niche}.`, citations: [cite(2)] },
      ],
      frameworks: [`The 3-step ${req.title} loop`],
      questions: req.questions?.length ? [...req.questions] : [`What is the first step in ${req.title}?`],
      sources: [cite(1), cite(2)],
      costUsd: 0.12,
    };
  }
}

export class FakeFeeds extends Recorder implements FeedProvider {
  readonly name = 'fake-feeds';
  async fetchFeed(req: { url: string; limit?: number }): Promise<FeedItem[]> {
    const id = this.record('fetchFeed', req);
    let host = 'feed';
    try {
      host = new URL(req.url).hostname;
    } catch {
      /* keep the default */
    }
    return Array.from({ length: req.limit ?? 3 }, (_, i) => ({
      title: `${host} headline ${i + 1}`,
      url: `https://fake.news.local/${id}/${i + 1}`,
      publishedAt: new Date(Date.UTC(2026, 9, 14, 6 - i)),
      summary: `Summary of headline ${i + 1} from ${host}.`,
      source: host,
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
  readonly transcribe: FakeTranscriber;
  readonly embeddings: FakeEmbeddings;
  readonly webResearch: FakeWebResearch;
  readonly feeds: FakeFeeds;
  readonly audience: FakeResendAudience;
  readonly storage: MemoryMediaStore;
}

export function createFakeProviders(
  opts: { talking?: TalkingProvider['name']; llmResponder?: (req: LlmRequest) => string; mishear?: (text: string) => string } = {},
): FakeProviders {
  const voice = new FakeVoice();
  return {
    llm: new FakeLlm(opts.llmResponder),
    imageVideo: new FakeHiggsfield(),
    talking: new FakeTalking(opts.talking ?? 'fal-kling-avatar'),
    voice,
    publish: new FakeZernio(),
    store: new FakeLemonSqueezy(),
    email: new FakeResend(),
    research: new FakeApify(),
    transcribe: new FakeTranscriber((url) => voice.textFor(url), opts.mishear),
    embeddings: new FakeEmbeddings(),
    webResearch: new FakeWebResearch(),
    feeds: new FakeFeeds(),
    audience: new FakeResendAudience(),
    storage: new MemoryMediaStore(),
  };
}
