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
export interface MediaResult {
  readonly jobId: string;
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly durationS?: number;
  readonly credits: number;
}
export interface ImageVideoProvider {
  readonly name: string;
  createSoulId(req: { name: string; referenceImageUrls: readonly string[] }): Promise<{ soulId: string; credits: number }>;
  generateStill(req: { soulId?: string; prompt: string; aspect?: '9:16' | '1:1' | '4:5' }): Promise<MediaResult>;
  imageToVideo(req: { imageUrl: string; prompt: string; durationS: number; model?: string }): Promise<MediaResult>;
  /** `durationS` is the audio length when known; the governor reserves credits from it. */
  talkingWithAudio(req: { imageUrl: string; audioUrl: string; resolution?: '720p' | '1080p'; durationS?: number }): Promise<MediaResult>;
  /** Credits an operation would cost, without running it. */
  costProbe(req: { operation: HiggsfieldOperation; durationS?: number }): Promise<{ credits: number }>;
}

// ─── Talking avatar (pluggable: Higgsfield Seedance or fal Kling Avatar) ───
export interface TalkingProvider {
  readonly name: 'higgsfield-seedance' | 'fal-kling-avatar';
  render(req: { imageUrl: string; audioUrl: string; durationS: number }): Promise<{
    jobId: string;
    url: string;
    durationS: number;
    credits: number;
    costUsd: number;
  }>;
}

// ─── Voice (ElevenLabs / Higgsfield TTS) ───
export interface VoiceProvider {
  readonly name: string;
  designVoice(req: { description: string }): Promise<{ voiceId: string }>;
  tts(req: { voiceId: string; text: string }): Promise<{
    url: string;
    durationS: number;
    characters: number;
    costUsd: number;
  }>;
}

// ─── Publishing (Zernio) ───
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
}
export interface PublishProvider {
  readonly name: string;
  schedule(req: PublishRequest): Promise<{ externalId: string; status: 'scheduled' }>;
  publish(req: PublishRequest): Promise<{ externalId: string; status: 'published' | 'processing' }>;
  verify(externalId: string): Promise<{ status: 'live' | 'processing' | 'failed'; url: string | null; aiLabel: boolean }>;
  listComments(externalId: string): Promise<Array<{ id: string; authorRef: string; text: string; at: Date }>>;
  replyToComment(req: { externalId: string; commentId: string; text: string }): Promise<{ id: string }>;
  sendDm(req: { accountRef: string; userRef: string; text: string }): Promise<{ id: string }>;
}

// ─── Store (Lemon Squeezy) ───
export interface StoreProduct {
  readonly id: string;
  readonly name: string;
  readonly priceCents: number;
  readonly currency: string;
  readonly status: 'draft' | 'published';
  readonly url: string;
}
export type StoreEvent =
  | { type: 'order_created'; orderId: string; productId: string; amountCents: number; currency: string; emailHash: string }
  | { type: 'order_refunded'; orderId: string; amountCents: number }
  | { type: 'subscription_created'; subscriptionId: string; productId: string };
export interface StoreProvider {
  readonly name: string;
  listProducts(): Promise<StoreProduct[]>;
  getProduct(id: string): Promise<StoreProduct | null>;
  verifyWebhook(rawBody: string, signature: string): boolean;
  parseWebhook(rawBody: string): StoreEvent;
}

// ─── Email (Resend) ───
export interface EmailProvider {
  readonly name: string;
  send(req: { from: string; to: string; subject: string; html: string; tags?: Record<string, string> }): Promise<{ id: string }>;
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
}
