/**
 * IOS-2 shared contracts. FROZEN: the four IOS-2 streams build against these types in parallel, so they change
 * only additively (new optional fields, new union members inside a stream's marked block) and only by the stream
 * that owns the concept. See docs/IOS-2-CONTRACTS.md for ownership and rules.
 *
 * Who implements what:
 *   AgentRuntime, ToolRegistry, createServices ........ stream A (packages/agents)
 *   pipeline stages, Gate/QC result shapes ............ stream B (packages/content)
 *   KnowledgeService .................................. stream C (packages/knowledge)
 *   CadencePolicy, RoutingPolicy, scheduler ........... stream D (packages/profit, apps/worker)
 */
import type { Db } from '@ios/db';
import type { Actor, CoreFormat, CostRef, GateVerdict, JobRow, OptionalFormat, PostFormat, PostPurpose } from '@ios/core';
import type { FormatPlanService, PromptCompiler, RadarService, WorldService } from './ios5';
import { LLM_PRICES, type LlmCacheBlock, type ModelTier, type Providers } from '@ios/providers';

// ───────────────────────────── Agents and model routing ─────────────────────────────

export type AgentName =
  // >>> stream A agents
  | 'studio-manager'
  | 'persona-manager'
  // <<< stream A agents
  // >>> stream B agents
  | 'calendar-planner'
  | 'scriptwriter'
  | 'monetization-agent'
  | 'compliance-gate'
  | 'quality-control'
  // <<< stream B agents
  // >>> stream C agents
  | 'knowledge-builder'
  | 'news-desk'
  // <<< stream C agents
  // >>> stream D agents
  | 'profit-engine'
  // <<< stream D agents
  // IOS-3/4 (docs/IOS-34-CONTRACTS.md): each stream adds members inside its own block only.
  // >>> stream E agents
  | 'video-producer'
  // <<< stream E agents
  // >>> stream F agents
  | 'community-manager'
  // <<< stream F agents
  // >>> stream G agents
  | 'email-writer'
  // <<< stream G agents
  // >>> stream H agents
  | 'product-builder'
  // <<< stream H agents
  // IOS-5 (docs/IOS-5-CONTRACTS.md): each stream adds members inside its own block only.
  // >>> stream I agents
  | 'trend-scout'
  // <<< stream I agents
  // >>> stream J agents
  | 'continuity-keeper'
  // <<< stream J agents
  // >>> stream K agents
  // <<< stream K agents
  // >>> stream L agents
  | 'stories-producer';
// <<< stream L agents

/** Who can call a tool: an agent, the Owner (dashboard action) or the system (jobs, cron). */
export type Caller = AgentName | 'owner' | 'system';

/** Tier → model id. Haiku 5.5 / Sonnet 5.5 / Opus 5.5; prices live in LLM_PRICES (@ios/providers). */
export const MODEL_IDS: Readonly<Record<ModelTier, string>> = {
  fast: LLM_PRICES.fast.model,
  standard: LLM_PRICES.standard.model,
  strong: LLM_PRICES.strong.model,
};

/**
 * Default tier per agent (PRD §8.4). A task may override it (e.g. a fast classification step inside the Persona
 * Manager); the Profit Engine's model-routing lever overrides it through RoutingPolicy.
 */
export const DEFAULT_ROUTING: Readonly<Record<AgentName, ModelTier>> = {
  // >>> stream A routing
  'studio-manager': 'strong',
  'persona-manager': 'standard',
  // <<< stream A routing
  // >>> stream B routing
  'calendar-planner': 'standard',
  scriptwriter: 'standard',
  'monetization-agent': 'strong',
  'compliance-gate': 'fast',
  'quality-control': 'fast',
  // <<< stream B routing
  // >>> stream C routing
  'knowledge-builder': 'standard',
  'news-desk': 'fast',
  // <<< stream C routing
  // >>> stream D routing
  'profit-engine': 'standard',
  // <<< stream D routing
  // >>> stream E routing
  'video-producer': 'standard',
  // <<< stream E routing
  // >>> stream F routing
  'community-manager': 'standard',
  // <<< stream F routing
  // >>> stream G routing
  'email-writer': 'standard',
  // <<< stream G routing
  // >>> stream H routing
  'product-builder': 'strong',
  // <<< stream H routing
  // >>> stream I routing
  'trend-scout': 'standard',
  // <<< stream I routing
  // >>> stream J routing
  'continuity-keeper': 'fast',
  // <<< stream J routing
  // >>> stream K routing
  // <<< stream K routing
  // >>> stream L routing
  'stories-producer': 'standard',
  // <<< stream L routing
};

/** The studio's own skills in `.claude/skills/<name>/SKILL.md` (stream C writes them). */
export const SKILL_NAMES = [
  'persona-bible-builder',
  'field-brain',
  'hook-lab',
  'video-prompt-pack',
  'carousel-designer',
  'workbook-builder',
  'listing-pack-writer',
  'community-reply-style',
  'compliance-gate-checklist',
  'kill-scale-analyst',
] as const;
export type SkillName = (typeof SKILL_NAMES)[number];

export interface AgentScope {
  readonly studioId: string;
  /** The persona this run acts for; null for studio-level agents (Studio Manager, Profit Engine, News Desk scans). */
  readonly personaId: string | null;
}

/**
 * One agent run. In live mode the runtime routes the model, reserves the estimate with the governor, sends the
 * cached blocks first (prompt caching), lets the model call the allowed tools, validates the output with `parse`,
 * settles the spend and writes one agent_run row. In fake mode (no Anthropic key, every test) it returns `fake()`
 * through the same metering and logging path, so every agent runs end to end on fakes.
 */
export interface AgentTask<T = string> {
  readonly agent: AgentName;
  readonly scope: AgentScope;
  /** Short label stored as agent_run.summary, e.g. 'hook-lab: 10 hooks'. No personal data, no secrets. */
  readonly label: string;
  /** Overrides routing (RoutingPolicy override, then DEFAULT_ROUTING). */
  readonly tier?: ModelTier;
  /** Instructions for this call. Keep volatile content (dates, ids) here or in `prompt`, never in `cached`. */
  readonly system: string;
  /** Stable context sent first and prompt-cached: bible, playbook summary, skill text. Most stable first. */
  readonly cached?: readonly LlmCacheBlock[];
  /** Repo skills the live runtime loads (Agent SDK settingSources ['project']). Ignored in fake mode. */
  readonly skills?: readonly SkillName[];
  readonly prompt: string;
  /** Registry tool names the model may call. Every call is still permission-checked by the registry. */
  readonly tools?: readonly string[];
  readonly maxTokens?: number;
  /** Structured output: validates the model's JSON value (throw to reject). Omit for plain text, where T = string. */
  readonly parse?: (value: unknown) => T;
  /** JSON Schema of T, for structured outputs in live mode. */
  readonly jsonSchema?: Readonly<Record<string, unknown>>;
  /** Deterministic output for fake mode and tests. Required. */
  readonly fake: () => T;
  /** Ledger attribution for the run's cost (P&L). Defaults to the persona (or studio) as overhead. */
  readonly costRef?: CostRef;
  /**
   * (stream A, additive) Where the run's context and instructions came from. The registry gates mutating tools on it;
   * a tool with `untrustedOutput` marks the rest of the run untrusted. Omitted = trusted context, no Owner turn.
   */
  readonly trust?: RunTrust;
}

/**
 * The provenance of an agent run (stream A, additive). When `untrusted`, mutating tools run only when the Owner asked
 * for them in this turn (`ToolDef.ownerIntent` matches the Owner's message, or the Owner's "yes" to the agent's own
 * proposal); otherwise the registry refuses them. Read-only tools are never gated.
 */
export interface RunTrust {
  /** The context holds third-party text: news, comments, web research, DMs, or messages from anyone but the Owner and this agent. */
  readonly untrusted: boolean;
  /** The Owner's own message (sent from the dashboard session) that started this turn; null/omitted for background and delegated runs. */
  readonly ownerText?: string | null;
  /** This agent's own message right before the Owner's turn: what an Owner "yes" confirms. */
  readonly proposal?: string | null;
}

export interface ToolCallRecord {
  readonly tool: string;
  readonly ok: boolean;
  readonly error?: string;
  readonly ms: number;
}

export interface AgentResult<T> {
  readonly output: T;
  /** The model's final text (the JSON text for structured runs). */
  readonly text: string;
  readonly mode: 'live' | 'fake';
  readonly model: string;
  /** agent_run.id */
  readonly runId: string;
  readonly costUsd: number;
  readonly toolCalls: readonly ToolCallRecord[];
}

export interface AgentRuntime {
  readonly mode: 'live' | 'fake';
  /**
   * Runs one task. Throws BudgetExceededError (from @ios/core) when the governor refuses; the run is logged with
   * outcome 'refused'. A ToolPermissionError inside a live run goes back to the model as a tool error, it does not
   * end the run.
   */
  run<T = string>(task: AgentTask<T>): Promise<AgentResult<T>>;
}

// ───────────────────────────── Tools ─────────────────────────────

export interface ToolContext {
  readonly services: StudioServices;
  readonly studioId: string;
  /** The caller's persona scope: a Persona Manager's own persona; null for studio-level agents and the Owner. */
  readonly personaId: string | null;
  readonly caller: Caller;
  readonly actor: Actor;
  /** (stream A, additive) The calling run's provenance; the registry gates mutating tools on it (see RunTrust). */
  readonly trust?: RunTrust;
}

/**
 * A tool agents can call. Names are `<namespace>.<verb>` in lowercase snake case (e.g. `knowledge.retrieve`); each
 * stream owns its namespaces (docs/IOS-2-CONTRACTS.md §4). Inputs use snake_case keys.
 */
export interface ToolDef<I = Record<string, unknown>, O = unknown> {
  readonly name: string;
  /** What it does and when to use it. Shown to the model. */
  readonly description: string;
  /**
   * 'persona': the input must carry `persona_id`; a persona-scoped caller may only pass its own, and the persona
   * must belong to the caller's studio. 'studio': no persona check (still subject to `callers` / `ownerOnly`).
   */
  readonly scope: 'persona' | 'studio';
  /** Only the Owner may invoke it (dashboard actions). Agents and the system are always refused. */
  readonly ownerOnly?: boolean;
  /** Allowlist of callers; omitted = any agent (never implies Owner-only actions). */
  readonly callers?: readonly Caller[];
  /** Writes state; the registry audits every successful call. */
  readonly mutates?: boolean;
  /**
   * (stream A, additive) For a mutating tool: what the Owner's message has to ask for before a run whose context is
   * untrusted may call it: an action verb followed by the tool's object in one sentence (e.g. /\b(?:revise|change)\b.*\bbible\b/).
   * Questions and negated sentences never match (see ownerAsked). Without it, untrusted runs can't call the tool at all.
   */
  readonly ownerIntent?: RegExp;
  /** (stream A, additive) The result carries third-party text (news, comments, web research): it makes the run untrusted. */
  readonly untrustedOutput?: boolean;
  /** JSON Schema for the input: type 'object', additionalProperties false. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /** Validates and narrows the raw input (throw on invalid input). */
  readonly parse: (raw: unknown) => I;
  run(ctx: ToolContext, input: I): Promise<O>;
}

export class ToolPermissionError extends Error {
  override readonly name = 'ToolPermissionError';
}

export interface ToolRegistry {
  /** Throws on a duplicate or malformed name. */
  register(...defs: ReadonlyArray<ToolDef<any, any>>): void;
  get(name: string): ToolDef<any, any> | undefined;
  /** Tools a caller may see, optionally limited to `names`. */
  list(filter?: { caller?: Caller; names?: readonly string[] }): Array<ToolDef<any, any>>;
  /** Permission checks (in code, not the prompt), then `parse`, then `run`. Throws ToolPermissionError. */
  invoke(ctx: ToolContext, name: string, raw: unknown): Promise<unknown>;
}

// ───────────────────────────── Cross-stream services ─────────────────────────────

export interface Citation {
  readonly url: string;
  readonly title?: string;
  readonly quote?: string;
  /** knowledge_source.id when the source is in the canon. */
  readonly sourceId?: string;
}

export interface KnowledgeHit {
  readonly kind: 'node' | 'news';
  /** knowledge_node.id or news_item.id: store it with the script/asset as the claim's evidence (FR-23.3). */
  readonly id: string;
  readonly niche: string;
  readonly title: string;
  /** Synthesis (node) or summary (news), trimmed for prompts. */
  readonly text: string;
  readonly citations: readonly Citation[];
  /** Similarity, 0–1. */
  readonly score: number;
  readonly lastVerifiedAt: Date | null;
}

export interface BriefingItem {
  readonly newsItemId: string;
  readonly title: string;
  readonly url: string;
  readonly whyItMatters: string;
  /** The persona's take, within its stance rules. */
  readonly take: string;
  readonly score: number;
}

export interface ReactionIdea {
  readonly title: string;
  readonly angle: string;
  readonly hook?: string;
  readonly newsItemId: string;
  /** Aim to publish within 24–72 h. */
  readonly expiresAt: Date;
}

export interface Briefing {
  readonly personaId: string;
  /** YYYY-MM-DD in the persona's timezone. */
  readonly date: string;
  readonly items: readonly BriefingItem[];
  readonly reactionIdeas: readonly ReactionIdea[];
}

/** Field Brain + News Desk reads for content agents. Stream C implements it; the default returns nothing. */
export interface KnowledgeService {
  retrieve(q: {
    studioId: string;
    niche: string;
    query: string;
    k?: number;
    kinds?: ReadonlyArray<'node' | 'news'>;
  }): Promise<KnowledgeHit[]>;
  latestBriefing(personaId: string): Promise<Briefing | null>;
}

/**
 * A weekly format mix: every core format has a count (the core-format invariant: the levers keep each ≥ 1); an
 * optional format (FR-4.3c library) is on when its count is > 0 and off when absent or 0. (IOS-5: was
 * Record<PostFormat, number>, which the optional formats made impossible to satisfy.)
 */
export type FormatMix = Readonly<Record<CoreFormat, number> & Partial<Record<OptionalFormat, number>>>;

/** Weekly posting target for one persona. formatMix and purposeMix each sum to postsPerWeek. */
export interface CadenceTarget {
  readonly postsPerWeek: number;
  readonly formatMix: FormatMix;
  readonly purposeMix: Readonly<Record<PostPurpose, number>>;
  readonly source: 'default' | 'lever' | 'owner';
  readonly reason?: string;
}

// >>> stream L default cadence (IOS-5: L moves the studio default to FR-4.3c's still-heavier mix)
/**
 * FR-4.3c studio default (Owner, 16 Oct: heavier on stills and written posts), 10 posts a week: 2 talking, 2 activity +
 * text, 1 voiceover, 2 static, 2 carousel, 1 photo dump (50% stills, was 20%); ~6 reach / 3 trust / 1 sell. A persona's
 * Format Plan (stream L) replaces it once one is approved.
 */
export const DEFAULT_CADENCE: CadenceTarget = {
  postsPerWeek: 10,
  formatMix: { talking: 2, activity_text: 2, voiceover: 1, static: 2, carousel: 2, photo_dump: 1 },
  purposeMix: { reach: 6, trust: 3, sell: 1 },
  source: 'default',
};
// <<< stream L default cadence

/** Cadence lever bounds: trim to 1 a day, winners up to 3 a day. */
export const CADENCE_BOUNDS = { min: 7, max: 21 } as const;

/** Stream D's cadence and format-mix levers set it; stream B's calendar generator reads it. */
export interface CadencePolicy {
  /** `weekStart` is the Monday 00:00 UTC of the week being planned. */
  target(personaId: string, weekStart: Date): Promise<CadenceTarget>;
}

/** Stream D's model-routing lever; stream A's runtime asks it before DEFAULT_ROUTING. */
export interface RoutingPolicy {
  /** null = no override. */
  tierFor(q: { studioId: string; personaId: string | null; agent: AgentName }): Promise<ModelTier | null>;
}

export interface ServiceBase {
  readonly db: Db;
  /** Raw providers. Paid calls go through `runtime.run` (LLM) or core `metered()` / `meteredProviders()`. */
  readonly providers: Providers;
  readonly now: () => Date;
}

/** Everything a tool, job or agent needs. Built once by `createServices` (tests) or `createStudioServices` (@ios/wiring). */
export interface StudioServices extends ServiceBase {
  readonly runtime: AgentRuntime;
  readonly tools: ToolRegistry;
  readonly knowledge: KnowledgeService;
  readonly cadence: CadencePolicy;
  readonly routing: RoutingPolicy;
  // IOS-5 (docs/IOS-5-CONTRACTS.md §5). Each has a null default in defaults.ts until its stream's package is wired.
  /** Growth Radar + Winner Finder reads (stream I): niche format benchmarks, opportunity evidence, monetisation patterns. */
  readonly radar: RadarService;
  /** World Bible, real-time grounding, storyline beats, continuity ledger and the no-repeat engine (stream J). */
  readonly world: WorldService;
  /** The production prompt compiler (stream K): five image blocks, five video blocks, camera styles. */
  readonly prompts: PromptCompiler;
  /** Per-persona Format Plans (stream L): recommend, read, adopt. */
  readonly formatPlans: FormatPlanService;
}

export interface CreateServicesOptions {
  db: Db;
  /** Defaults to createFakeProviders(). */
  providers?: Providers;
  /** 'fake' (default) never calls a model; 'auto' goes live when the Anthropic integration is live. */
  mode?: 'auto' | 'live' | 'fake';
  tools?: ReadonlyArray<ToolDef<any, any>>;
  knowledge?: (base: ServiceBase) => KnowledgeService;
  cadence?: (base: ServiceBase) => CadencePolicy;
  routing?: (base: ServiceBase) => RoutingPolicy;
  now?: () => Date;
  // IOS-5: `services()` returns the finished StudioServices (call it lazily, inside a method, never in the factory).
  radar?: ServiceFactory<RadarService>;
  world?: ServiceFactory<WorldService>;
  prompts?: ServiceFactory<PromptCompiler>;
  formatPlans?: ServiceFactory<FormatPlanService>;
}

/** (IOS-5) Builds a cross-stream service. `services` is lazy: the runtime and registry exist only after every factory ran. */
export type ServiceFactory<T> = (base: ServiceBase, services: () => StudioServices) => T;

// ───────────────────────────── Jobs, schedules, live providers ─────────────────────────────

export interface JobContext {
  readonly services: StudioServices;
  /** The claimed row. Pass it through untouched (the lease lives on it). */
  readonly job: JobRow;
  /** Long jobs call this so the reaper leaves them alone. false = the lease was lost: stop work. */
  heartbeat(): Promise<boolean>;
}
export type StudioJobHandler = (ctx: JobContext) => Promise<unknown>;
/** Keyed by job kind, `<namespace>.<verb>` (each stream owns its namespaces). */
export type JobHandlerMap = Readonly<Record<string, StudioJobHandler>>;

/**
 * A recurring task run by the scheduler on every tick (Vercel Cron each minute; the local ticker on the Mac).
 * Keep `run` short: enqueue jobs, don't do heavy work inline. It must be idempotent: a crash between run and the
 * scheduler recording it means it may run twice.
 */
export interface ScheduledTask {
  /** Unique, `<namespace>.<what>`, e.g. 'news.daily_scan'. */
  readonly name: string;
  /** Pure: is it due now, given the last successful run (null = never)? */
  due(now: Date, lastRunAt: Date | null): boolean;
  run(services: StudioServices, now: Date): Promise<unknown>;
}

/** What a package's `liveProviders()` gets to decide live vs fake. Implemented by @ios/wiring over @ios/secrets. */
export interface ProviderEnv {
  /** The integration's keys are present, it has a live adapter, and IOS_FAKE_PROVIDERS doesn't force it fake. */
  isLive(integrationId: string): boolean;
  /** Secret value (env first, then the Keychain). Pass straight to the SDK; never log, persist or prompt with it. */
  secret(name: string): string | null;
}

/**
 * The exports every IOS-2 package index provides, so @ios/wiring composes them without anyone editing a shared
 * file: `tools`, `jobs`, `schedules` and `liveProviders`.
 */
export interface StudioModule {
  readonly tools: ReadonlyArray<ToolDef<any, any>>;
  readonly jobs: JobHandlerMap;
  readonly schedules: readonly ScheduledTask[];
  liveProviders(env: ProviderEnv): Partial<Providers>;
}

// ───────────────────────────── Content pipeline (stream B produces; D, IOS-3 and the dashboard consume) ─────────────────────────────

/** Pipeline board columns. IOS-2 runs idea → script → q1 → gate → media_queued; IOS-3 adds the media stages. */
export const PIPELINE_STAGES = [
  'idea',
  'script',
  'q1',
  'gate',
  'media_queued',
  'voice',
  'q2',
  'render',
  'q3',
  'q4',
  'final_gate',
  'scheduled',
  'live',
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number] | 'blocked';

/** gate_result.checks is an array of these. */
export interface GateCheck {
  /** Rule id, e.g. 'ai_flag', 'income_guarantee', 'credential_claim', 'fake_scarcity'. */
  readonly rule: string;
  readonly verdict: GateVerdict;
  readonly message: string;
  /** The offending text, when there is one. */
  readonly span?: string;
  /** A compliant rewrite, when the Gate can offer one. */
  readonly fix?: string;
}

/** qc_report.details holds { checks: QcCheck[] } (plus stage-specific extras); qc_defect rows mirror the failures. */
export interface QcCheck {
  readonly check: string;
  readonly pass: boolean;
  readonly severity: 'blocker' | 'major' | 'minor';
  readonly message: string;
  /** Timestamp, line or page. */
  readonly location?: string;
}

/** Job kind for "queued for media": stream B enqueues it; IOS-3 registers its handler (the worker skips kinds it has no handler for). */
export const MEDIA_RENDER_JOB = 'media.render';

export interface MediaRenderPayload {
  readonly slotId: string;
  readonly personaId: string;
  readonly scriptId: string;
  readonly format: PostFormat;
  /** TTS text for talking / voiceover formats (already pronunciation-safe after Q1). */
  readonly voiceover: string | null;
  /** Overlay lines for activity + text, in order. */
  readonly onScreenText: readonly string[];
  readonly carousel: ReadonlyArray<{ title: string; body: string }> | null;
  readonly caption: string;
  readonly ctaKeyword: string;
  readonly hashtags: readonly string[];
  /** Prompt brief for stills and clips (video-prompt-pack skill). Never asks to "read as real". */
  readonly visualBrief: string;
  /** knowledge hit ids backing the script's factual claims. */
  readonly evidence: readonly string[];
}
