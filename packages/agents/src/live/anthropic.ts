import { inspect } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { estimateTokens, LLM_PRICES, type LlmProvider, type LlmRequest, type LlmResponse } from '@troupe/providers';
import { createMessagesEngine, type MessagesClient, type MessageStreamLike } from './messages-engine';

/** Effort per tier: Haiku runs low (classification), Sonnet and Opus medium (set explicitly; defaults differ). */
export const EFFORT = { fast: 'low', standard: 'medium', strong: 'medium' } as const;

/**
 * The live `llm` provider (Anthropic API key from the Keychain or ANTHROPIC_API_KEY). The agent runtime goes live
 * when `providers.llm` is one of these; the key never leaves this object except into the Agent SDK subprocess env.
 */
export class AnthropicLlm implements LlmProvider {
  readonly name = 'anthropic';
  readonly messages: MessagesClient;
  readonly #apiKey: string;

  constructor(opts: { apiKey: string; client?: MessagesClient }) {
    if (!opts.apiKey) throw new Error('AnthropicLlm needs an API key');
    this.#apiKey = opts.apiKey;
    if (opts.client) {
      this.messages = opts.client;
    } else {
      const client = new Anthropic({ apiKey: opts.apiKey, maxRetries: 2 });
      this.messages = { stream: (params) => client.beta.messages.stream(params) as unknown as MessageStreamLike };
    }
  }

  /** Environment for the Claude Agent SDK process: PATH/HOME and the Anthropic key only, no other app secrets. */
  agentSdkEnv(): Record<string, string | undefined> {
    return {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      ANTHROPIC_API_KEY: this.#apiKey,
      CLAUDE_AGENT_SDK_CLIENT_APP: 'troupe-house/0.2',
      DISABLE_AUTOUPDATER: '1',
    };
  }

  /** Raw completion (no tools). Agents go through `services.runtime.run()`, which meters and logs. */
  async complete(req: LlmRequest): Promise<LlmResponse> {
    const engine = createMessagesEngine(this.messages);
    const text = req.messages.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n');
    const r = await engine.run({
      model: LLM_PRICES[req.tier].model,
      tier: req.tier,
      cached: req.cached ?? [],
      system: req.system ?? '',
      prompt: req.messages.length === 1 ? (req.messages[0]?.content ?? '') : text,
      tools: [],
      invokeTool: async () => {
        throw new Error('no tools');
      },
      jsonSchema: req.json ? { type: 'object', additionalProperties: true } : undefined,
      maxTokens: req.maxTokens ?? 4096,
      maxTurns: 1,
      maxCostUsd: Number.POSITIVE_INFINITY,
      effort: EFFORT[req.tier],
    });
    return {
      text: r.text,
      model: r.model,
      inputTokens: r.usage.inputTokens || estimateTokens(text),
      outputTokens: r.usage.outputTokens,
      cacheReadTokens: r.usage.cacheReadTokens,
      cacheWriteTokens: r.usage.cacheWriteTokens,
      costUsd: r.usage.costUsd,
    };
  }

  toJSON(): string {
    return '[AnthropicLlm]';
  }
  [inspect.custom](): string {
    return '[AnthropicLlm]';
  }
}

export const isAnthropicLlm = (p: unknown): p is AnthropicLlm => p instanceof AnthropicLlm;
