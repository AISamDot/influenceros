import { LLM_PRICES, type LlmCacheBlock, llmCostUsd, type ModelTier } from '@ios/providers';
import type { ToolCallRecord, ToolDef } from '../contracts';

/**
 * What the live runtime hands an engine (Messages API or Claude Agent SDK) for one agent run, and what it gets
 * back. The runtime owns routing, the governor and logging; an engine only talks to Claude and runs the tool loop.
 */
export interface EngineRequest {
  readonly model: string;
  readonly tier: ModelTier;
  /** Stable context, sent first and prompt-cached (bible, playbook, skill text). */
  readonly cached: readonly LlmCacheBlock[];
  readonly system: string;
  readonly prompt: string;
  /** Registry tools the model may call (already filtered to what the caller may see). */
  readonly tools: ReadonlyArray<ToolDef<any, any>>;
  /** Runs one tool through the registry (permission checks in code). Throws on refusal or bad input. */
  invokeTool(name: string, input: unknown): Promise<unknown>;
  readonly jsonSchema?: Readonly<Record<string, unknown>>;
  readonly skills?: readonly string[];
  readonly maxTokens: number;
  readonly maxTurns: number;
  /** Hard stop for this run, USD (the governor's remaining headroom, capped per run). */
  readonly maxCostUsd: number;
  readonly effort: 'low' | 'medium' | 'high';
  readonly onText?: (delta: string) => void;
}

export interface EngineUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface EngineResult {
  readonly text: string;
  /** The structured value when `jsonSchema` was given (already JSON-parsed). */
  readonly structured?: unknown;
  readonly model: string;
  readonly usage: EngineUsage;
  readonly toolCalls: ToolCallRecord[];
  readonly stopReason: string | null;
  readonly engine: 'messages' | 'agent-sdk';
}

export interface Engine {
  readonly name: 'messages' | 'agent-sdk';
  run(req: EngineRequest): Promise<EngineResult>;
}

/** Claude declined (stop_reason "refusal"). The run is logged as an error; chat turns it into a short notice. */
export class AgentRefusalError extends Error {
  override readonly name = 'AgentRefusalError';
  constructor(readonly category: string | null) {
    super(`the model declined this request${category ? ` (${category})` : ''}`);
  }
}

/** The model's output didn't match the task's structured-output validator. */
export class AgentOutputError extends Error {
  override readonly name = 'AgentOutputError';
}

/** Tier of a model id we price (fallback models are priced by their own tier when known). */
export function tierOfModel(model: string, fallback: ModelTier): ModelTier {
  for (const [tier, p] of Object.entries(LLM_PRICES) as Array<[ModelTier, (typeof LLM_PRICES)[ModelTier]]>) {
    if (model.startsWith(p.model)) return tier;
  }
  return fallback;
}

export function usageCost(model: string, tier: ModelTier, u: Omit<EngineUsage, 'costUsd'>): number {
  return llmCostUsd(tierOfModel(model, tier), u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens);
}

/**
 * API tool names allow only [a-zA-Z0-9_-], so registry names (`studio.overview`) are sent as `studio__overview`.
 * The map is built per run, so decoding never guesses.
 */
export function toolNameMap(defs: ReadonlyArray<ToolDef<any, any>>): { toApi: Map<string, string>; fromApi: Map<string, string> } {
  const toApi = new Map<string, string>();
  const fromApi = new Map<string, string>();
  for (const d of defs) {
    const api = d.name.replace(/\./g, '__').slice(0, 64);
    toApi.set(d.name, api);
    fromApi.set(api, d.name);
  }
  return { toApi, fromApi };
}

/** Tool output as text for the model: JSON, capped so one tool can't flood the context. */
export function toolResultText(out: unknown, max = 16_000): string {
  const text = typeof out === 'string' ? out : JSON.stringify(out ?? null);
  return text.length > max ? `${text.slice(0, max)}… [truncated ${text.length - max} chars]` : text;
}

export const errorMessage = (err: unknown): string => (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 500);
