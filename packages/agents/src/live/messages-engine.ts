import type Anthropic from '@anthropic-ai/sdk';
import type { ToolCallRecord } from '../contracts';
import {
  AgentOutputError,
  AgentRefusalError,
  type Engine,
  type EngineRequest,
  type EngineResult,
  type EngineUsage,
  errorMessage,
  toolNameMap,
  toolResultText,
  usageCost,
} from './engine';

type BetaMessage = Anthropic.Beta.BetaMessage;
type BetaParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
type BetaTextBlockParam = Anthropic.Beta.BetaTextBlockParam;
type BetaTool = Anthropic.Beta.BetaTool;
type BetaToolResultBlockParam = Anthropic.Beta.BetaToolResultBlockParam;

/** The slice of a streaming Messages call the engine uses (the SDK's BetaMessageStream; tests pass a fake). */
export interface MessageStreamLike {
  on(event: 'text', listener: (delta: string) => void): unknown;
  finalMessage(): Promise<BetaMessage>;
}
/** The slice of the Anthropic client the engine uses. */
export interface MessagesClient {
  stream(params: BetaParams): MessageStreamLike;
}

/** Server-side refusal fallback (Claude API): on a policy decline the API retries on a suitable model in-call. */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/**
 * Claude Messages API engine: one-shot structured calls and registry-tool loops.
 * - Prompt caching: tools (sorted, stable) → cached blocks (cache_control on the last one) → the call's system text;
 *   tool loops also set top-level cache_control so the growing conversation is cached turn to turn.
 * - Structured output through `output_config.format` (no forced tool_choice, no prefill on these models).
 * - Effort is set explicitly (Opus 5.5 / Haiku 5.5 default to medium, Sonnet 5.5 to high); thinking is left adaptive.
 * - `stop_reason: "refusal"` throws AgentRefusalError; `pause_turn` continues; tool errors go back as is_error results.
 * - Spend is checked against `maxCostUsd` before every extra turn.
 */
export function createMessagesEngine(client: MessagesClient, opts: { fallbacks?: boolean } = {}): Engine {
  return {
    name: 'messages',
    async run(req: EngineRequest): Promise<EngineResult> {
      const names = toolNameMap(req.tools);
      const tools: BetaTool[] = [...req.tools]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((d) => ({
          name: names.toApi.get(d.name)!,
          description: d.description,
          input_schema: d.inputSchema as BetaTool['input_schema'],
        }));
      const system: BetaTextBlockParam[] = req.cached.map((b, i) => ({
        type: 'text' as const,
        text: b.text,
        ...(i === req.cached.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
      }));
      system.push({ type: 'text', text: req.system });
      const messages: BetaMessageParam[] = [{ role: 'user', content: req.prompt }];
      const useFallbacks = (opts.fallbacks ?? true) && req.tier !== 'fast';
      const usage: EngineUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
      const toolCalls: ToolCallRecord[] = [];
      let text = '';
      let model = req.model;
      let stopReason: string | null = null;

      try {
        for (let turn = 0; ; turn++) {
          if (turn > 0 && (turn >= req.maxTurns || usage.costUsd >= req.maxCostUsd)) {
            stopReason = turn >= req.maxTurns ? 'max_turns' : 'budget';
            break;
          }
          const params: BetaParams = {
            model: req.model,
            max_tokens: req.maxTokens,
            system,
            messages,
            output_config: {
              effort: req.effort,
              ...(req.jsonSchema ? { format: { type: 'json_schema' as const, schema: { ...req.jsonSchema } } } : {}),
            },
            ...(tools.length ? { tools, cache_control: { type: 'ephemeral' as const } } : {}),
            ...(useFallbacks ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
          };
          const stream = client.stream(params);
          let turnText = '';
          stream.on('text', (delta) => {
            turnText += delta;
            req.onText?.(delta);
          });
          const msg = await stream.finalMessage();
          model = msg.model ?? model;
          const u = msg.usage;
          usage.inputTokens += u?.input_tokens ?? 0;
          usage.outputTokens += u?.output_tokens ?? 0;
          usage.cacheReadTokens += u?.cache_read_input_tokens ?? 0;
          usage.cacheWriteTokens += u?.cache_creation_input_tokens ?? 0;
          usage.costUsd = usageCost(model, req.tier, usage);
          stopReason = msg.stop_reason ?? null;
          const blockText = msg.content
            .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
            .map((b) => b.text)
            .join('');
          text += blockText || turnText;

          if (msg.stop_reason === 'refusal') {
            const details = (msg as { stop_details?: { category?: string | null } | null }).stop_details;
            throw new AgentRefusalError(details?.category ?? null);
          }
          if (msg.stop_reason === 'pause_turn') {
            messages.push({ role: 'assistant', content: msg.content as BetaMessageParam['content'] });
            continue;
          }
          const uses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
          if (msg.stop_reason !== 'tool_use' || uses.length === 0) break;
          if (msg.stop_reason === 'tool_use' && uses.length && text && !text.endsWith('\n')) {
            // Keep the text of separate turns readable when they are concatenated.
            text += '\n\n';
            req.onText?.('\n\n');
          }
          messages.push({ role: 'assistant', content: msg.content as BetaMessageParam['content'] });
          const results: BetaToolResultBlockParam[] = [];
          // Sequential on purpose: tools write to the same database and are cheap.
          for (const use of uses) {
            const name = names.fromApi.get(use.name);
            const started = Date.now();
            if (!name) {
              results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: `unknown tool: ${use.name}` });
              toolCalls.push({ tool: use.name, ok: false, error: 'unknown tool', ms: 0 });
              continue;
            }
            try {
              const out = await req.invokeTool(name, use.input);
              results.push({ type: 'tool_result', tool_use_id: use.id, content: toolResultText(out) });
              toolCalls.push({ tool: name, ok: true, ms: Date.now() - started });
            } catch (err) {
              results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: errorMessage(err) });
              toolCalls.push({ tool: name, ok: false, error: errorMessage(err), ms: Date.now() - started });
            }
          }
          messages.push({ role: 'user', content: results });
        }
      } catch (err) {
        // What a failed run already spent is still debited by the runtime.
        if (err && typeof err === 'object' && !('usage' in err)) Object.assign(err, { usage: { ...usage } });
        throw err;
      }

      let structured: unknown;
      if (req.jsonSchema) {
        try {
          structured = JSON.parse(text);
        } catch {
          // Truncated or non-JSON output was still paid for: the runtime debits err.usage.
          throw Object.assign(new AgentOutputError(`expected JSON output, got: ${text.slice(0, 120)}`), { usage: { ...usage } });
        }
      }
      return { text, structured, model, usage, toolCalls, stopReason, engine: 'messages' };
    },
  };
}
