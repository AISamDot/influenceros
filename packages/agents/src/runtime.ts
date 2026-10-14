import { budgetStatus, BudgetExceededError, debit, metered } from '@ios/core';
import { findRepoRoot, json } from '@ios/db';
import { createFakeProviders, estimateTokens, FakeLlm, llmCostUsd, type LlmRequest, type ModelTier } from '@ios/providers';
import {
  type AgentResult,
  type AgentRuntime,
  type AgentTask,
  type CreateServicesOptions,
  DEFAULT_ROUTING,
  MODEL_IDS,
  type ServiceBase,
  type StudioServices,
  type RunTrust,
  type ToolCallRecord,
  type ToolDef,
} from './contracts';
import { defaultCadence, defaultRouting, nullKnowledge } from './defaults';
import { createAgentSdkEngine, loadAgentSdk } from './live/agent-sdk-engine';
import { type AnthropicLlm, EFFORT, isAnthropicLlm } from './live/anthropic';
import { AgentOutputError, type Engine, type EngineResult, type EngineUsage, errorMessage } from './live/engine';
import { createMessagesEngine } from './live/messages-engine';
import { createToolRegistry } from './registry';

/** Per-run options that stay inside stream A (chat streaming). */
export interface RunOptions {
  /** Text deltas as the model writes them (fake mode emits the fake text in small chunks). */
  onText?: (delta: string) => void;
  /** Force an engine for this run (live mode only). */
  engine?: Engine['name'];
}

/** The runtime A builds: the frozen AgentRuntime plus streaming. */
export interface StudioRuntime extends AgentRuntime {
  runWith<T>(task: AgentTask<T>, opts: RunOptions): Promise<AgentResult<T>>;
}

/** Runs a task with streaming when the runtime supports it (A's runtimes do), else plain `run`. */
export async function runAgent<T>(services: StudioServices, task: AgentTask<T>, opts: RunOptions = {}): Promise<AgentResult<T>> {
  const rt = services.runtime as Partial<StudioRuntime> & AgentRuntime;
  if (typeof rt.runWith === 'function') return rt.runWith(task, opts);
  const res = await rt.run(task);
  opts.onText?.(res.text);
  return res;
}

/** Upper bound per run, USD, whatever the headroom (a runaway tool loop stops here). */
export const RUN_CAP_USD: Readonly<Record<ModelTier, number>> = { fast: 0.25, standard: 1.5, strong: 3 };
const DEFAULT_MAX_TURNS = 8;

export interface LiveRuntimeOptions {
  llm: AnthropicLlm;
  /** Engines (tests inject fakes). Default: Messages API + Claude Agent SDK. */
  engines?: Partial<Record<Engine['name'], Engine>>;
  /** 'messages' | 'agent-sdk' forces one engine for every run (IOS_AGENT_ENGINE). */
  forceEngine?: Engine['name'];
}

/**
 * Builds the services every tool, job and agent uses. `mode`:
 * - 'fake' (default, tests): never calls a model;
 * - 'auto': live when `providers.llm` is the live Anthropic adapter (wiring overlays it only when the key is
 *   present, the integration has a live adapter and IOS_FAKE_PROVIDERS doesn't force fakes), else fake;
 * - 'live': requires the live adapter.
 */
export function createServices(
  opts: CreateServicesOptions & { runtime?: (services: StudioServices) => AgentRuntime; engines?: LiveRuntimeOptions['engines'] },
): StudioServices {
  const base: ServiceBase = { db: opts.db, providers: opts.providers ?? createFakeProviders(), now: opts.now ?? (() => new Date()) };
  const tools = createToolRegistry(opts.tools ?? []);
  const services: { -readonly [K in keyof StudioServices]: StudioServices[K] } = {
    ...base,
    tools,
    knowledge: (opts.knowledge ?? nullKnowledge)(base),
    cadence: (opts.cadence ?? defaultCadence)(base),
    routing: (opts.routing ?? defaultRouting)(base),
    runtime: undefined as unknown as AgentRuntime,
  };
  const mode = opts.mode ?? 'fake';
  const llm = base.providers.llm;
  if (opts.runtime) services.runtime = opts.runtime(services);
  else if (mode !== 'fake' && isAnthropicLlm(llm)) {
    const forced = process.env.IOS_AGENT_ENGINE;
    services.runtime = createLiveRuntime(services, {
      llm,
      engines: opts.engines,
      forceEngine: forced === 'messages' || forced === 'agent-sdk' ? forced : undefined,
    });
  } else if (mode === 'live') {
    throw new Error('live mode needs the Anthropic key (pnpm ios secrets set anthropic.api_key)');
  } else services.runtime = createFakeRuntime(services);
  return services;
}

interface Exec {
  model: string;
  text: string;
  structured?: unknown;
  usage: EngineUsage;
  toolCalls: ToolCallRecord[];
  engine: 'messages' | 'agent-sdk' | 'fake';
  stopReason: string | null;
}

type ExecFn = (task: AgentTask<any>, tier: ModelTier, ctx: { maxCostUsd: number; opts: RunOptions }) => Promise<Exec>;

/**
 * The shared run path for both modes: routing → governor reserve (refused past a cap, logged 'refused') → model
 * → settle the actual spend (partial spend of a failed run is still debited) → validate with `parse` → one
 * agent_run row with tokens, cache tokens, tool calls, engine and cost attribution.
 */
function pipeline(services: StudioServices, mode: 'live' | 'fake', exec: ExecFn): StudioRuntime {
  const runWith = async <T>(task: AgentTask<T>, opts: RunOptions): Promise<AgentResult<T>> => {
    const { db } = services;
    const { studioId, personaId } = task.scope;
    const tier = task.tier ?? (await services.routing.tierFor({ studioId, personaId, agent: task.agent })) ?? DEFAULT_ROUTING[task.agent];
    const inTok = estimateTokens([...(task.cached ?? []).map((b) => b.text), task.system, task.prompt].join('\n'));
    const maxTokens = task.maxTokens ?? (task.parse ? 2048 : 4096);
    const turns = mode === 'live' && task.tools?.length ? 2 : 1;
    const estimate = llmCostUsd(tier, inTok * turns, maxTokens);
    const startedAt = services.now();
    const ref = task.costRef;

    const log = (outcome: 'ok' | 'error' | 'refused', e: Partial<Exec> & { error?: string }) =>
      db.one<{ id: string }>(
        `INSERT INTO agent_run (studio_id, persona_id, agent, model, input_tokens, output_tokens, cost_usd, outcome, summary,
                                started_at, finished_at, mode, engine, cache_read_tokens, cache_write_tokens, tool_calls,
                                ref_type, ref_id, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), $11, $12, $13, $14, $15::jsonb, $16, $17, $18) RETURNING id`,
        [
          studioId,
          personaId,
          task.agent,
          e.model ?? (mode === 'fake' ? `fake:${MODEL_IDS[tier]}` : MODEL_IDS[tier]),
          e.usage?.inputTokens ?? 0,
          e.usage?.outputTokens ?? 0,
          e.usage?.costUsd ?? 0,
          outcome,
          task.label.slice(0, 200),
          startedAt,
          mode,
          e.engine ?? (mode === 'fake' ? 'fake' : null),
          e.usage?.cacheReadTokens ?? 0,
          e.usage?.cacheWriteTokens ?? 0,
          json(e.toolCalls ?? []),
          ref?.type ?? null,
          ref?.id ?? null,
          e.error ?? null,
        ],
      );

    // Headroom before the hold: the run may spend up to this much (capped per run).
    const st = await budgetStatus(db, { studioId, personaId, unit: 'llm_usd' });
    const room = (s: { limit: number | null; used: number } | null) => (s && s.limit !== null ? Math.max(0, s.limit - s.used) : Number.POSITIVE_INFINITY);
    const maxCostUsd = Math.min(room(st.persona), room(st.studio), RUN_CAP_USD[tier]);

    let res: Exec;
    try {
      res = await metered(
        db,
        { studioId, personaId, agent: task.agent, ref },
        { unit: 'llm_usd', estimate, provider: mode === 'fake' ? 'fake-llm' : 'anthropic', operation: `run:${tier}` },
        () => exec(task, tier, { maxCostUsd, opts }),
        (r) => r.usage.costUsd,
      );
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        await log('refused', { error: err.message });
        throw err;
      }
      // The hold was released; whatever a failed live run already spent is still debited (it was incurred).
      const partial = (err as { usage?: EngineUsage }).usage;
      if (partial && partial.costUsd > 0) {
        await debit(db, {
          studioId,
          personaId,
          unit: 'llm_usd',
          amount: partial.costUsd,
          provider: 'anthropic',
          operation: `run:${tier}`,
          refType: ref?.type,
          refId: ref?.id,
          meta: { agent: task.agent, failed: true },
          enforce: false,
        });
      }
      await log('error', { usage: partial, error: errorMessage(err) });
      throw err;
    }
    let output: T;
    try {
      if (task.parse) {
        const value = res.structured !== undefined ? res.structured : JSON.parse(res.text);
        output = task.parse(value);
      } else output = res.text as T;
    } catch (err) {
      await log('error', { ...res, error: errorMessage(err) });
      throw err instanceof AgentOutputError ? err : new AgentOutputError(`invalid output for "${task.label}": ${errorMessage(err)}`);
    }
    const run = await log('ok', res);
    return { output, text: res.text, mode, model: res.model, runId: run.id, costUsd: res.usage.costUsd, toolCalls: res.toolCalls };
  };
  return { mode, run: (task) => runWith(task, {}), runWith };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FAKE_STREAM_DELAY_MS = process.env.VITEST ? 0 : 12;

/**
 * Fake runtime: returns `task.fake()` through the same path a live run takes (routing → governor reserve →
 * "model" → settle → agent_run row), so budgets, refusals and P&L attribution behave as in production.
 */
export function createFakeRuntime(services: StudioServices): StudioRuntime {
  return pipeline(services, 'fake', async (task, tier, { opts }) => {
    const value = task.fake();
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    const llm = new FakeLlm(() => text);
    const req: LlmRequest = {
      tier,
      system: task.system,
      cached: task.cached,
      messages: [{ role: 'user', content: task.prompt }],
      maxTokens: task.maxTokens,
      json: task.parse !== undefined,
    };
    const r = await llm.complete(req);
    if (opts.onText) {
      const parts = text.split(/(?<=\s)/);
      for (let i = 0; i < parts.length; i += 3) {
        opts.onText(parts.slice(i, i + 3).join(''));
        if (FAKE_STREAM_DELAY_MS) await sleep(FAKE_STREAM_DELAY_MS);
      }
    }
    return {
      model: r.model,
      text: r.text,
      structured: task.parse ? value : undefined,
      usage: { inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: r.costUsd },
      toolCalls: [],
      engine: 'fake',
      stopReason: 'end_turn',
    };
  });
}

/** Which engine a live task uses: the Agent SDK for agent work (tools or skills), the Messages API for one-shot calls. */
export function pickEngine(task: Pick<AgentTask<unknown>, 'tools' | 'skills'>, forced?: Engine['name']): Engine['name'] {
  if (forced) return forced;
  return task.skills?.length || task.tools?.length ? 'agent-sdk' : 'messages';
}

/** Live runtime: Claude via the Messages API or the Claude Agent SDK, behind the same pipeline as the fake. */
export function createLiveRuntime(services: StudioServices, opts: LiveRuntimeOptions): StudioRuntime {
  const engines: Record<Engine['name'], Engine> = {
    messages: opts.engines?.messages ?? createMessagesEngine(opts.llm.messages, { fallbacks: process.env.IOS_LLM_FALLBACKS !== 'off' }),
    'agent-sdk': opts.engines?.['agent-sdk'] ?? createAgentSdkEngine({ sdk: loadAgentSdk, cwd: findRepoRoot(), env: () => opts.llm.agentSdkEnv() }),
  };
  return pipeline(services, 'live', async (task, tier, { maxCostUsd, opts: runOpts }) => {
    const caller = task.agent;
    const visible: Array<ToolDef<any, any>> = task.tools?.length ? services.tools.list({ caller, names: task.tools }) : [];
    const engine = engines[runOpts.engine ?? pickEngine(task, opts.forceEngine)];
    // The run's provenance: a tool whose result carries third-party text (news, comments, web) taints the rest of
    // the run, so a later mutating call needs the Owner's own ask (the registry enforces it).
    let trust: RunTrust | undefined = task.trust;
    const r: EngineResult = await engine.run({
      model: MODEL_IDS[tier],
      tier,
      cached: task.cached ?? [],
      system: task.system,
      prompt: task.prompt,
      tools: visible,
      invokeTool: async (name, input) => {
        const out = await services.tools.invoke(
          { services, studioId: task.scope.studioId, personaId: task.scope.personaId, caller, actor: { type: 'agent', id: caller }, trust },
          name,
          input,
        );
        if (services.tools.get(name)?.untrustedOutput && !trust?.untrusted) trust = { ...trust, untrusted: true };
        return out;
      },
      jsonSchema: task.parse ? (task.jsonSchema ?? { type: 'object' }) : undefined,
      skills: task.skills,
      maxTokens: task.maxTokens ?? (task.parse ? 2048 : 4096),
      maxTurns: visible.length ? DEFAULT_MAX_TURNS : task.skills?.length ? 4 : 1,
      maxCostUsd,
      effort: EFFORT[tier],
      onText: runOpts.onText,
    });
    return r;
  });
}
