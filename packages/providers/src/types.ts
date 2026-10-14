/**
 * Provider interfaces. Every integration sits behind one of these, with a deterministic fake in `fakes.ts`.
 * Real adapters arrive in later milestones (IOS-2: LLM; IOS-3: media; IOS-4: distribution and money).
 * Owner chat is internal (dashboard), so there is no chat provider.
 */

export type Platform = 'tiktok' | 'instagram' | 'youtube' | 'pinterest';
export type ModelTier = 'fast' | 'standard' | 'strong';

// ─── LLM (Claude Agent SDK later) ───
export interface LlmMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}
export interface LlmRequest {
  readonly tier: ModelTier;
  readonly system?: string;
  readonly messages: readonly LlmMessage[];
  readonly maxTokens?: number;
}
export interface LlmResponse {
  readonly text: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
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
  talkingWithAudio(req: { imageUrl: string; audioUrl: string; resolution?: '720p' | '1080p' }): Promise<MediaResult>;
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

export interface Providers {
  readonly llm: LlmProvider;
  readonly imageVideo: ImageVideoProvider;
  readonly talking: TalkingProvider;
  readonly voice: VoiceProvider;
  readonly publish: PublishProvider;
  readonly store: StoreProvider;
  readonly email: EmailProvider;
  readonly research: ResearchProvider;
}
