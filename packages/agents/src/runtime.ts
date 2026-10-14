import { BudgetExceededError, metered } from '@ios/core';
import { createFakeProviders, estimateTokens, FakeLlm, llmCostUsd, type LlmRequest } from '@ios/providers';
import {
  type AgentResult,
  type AgentRuntime,
  type AgentTask,
  type CreateServicesOptions,
  DEFAULT_ROUTING,
  type ServiceBase,
  type StudioServices,
} from './contracts';
import { defaultCadence, defaultRouting, nullKnowledge } from './defaults';
import { createToolRegistry } from './registry';

/**
 * Builds the services every tool, job and agent uses. Stream A owns the body (live Claude runtime, tool loop,
 * prompt caching); the signature is frozen. Today only the fake runtime exists: 'auto' and 'live' fall back to
 * fake until stream A lands the live path.
 */
export function createServices(opts: CreateServicesOptions): StudioServices {
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
  services.runtime = createFakeRuntime(services);
  return services;
}

/**
 * Fake runtime: returns `task.fake()` through the same path a live run takes (routing → governor reserve →
 * "model" → settle → agent_run row), so budgets, refusals and P&L attribution behave as in production.
 */
export function createFakeRuntime(services: StudioServices): AgentRuntime {
  return {
    mode: 'fake',
    async run<T>(task: AgentTask<T>): Promise<AgentResult<T>> {
      const { db } = services;
      const { studioId, personaId } = task.scope;
      const tier = task.tier ?? (await services.routing.tierFor({ studioId, personaId, agent: task.agent })) ?? DEFAULT_ROUTING[task.agent];
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
      const inTok = estimateTokens([...(task.cached ?? []).map((b) => b.text), task.system, task.prompt].join('\n'));
      const startedAt = services.now();
      const log = (outcome: 'ok' | 'error' | 'refused', model: string, i = 0, o = 0, cost = 0) =>
        db.one<{ id: string }>(
          `INSERT INTO agent_run (studio_id, persona_id, agent, model, input_tokens, output_tokens, cost_usd, outcome, summary, started_at, finished_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now()) RETURNING id`,
          [studioId, personaId, task.agent, model, i, o, cost, outcome, task.label.slice(0, 200), startedAt],
        );
      let res;
      try {
        res = await metered(
          db,
          { studioId, personaId, agent: task.agent, ref: task.costRef },
          { unit: 'llm_usd', estimate: llmCostUsd(tier, inTok, task.maxTokens ?? 1024), provider: llm.name, operation: `run:${tier}` },
          () => llm.complete(req),
          (r) => r.costUsd,
        );
      } catch (err) {
        await log(err instanceof BudgetExceededError ? 'refused' : 'error', `fake:${tier}`);
        throw err;
      }
      let output: T;
      try {
        output = task.parse ? task.parse(typeof value === 'string' ? value : JSON.parse(res.text)) : (res.text as T);
      } catch (err) {
        await log('error', res.model, res.inputTokens, res.outputTokens, res.costUsd);
        throw err;
      }
      const run = await log('ok', res.model, res.inputTokens, res.outputTokens, res.costUsd);
      return { output, text: res.text, mode: 'fake', model: res.model, runId: run.id, costUsd: res.costUsd, toolCalls: [] };
    },
  };
}
