/**
 * Provider interfaces. Every integration sits behind one of these, with a deterministic fake in `fakes.ts`.
 * Real adapters arrive in later milestones (IOS-2: LLM, research, feeds, embeddings; IOS-3: media; IOS-4: distribution
 * and money). Live adapters live in the owning stream's package (docs/IOS-2-CONTRACTS.md), not here.
 * Owner chat is internal (dashboard), so there is no chat provider.
 */

export type Platform = 'tiktok' | 'instagram' | 'youtube' | 'pinterest';
export type ModelTier = 'fast' | 'standard' | 'strong';

// ─── LLM (Anthropic Messages API / Claude Agent SDK; IOS-2 stream A owns the live adapter) ───
export interface LlmMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}
/**
 * A stable context block sent before `system` and prompt-cached (cache_control: ephemeral on the last block).
 * Use it for persona bibles, playbook summaries and skill text. `key` names the content and its version
 * (e.g. `bible:<personaId>:v3`) so the same key always carries byte-identical text; never put timestamps in it.
 */
export interface LlmCacheBlock {
  readonly key: string;
  readonly text: string;
}
export interface LlmRequest {
  readonly tier: ModelTier;
  readonly system?: string;
  /** Stable, cached prefix (IOS-2). Order from most to least stable. */
  readonly cached?: readonly LlmCacheBlock[];
  readonly messages: readonly LlmMessage[];
  readonly maxTokens?: number;
  /** Ask for a single JSON value as the whole reply (structured output in the live adapter). */
  readonly json?: boolean;
}
export interface LlmResponse {
  readonly text: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Prompt-cache reads and writes (live adapter; 0 or absent on fakes). */
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly costUsd: number;
}
export interface LlmProvider {
  readonly name: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

// ─── Higgsfield (Soul ID, stills, image-to-video, talking-with-audio, cost probe) ───
export type HiggsfieldOperation = 'soul_id' | 'still' | 'image_to_video' | 'talking_with_audio';
/** (IOS-3/4, additive) Generation resolution. The pilot renders at 720p and upscales/sharpens on export. */
export type MediaResolution = '720p' | '1080p';
export type MediaAspect = '9:16' | '1:1' | '4:5';
export interface MediaResult {
  readonly jobId: string;
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly durationS?: number;
  readonly credits: number;
  /**
   * (IOS-4 fix, additive) The vendor didn't report a cost (or reported 0) for a paid job: `credits` is 0 but the spend
   * is unknown, never free. The governor settles at the estimate.
   */
  readonly creditsUnknown?: boolean;
}
export interface ImageVideoProvider {
  readonly name: string;
  /** Soul ID character. IOS-3: `prompts` = the persona's look-prompts when there are no reference images yet. */
  createSoulId(req: { name: string; referenceImageUrls: readonly string[]; prompts?: readonly string[] }): Promise<{ soulId: string; credits: number; creditsUnknown?: boolean }>;
  /** Stills (character sheet, look pack, carousel/static images). `model` e.g. 'soul' | 'nano-banana'. */
  generateStill(req: {
    soulId?: string;
    prompt: string;
    aspect?: MediaAspect;
    model?: string;
    referenceImageUrls?: readonly string[];
    resolution?: MediaResolution;
  }): Promise<MediaResult>;
  /** Image-to-video from a start image. `model` e.g. 'kling-3.0-turbo' | 'kling' | 'wan'. */
  imageToVideo(req: { imageUrl: string; prompt: string; durationS: number; model?: string; resolution?: MediaResolution; aspect?: MediaAspect }): Promise<MediaResult>;
  /**
   * Talking clip with the voice track (Seedance 2.0/2.5 with --audio). `durationS` is the audio length when known;
   * the governor reserves credits from it. One clip is at most 15 s (a 30 s reel = 2 clips).
   */
  talkingWithAudio(req: { imageUrl: string; audioUrl: string; resolution?: MediaResolution; durationS?: number; model?: string; prompt?: string }): Promise<MediaResult>;
  /** Credits an operation would cost, without running it ('higgsfield generate cost'). */
  costProbe(req: { operation: HiggsfieldOperation; durationS?: number; model?: string; resolution?: MediaResolution }): Promise<{ credits: number }>;
  /** (IOS-3) Uploads a local file (start image, voice track) so generations can reference it; returns its URL. */
  upload(req: { filePath: string; contentType?: string }): Promise<{ url: string }>;
}

// ─── Talking avatar (pluggable: Higgsfield Seedance or fal Kling Avatar) ───
export interface TalkingProvider {
  readonly name: 'higgsfield-seedance' | 'fal-kling-avatar';
  render(req: { imageUrl: string; audioUrl: string; durationS: number; resolution?: MediaResolution; prompt?: string }): Promise<{
    jobId: string;
    url: string;
    durationS: number;
    credits: number;
    costUsd: number;
    /** (IOS-4 fix, additive) See MediaResult.creditsUnknown. */
    creditsUnknown?: boolean;
  }>;
}

// ─── Voice (ElevenLabs / Higgsfield TTS) ───
export interface VoiceProvider {
  readonly name: string;
  designVoice(req: { description: string }): Promise<{ voiceId: string }>;
  /** `modelId` (IOS-3, additive): provider model, e.g. ElevenLabs 'eleven_multilingual_v2'. */
  tts(req: { voiceId: string; text: string; modelId?: string }): Promise<{
    url: string;
    durationS: number;
    characters: number;
    costUsd: number;
    /** (IOS-4 fix, additive) Credit-billed voices (Higgsfield TTS) report credits here instead of costUsd. */
    credits?: number;
    creditsUnknown?: boolean;
  }>;
}

// ─── Publishing (Zernio) ───
/**
 * The platform's post-level AI flag field, always set true (IOS-3/4 owner rule). TikTok AIGC is sent as
 * `video_made_with_ai` through Zernio; Instagram `is_ai_generated`; YouTube `containsSyntheticMedia`.
 */
export const AI_FLAG_FIELDS: Readonly<Record<Platform, string>> = {
  tiktok: 'video_made_with_ai',
  instagram: 'is_ai_generated',
  youtube: 'containsSyntheticMedia',
  pinterest: 'is_ai_generated',
};
export interface PublishRequest {
  readonly accountRef: string;
  readonly platform: Platform;
  readonly mediaUrls: readonly string[];
  readonly caption: string;
  /** Platform AI label (IG is_ai_generated, TikTok AIGC, YT containsSyntheticMedia). Always on. */
  readonly aiLabel: true;
  readonly scheduledAt?: Date;
  /** Stable per post: a retried publish with the same key must not create a second post. */
  readonly idempotencyKey?: string;
  // (IOS-4, additive)
  /** What the media is. Defaults to 'video'. */
  readonly kind?: 'video' | 'image' | 'carousel';
  /** YouTube Shorts title; ignored elsewhere. */
  readonly title?: string;
  readonly coverUrl?: string;
  /** 'draft_inbox' sends a TikTok/Instagram draft to the app inbox (trending-sound posts); default 'publish'. */
  readonly mode?: 'publish' | 'draft_inbox';
  /** Extra platform fields the adapter passes through (never used to switch the AI flag off). */
  readonly platformOptions?: Readonly<Record<string, unknown>>;
}
export interface PublishComment {
  readonly id: string;
  readonly authorRef: string;
  readonly text: string;
  readonly at: Date;
}
/** (IOS-4) One DM in a conversation the account is part of. */
export interface DmMessage {
  readonly id: string;
  readonly threadRef: string;
  readonly userRef: string;
  readonly platform: Platform;
  /** 'in' = from the user; 'out' = sent by the account. */
  readonly direction: 'in' | 'out';
  readonly text: string;
  readonly at: Date;
}
/** (IOS-4) Cumulative per-post metrics at the time of the call. */
export interface PostMetrics {
  readonly views: number;
  readonly watchTimeS: number;
  readonly likes: number;
  readonly comments: number;
  readonly saves: number;
  readonly shares: number;
  readonly follows: number;
  readonly profileVisits: number;
  readonly linkClicks: number;
}
/** (IOS-4) A connected social account in the publishing vendor. */
export interface PublishAccount {
  readonly accountRef: string;
  readonly platform: Platform;
  readonly handle: string;
  /** The platform AI profile label, when the vendor can read it; null = unknown. */
  readonly aiProfileLabel: boolean | null;
}
/** (IOS-4) Webhook events from the publishing vendor. */
export type DistributionEvent =
  | { type: 'comment'; platform: Platform; accountRef: string; externalPostId: string; comment: PublishComment }
  | { type: 'dm'; accountRef: string; message: DmMessage }
  | { type: 'post_status'; externalId: string; status: 'live' | 'processing' | 'failed'; url: string | null };
export interface PublishProvider {
  readonly name: string;
  schedule(req: PublishRequest): Promise<{ externalId: string; status: 'scheduled' }>;
  publish(req: PublishRequest): Promise<{ externalId: string; status: 'published' | 'processing' }>;
  verify(externalId: string): Promise<{ status: 'live' | 'processing' | 'failed'; url: string | null; aiLabel: boolean }>;
  listComments(externalId: string): Promise<PublishComment[]>;
  replyToComment(req: { externalId: string; commentId: string; text: string }): Promise<{ id: string }>;
  /**
   * A message in an existing DM conversation (`threadRef`, the vendor's conversation id). Vendors can't start a DM on
   * Instagram or TikTok, so a DM is only ever a reply in a thread the user opened (or a comment private reply).
   */
  sendDm(req: { accountRef: string; userRef: string; text: string; threadRef?: string }): Promise<{ id: string }>;
  /**
   * (IOS-4 fix, additive) Comment-to-DM: one private reply to a comment's author (Instagram only, once per comment,
   * within 7 days). `id: null` with a reason when the platform refuses it: never retry those.
   */
  sendPrivateReply(req: { externalId: string; commentId: string; text: string }): Promise<{ id: string | null; reason?: 'consumed' | 'expired' | 'unsupported' }>;
  // (IOS-4, additive)
  /** Uploads a local media file to the vendor; returns the URL to put in `mediaUrls`. */
  uploadMedia(req: { filePath: string; contentType: string }): Promise<{ mediaUrl: string }>;
  hideComment(req: { externalId: string; commentId: string }): Promise<{ ok: boolean }>;
  listDms(req: { accountRef: string; since?: Date }): Promise<DmMessage[]>;
  fetchMetrics(req: { externalId: string; platform: Platform }): Promise<PostMetrics>;
  listAccounts(): Promise<PublishAccount[]>;
  verifyWebhook(rawBody: string, signature: string): boolean;
  parseWebhook(rawBody: string): DistributionEvent[];
}

// ─── Store (Lemon Squeezy) ───
export interface StoreProduct {
  readonly id: string;
  readonly name: string;
  readonly priceCents: number;
  readonly currency: string;
  readonly status: 'draft' | 'published';
  readonly url: string;
  // (IOS-4, additive)
  readonly storeId?: string;
  readonly variantId?: string;
  /** Hosted checkout URL (buy link). */
  readonly checkoutUrl?: string;
}
/** (IOS-4) One Lemon Squeezy store (one per persona). */
export interface StoreInfo {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly domain: string | null;
  readonly currency: string;
}
/**
 * Store webhooks. IOS-4 adds optional attribution fields (store, variant, discount code, checkout custom data such as
 * `post_id` / `short_link`) and subscription lifecycle events, additively.
 */
export type StoreEvent =
  | {
      type: 'order_created';
      orderId: string;
      productId: string;
      amountCents: number;
      currency: string;
      emailHash: string;
      storeId?: string;
      variantId?: string;
      feeCents?: number;
      discountCode?: string | null;
      customData?: Readonly<Record<string, string>>;
      /** Plain email, only to create the buyer's subscriber/consent records; never logged. */
      email?: string;
    }
  | { type: 'order_refunded'; orderId: string; amountCents: number; storeId?: string }
  | {
      type: 'subscription_created';
      subscriptionId: string;
      productId: string;
      storeId?: string;
      variantId?: string;
      emailHash?: string;
      email?: string;
      priceCents?: number;
      status?: 'on_trial' | 'active';
      customData?: Readonly<Record<string, string>>;
    }
  | {
      type: 'subscription_updated';
      subscriptionId: string;
      status: 'on_trial' | 'active' | 'paused' | 'past_due' | 'unpaid' | 'cancelled' | 'expired';
      endsAt?: string | null;
      storeId?: string;
      /**
       * (IOS-4 fix, additive) 'invoice' = a payment event (subscription_payment_success / _recovered): it only clears a
       * past-due state and never revives a cancelled or expired subscription. Default 'subscription'.
       */
      source?: 'subscription' | 'invoice';
      /** (IOS-4 fix, additive) The vendor's updated_at: older events than the last one applied are skipped. */
      updatedAt?: string | null;
    }
  | { type: 'subscription_payment_failed'; subscriptionId: string; storeId?: string };
export interface StoreProvider {
  readonly name: string;
  /** Read-only products API. `storeId` (IOS-4, additive) limits it to one store. */
  listProducts(req?: { storeId?: string }): Promise<StoreProduct[]>;
  getProduct(id: string): Promise<StoreProduct | null>;
  verifyWebhook(rawBody: string, signature: string): boolean;
  parseWebhook(rawBody: string): StoreEvent;
  // (IOS-4, additive)
  listStores(): Promise<StoreInfo[]>;
  /** A checkout link for a variant with custom data (attribution) and an optional discount code. */
  createCheckout(req: { storeId: string; variantId: string; customData?: Readonly<Record<string, string>>; discountCode?: string }): Promise<{ url: string }>;
  /** A discount code (per-post coupons for attribution). */
  createDiscount(req: { storeId: string; code: string; percent: number; productIds?: readonly string[]; expiresAt?: Date | null }): Promise<{ id: string; code: string }>;
}

// ─── Email (Resend) ───
/** Transactional send (stream A: the Owner's sign-in links). Lists and sequences use `AudienceProvider` (IOS-4). */
export interface EmailProvider {
  readonly name: string;
  send(req: { from: string; to: string; subject: string; html: string; tags?: Record<string, string> }): Promise<{ id: string }>;
}

// ─── Audience email (IOS-4: Resend audiences, contacts, broadcasts, sequence sends, webhooks) ───
export type EmailWebhookEvent =
  | { type: 'delivered' | 'opened' | 'clicked' | 'bounced' | 'complained'; emailId: string; to: string; at: Date; link?: string }
  | { type: 'contact_unsubscribed'; audienceId: string; email: string; at: Date };
export interface AudienceProvider {
  readonly name: string;
  /** Idempotent by name (one audience per persona list). */
  ensureAudience(req: { name: string }): Promise<{ audienceId: string }>;
  upsertContact(req: { audienceId: string; email: string; firstName?: string; unsubscribed?: boolean }): Promise<{ contactId: string }>;
  /** One email to one subscriber (sequence steps, double opt-in confirmations). `headers` carries List-Unsubscribe. */
  send(req: {
    from: string;
    to: string;
    subject: string;
    html: string;
    text?: string;
    replyTo?: string;
    headers?: Readonly<Record<string, string>>;
    tags?: Readonly<Record<string, string>>;
  }): Promise<{ id: string }>;
  sendBroadcast(req: { audienceId: string; from: string; subject: string; html: string; name?: string }): Promise<{ id: string }>;
  /** Svix-signed webhooks (svix-id, svix-timestamp, svix-signature headers). */
  verifyWebhook(rawBody: string, headers: Readonly<Record<string, string | null | undefined>>): boolean;
  parseWebhook(rawBody: string): EmailWebhookEvent[];
}

// ─── Research (Apify) ───
export interface ResearchProvider {
  readonly name: string;
  runActor(req: { actor: string; input: Record<string, unknown> }): Promise<{ runId: string; items: unknown[] }>;
  topPosts(req: { niche: string; platform: Platform; limit?: number }): Promise<
    Array<{ url: string; hook: string; format: string; views: number; postedAt: Date }>
  >;
}

// ─── IOS-2 additions (see docs/IOS-2-CONTRACTS.md). Every paid method returns costUsd; callers wrap it in
// core `metered()` so the governor reserves, settles and attributes the spend. ───

// ─── Transcription (Whisper-style; QC Q2 re-transcribes the voice track). Stream B owns it. ───
export interface TranscriptWord {
  readonly word: string;
  readonly startS: number;
  readonly endS: number;
}
export interface TranscribeProvider {
  readonly name: string;
  transcribe(req: { audioUrl: string; language?: 'en'; prompt?: string }): Promise<{
    text: string;
    words: TranscriptWord[];
    durationS: number;
    costUsd: number;
  }>;
}

// ─── Embeddings (local model by default, no key; Voyage optional). Stream C owns it. ───
/** pgvector dimension for knowledge_node.embedding and news_item.embedding (e.g. bge-small-en-v1.5 / MiniLM). */
export const EMBEDDING_DIM = 384;
export interface EmbeddingProvider {
  readonly name: string;
  /** Always EMBEDDING_DIM. */
  readonly dimensions: number;
  /** One unit-length vector per input, in input order. */
  embed(texts: readonly string[]): Promise<number[][]>;
}

// ─── Web research for the Field Brain (live: Claude web_search / web_fetch server tools). Stream C owns it. ───
export interface ResearchCitation {
  readonly url: string;
  readonly title: string;
  /** Short quote (≤ 25 words): summaries plus short quotes, never copied works. */
  readonly quote?: string;
}
export interface ResearchFact {
  readonly claim: string;
  readonly citations: readonly ResearchCitation[];
}
export interface TopicResearch {
  readonly synthesis: string;
  readonly facts: readonly ResearchFact[];
  readonly frameworks: readonly string[];
  /** Common questions and misconceptions. */
  readonly questions: readonly string[];
  readonly sources: readonly ResearchCitation[];
  readonly costUsd: number;
}
export interface FieldSource {
  readonly name: string;
  readonly url: string | null;
  readonly kind: 'journal' | 'institution' | 'publication' | 'expert' | 'dataset' | 'rss' | 'other';
  /** 1–5. */
  readonly credibility: number;
  readonly notes?: string;
}
export interface FieldMap {
  readonly sources: readonly FieldSource[];
  /** Schools of thought and who's who. */
  readonly experts: ReadonlyArray<{ name: string; school: string; why: string; url?: string }>;
  /** Curriculum skeleton: path like 'fundamentals/cash-flow'. */
  readonly curriculum: ReadonlyArray<{ path: string; title: string; level: 'fundamental' | 'intermediate' | 'advanced' | 'debate' | 'myth' | 'frontier' }>;
  readonly costUsd: number;
}
export interface WebResearchProvider {
  readonly name: string;
  mapField(req: { niche: string; maxSources?: number; maxNodes?: number }): Promise<FieldMap>;
  researchTopic(req: { niche: string; path: string; title: string; questions?: readonly string[]; maxSources?: number }): Promise<TopicResearch>;
}

// ─── Feeds for the News Desk (RSS / Atom: canon RSS, Google News RSS, subreddit RSS, YouTube channel RSS). Stream C. ───
export interface FeedItem {
  readonly title: string;
  readonly url: string;
  readonly publishedAt: Date | null;
  readonly summary: string | null;
  /** Feed or site name. */
  readonly source: string;
}
export interface FeedProvider {
  readonly name: string;
  /** The live adapter refuses hosts outside its allowlist (throws). Free: no costUsd. */
  fetchFeed(req: { url: string; limit?: number }): Promise<FeedItem[]>;
}

// ─── Media storage (IOS-3/4): rendered media, product files and site images ───
/** A stored object. `url` is the dashboard URL (Owner-only `/api/media/<key>`; `public/…` keys also at `/api/public/media/<key>`). */
export interface StoredObject {
  readonly key: string;
  readonly url: string;
  readonly bytes: number;
  readonly contentType: string;
}
/**
 * Where generated files live. Keys are POSIX paths without `..`, e.g. `media/<personaId>/<slotId>/final.mp4`,
 * `products/<personaId>/<productId>/v1/a4.pdf`, `public/<personaSlug>/cover.jpg` (only `public/` keys are ever
 * served without the Owner session). Local disk on the Mac (`LocalMediaStore`); object storage when deployed (IOS-5).
 */
export interface MediaStore {
  readonly name: string;
  put(req: { key: string; data: Uint8Array | string; contentType: string }): Promise<StoredObject>;
  putFile(req: { key: string; filePath: string; contentType: string }): Promise<StoredObject>;
  get(key: string): Promise<{ data: Uint8Array; contentType: string } | null>;
  /** A local file path for tools that need one (FFmpeg, Chrome, uploads); remote stores download to a temp file. */
  localPath(key: string): Promise<string | null>;
  /** The dashboard URL for a key (no I/O). */
  url(key: string): string;
}

export interface Providers {
  readonly llm: LlmProvider;
  readonly imageVideo: ImageVideoProvider;
  readonly talking: TalkingProvider;
  readonly voice: VoiceProvider;
  readonly publish: PublishProvider;
  readonly store: StoreProvider;
  readonly email: EmailProvider;
  /** Apify (trend and competitor scrapers). */
  readonly research: ResearchProvider;
  // IOS-2
  readonly transcribe: TranscribeProvider;
  readonly embeddings: EmbeddingProvider;
  readonly webResearch: WebResearchProvider;
  readonly feeds: FeedProvider;
  // IOS-3/4 (docs/IOS-34-CONTRACTS.md)
  /** Resend audiences, contacts, broadcasts and sequence sends (stream G owns the live adapter). */
  readonly audience: AudienceProvider;
  /** Media and product file storage (stream E owns the live member: local disk on the Mac). */
  readonly storage: MediaStore;
}
