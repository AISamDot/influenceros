import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ToolCallRecord, ToolDef } from '../contracts';
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

/** The Agent SDK entry points the engine uses (`query`, `tool`, `createSdkMcpServer`); tests inject fakes. */
export interface AgentSdk {
  query(params: { prompt: string; options?: Options }): AsyncIterable<SDKMessage>;
  createSdkMcpServer(opts: { name: string; version?: string; tools?: unknown[]; alwaysLoad?: boolean }): unknown;
  tool(name: string, description: string, shape: Record<string, z.ZodType>, handler: (args: Record<string, unknown>) => Promise<ToolHandlerResult>): unknown;
  readonly SYSTEM_PROMPT_DYNAMIC_BOUNDARY: string;
}

export interface ToolHandlerResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [k: string]: unknown;
}

/** Loads the real SDK lazily, so tests and fake-mode installs never start a Claude Code process. */
export async function loadAgentSdk(): Promise<AgentSdk> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  return {
    query: (p) => sdk.query(p),
    createSdkMcpServer: (o) => sdk.createSdkMcpServer(o as Parameters<typeof sdk.createSdkMcpServer>[0]),
    tool: (n, d, s, h) => sdk.tool(n, d, s, h as Parameters<typeof sdk.tool>[3]),
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY: sdk.SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  };
}

/** Built-in Claude Code tools studio agents never get, even if a setting or skill asks for them. */
export const DISALLOWED_BUILTINS = [
  'Bash',
  'BashOutput',
  'KillShell',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Task',
  'Agent',
  'TodoWrite',
] as const;

export const MCP_SERVER = 'studio';

/** Registry JSON Schema → the zod raw shape the SDK's `tool()` expects (the registry re-validates with `parse`). */
export function zodShape(schema: Readonly<Record<string, unknown>>): Record<string, z.ZodType> {
  const props = (schema.properties ?? {}) as Record<string, unknown>;
  const required = new Set((schema.required ?? []) as string[]);
  const shape: Record<string, z.ZodType> = {};
  for (const [key, prop] of Object.entries(props)) {
    let t: z.ZodType;
    try {
      t = z.fromJSONSchema(prop as Parameters<typeof z.fromJSONSchema>[0]);
    } catch {
      t = z.unknown();
    }
    shape[key] = required.has(key) ? t : t.optional();
  }
  return shape;
}

/**
 * Claude Agent SDK engine (PRD §8.4: agents run on the Agent SDK). Hard limits, set in code:
 * - `tools`: no built-in tools except `Skill` when the task names skills; `disallowedTools` removes the rest
 *   (Bash, Write, Edit, Read, web, subagents). Only registry tools are exposed, through an in-process MCP server,
 *   and every call still goes through the registry's permission checks.
 * - `settingSources: ['project']` with `cwd` at the repo root so `.claude/skills` resolve; skills are limited to
 *   the task's list; `disableSkillShellExecution` stops inline shell in skills.
 * - `permissionMode: 'dontAsk'`: anything not pre-approved is denied (no prompt surface on a server).
 * - The cached blocks go first in the system prompt, before the dynamic boundary, so they prompt-cache.
 * - `maxBudgetUsd` and `maxTurns` bound the run; the subprocess gets only PATH/HOME and the Anthropic key.
 */
export function createAgentSdkEngine(opts: { sdk: () => Promise<AgentSdk>; cwd: string; env: () => Record<string, string | undefined> }): Engine {
  return {
    name: 'agent-sdk',
    async run(req: EngineRequest): Promise<EngineResult> {
      const sdk = await opts.sdk();
      const names = toolNameMap(req.tools);
      const toolCalls: ToolCallRecord[] = [];
      const handler = (def: ToolDef<any, any>) => async (args: Record<string, unknown>): Promise<ToolHandlerResult> => {
        const started = Date.now();
        try {
          const out = await req.invokeTool(def.name, args);
          toolCalls.push({ tool: def.name, ok: true, ms: Date.now() - started });
          return { content: [{ type: 'text', text: toolResultText(out) }] };
        } catch (err) {
          toolCalls.push({ tool: def.name, ok: false, error: errorMessage(err), ms: Date.now() - started });
          return { content: [{ type: 'text', text: errorMessage(err) }], isError: true };
        }
      };
      const sdkTools = [...req.tools]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((d) => sdk.tool(names.toApi.get(d.name)!, d.description, zodShape(d.inputSchema), handler(d)));
      const allowed = req.tools.map((d) => `mcp__${MCP_SERVER}__${names.toApi.get(d.name)}`).sort();
      const skills = [...(req.skills ?? [])];
      const options: Options = {
        model: req.model,
        cwd: opts.cwd,
        settingSources: ['project'],
        settings: { disableSkillShellExecution: true },
        systemPrompt: [...req.cached.map((b) => b.text), sdk.SYSTEM_PROMPT_DYNAMIC_BOUNDARY, req.system],
        tools: skills.length ? ['Skill'] : [],
        ...(skills.length ? { skills } : {}),
        disallowedTools: [...DISALLOWED_BUILTINS],
        allowedTools: allowed,
        mcpServers: req.tools.length
          ? { [MCP_SERVER]: sdk.createSdkMcpServer({ name: MCP_SERVER, version: '1.0.0', tools: sdkTools, alwaysLoad: true }) as NonNullable<Options['mcpServers']>[string] }
          : {},
        strictMcpConfig: true,
        permissionMode: 'dontAsk',
        maxTurns: req.maxTurns,
        maxBudgetUsd: req.maxCostUsd,
        effort: req.effort,
        includePartialMessages: Boolean(req.onText),
        persistSession: false,
        env: opts.env(),
        ...(req.jsonSchema ? { outputFormat: { type: 'json_schema', schema: { ...req.jsonSchema } } } : {}),
      };

      let result: Extract<SDKMessage, { type: 'result' }> | null = null;
      let streamed = '';
      for await (const m of sdk.query({ prompt: req.prompt, options })) {
        if (m.type === 'stream_event' && m.parent_tool_use_id === null && req.onText) {
          const e = m.event;
          if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') {
            streamed += e.delta.text;
            req.onText(e.delta.text);
          }
        } else if (m.type === 'result') {
          result = m;
        }
      }
      if (!result) throw new Error('Agent SDK run ended without a result');
      const u = result.usage;
      const usage: EngineUsage = {
        inputTokens: u?.input_tokens ?? 0,
        outputTokens: u?.output_tokens ?? 0,
        cacheReadTokens: u?.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
        costUsd: 0,
      };
      const model = Object.keys(result.modelUsage ?? {})[0] ?? req.model;
      usage.costUsd = usageCost(model, req.tier, usage);
      // Every failure after a result was paid for: attach the usage so the runtime debits it.
      const billed = <E extends Error>(err: E): E => Object.assign(err, { usage: { ...usage } });
      if (result.stop_reason === 'refusal') throw billed(new AgentRefusalError(null));
      if (result.subtype !== 'success') {
        // Over budget or turns: keep what was produced; anything else is an error.
        if (result.subtype === 'error_max_budget_usd' || result.subtype === 'error_max_turns') {
          return { text: streamed, model, usage, toolCalls, stopReason: result.subtype === 'error_max_turns' ? 'max_turns' : 'budget', engine: 'agent-sdk' };
        }
        throw billed(new Error(`Agent SDK run failed: ${result.subtype}${'errors' in result && result.errors?.length ? `: ${result.errors.join('; ')}` : ''}`));
      }
      let structured: unknown;
      if (req.jsonSchema) {
        structured = result.structured_output;
        if (structured === undefined) {
          try {
            structured = JSON.parse(result.result);
          } catch {
            throw billed(new AgentOutputError(`expected JSON output, got: ${result.result.slice(0, 120)}`));
          }
        }
      }
      return { text: result.result, structured, model, usage, toolCalls, stopReason: result.stop_reason, engine: 'agent-sdk' };
    },
  };
}
