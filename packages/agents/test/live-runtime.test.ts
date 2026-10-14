import type Anthropic from '@anthropic-ai/sdk';
import { BudgetExceededError, STUDIO_MANAGER } from '@ios/core';
import { createFakeProviders } from '@ios/providers';
import { describe, expect, it } from 'vitest';
import {
  A_TOOLS,
  AgentRefusalError,
  type AgentSdk,
  AnthropicLlm,
  createAgentSdkEngine,
  createLiveRuntime,
  createServices,
  DISALLOWED_BUILTINS,
  liveProviders,
  type MessagesClient,
  runAgent,
} from '../src';
import { createTestStudio, makeTestPersona } from '../src/testing';

type Params = Parameters<MessagesClient['stream']>[0];
type Reply = { text?: string; tool?: { name: string; input: unknown }; stop?: string; usage?: Partial<Anthropic.Beta.BetaUsage>; category?: string };

/** A scripted Messages API: each call returns the next reply, streaming its text; records the params. */
function scriptedClient(replies: Reply[]): MessagesClient & { calls: Params[] } {
  const calls: Params[] = [];
  return {
    calls,
    stream(params) {
      calls.push(structuredClone(params));
      const r = replies.shift() ?? { text: 'done' };
      const listeners: Array<(d: string) => void> = [];
      return {
        on(_e: 'text', l: (d: string) => void) {
          listeners.push(l);
          return this;
        },
        async finalMessage() {
          if (r.text) for (const chunk of r.text.match(/.{1,5}/gs) ?? []) for (const l of listeners) l(chunk);
          const content: unknown[] = [];
          if (r.text) content.push({ type: 'text', text: r.text, citations: null });
          if (r.tool) content.push({ type: 'tool_use', id: `tu_${calls.length}`, name: r.tool.name, input: r.tool.input });
          return {
            id: `msg_${calls.length}`,
            type: 'message',
            role: 'assistant',
            model: params.model,
            content,
            stop_reason: r.stop ?? (r.tool ? 'tool_use' : 'end_turn'),
            stop_sequence: null,
            ...(r.category ? { stop_details: { type: 'refusal', category: r.category, explanation: null } } : {}),
            usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...r.usage },
          } as unknown as Anthropic.Beta.BetaMessage;
        },
      };
    },
  };
}

async function liveStudio(replies: Reply[], sdk?: AgentSdk) {
  const t = await createTestStudio({ tools: A_TOOLS });
  const client = scriptedClient(replies);
  const llm = new AnthropicLlm({ apiKey: 'sk-ant-test-only', client });
  const services = createServices({
    db: t.db,
    providers: { ...createFakeProviders(), llm },
    mode: 'auto',
    tools: A_TOOLS,
    engines: sdk ? { 'agent-sdk': createAgentSdkEngine({ sdk: async () => sdk, cwd: '/repo', env: () => llm.agentSdkEnv() }) } : undefined,
  });
  return { ...t, services, client, llm };
}

describe('live runtime: Messages API engine', () => {
  it('sends cached blocks first (cache_control on the last), structured output via output_config, and logs cache tokens', async () => {
    const t = await liveStudio([{ text: '{"hooks":["a","b"]}', usage: { cache_read_input_tokens: 4000, cache_creation_input_tokens: 0 } }]);
    expect(t.services.runtime.mode).toBe('live');
    const p = await makeTestPersona(t);
    const res = await t.services.runtime.run({
      agent: 'scriptwriter',
      scope: { studioId: t.studioId, personaId: p.id },
      label: 'hook-lab: test',
      system: 'Write hooks as JSON.',
      cached: [
        { key: 'rules:v1', text: 'Studio rules' },
        { key: `bible:${p.id}:v1`, text: 'Bible text' },
      ],
      prompt: 'Two hooks about saving.',
      jsonSchema: { type: 'object', properties: { hooks: { type: 'array', items: { type: 'string' } } }, required: ['hooks'], additionalProperties: false },
      parse: (v) => (v as { hooks: string[] }).hooks,
      fake: () => [],
    });
    expect(res).toMatchObject({ mode: 'live', output: ['a', 'b'], model: 'claude-sonnet-5-5' });
    const call = t.client.calls[0]!;
    expect(call.model).toBe('claude-sonnet-5-5');
    const system = call.system as Array<{ text: string; cache_control?: unknown }>;
    expect(system.map((b) => b.text)).toEqual(['Studio rules', 'Bible text', 'Write hooks as JSON.']);
    expect(system.map((b) => Boolean(b.cache_control))).toEqual([false, true, false]);
    expect(call.output_config).toMatchObject({ effort: 'medium', format: { type: 'json_schema' } });
    expect(call).not.toHaveProperty('tool_choice');
    // Sonnet / Opus calls opt into server-side refusal fallbacks; Haiku doesn't.
    expect(call).toMatchObject({ betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });

    const run = await t.db.one<{ mode: string; engine: string; cache_read_tokens: number; input_tokens: number; cost_usd: number; outcome: string }>(
      'SELECT mode, engine, cache_read_tokens, input_tokens, cost_usd, outcome FROM agent_run WHERE id = $1',
      [res.runId],
    );
    expect(run).toMatchObject({ mode: 'live', engine: 'messages', cache_read_tokens: 4000, input_tokens: 1000, outcome: 'ok' });
    // Sonnet 5.5: 1000 in × $2/M + 200 out × $10/M + 4000 cache reads × $0.20/M.
    expect(run.cost_usd).toBeCloseTo(0.002 + 0.002 + 0.0008, 6);
    const debit = await t.db.one<{ amount: number }>(`SELECT amount FROM credit_ledger WHERE entry_type = 'debit' AND persona_id = $1`, [p.id]);
    expect(debit.amount).toBeCloseTo(res.costUsd, 6);
    expect(await t.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM credit_ledger WHERE entry_type = 'hold'`)).toEqual({ n: 0 });
    await t.db.close();
  });

  it("runs the registry tool loop: a refused tool goes back to the model as an error, and the run doesn't end", async () => {
    const t = await liveStudio([]);
    const mine = await makeTestPersona(t, { name: 'Vivian Hale' });
    const other = await makeTestPersona(t, { name: 'Amos Reed' });
    t.client.calls.length = 0;
    const replies: Reply[] = [
      { text: 'Checking.', tool: { name: 'persona__status', input: { persona_id: other.id } } },
      { tool: { name: 'persona__status', input: { persona_id: mine.id } } },
      { text: 'Vivian is testing.' },
    ];
    const client = scriptedClient(replies);
    const services = createServices({
      db: t.db,
      tools: A_TOOLS,
      runtime: (s) => createLiveRuntime(s, { llm: new AnthropicLlm({ apiKey: 'k', client }), forceEngine: 'messages' }),
    });
    const deltas: string[] = [];
    const res = await runAgent(
      services,
      {
        agent: 'persona-manager',
        scope: { studioId: t.studioId, personaId: mine.id },
        label: 'chat',
        system: 's',
        prompt: 'status?',
        tools: ['persona.status', 'studio.propose_kill', 'approvals.decide'],
        fake: () => '',
      },
      { onText: (d) => deltas.push(d) },
    );
    // Only tools the caller may see are offered: studio.propose_kill (Studio Manager only) and approvals.decide (Owner only) are not.
    expect((client.calls[0]!.tools as Array<{ name: string }>).map((x) => x.name)).toEqual(['persona__status']);
    expect(res.toolCalls.map((c) => [c.tool, c.ok])).toEqual([
      ['persona.status', false],
      ['persona.status', true],
    ]);
    expect(res.toolCalls[0]!.error).toMatch(/own persona/);
    const second = client.calls[1]!.messages.at(-1)!.content as Array<{ type: string; is_error?: boolean; content: string }>;
    expect(second[0]).toMatchObject({ type: 'tool_result', is_error: true });
    expect(res.text).toBe('Checking.\n\nVivian is testing.');
    expect(deltas.join('')).toBe(res.text);
    // Tool loops also cache the growing conversation.
    expect(client.calls[1]).toMatchObject({ cache_control: { type: 'ephemeral' } });
    const run = await t.db.one<{ tool_calls: unknown[] }>('SELECT tool_calls FROM agent_run WHERE id = $1', [res.runId]);
    expect(run.tool_calls).toHaveLength(2);
    await t.db.close();
  });

  it('a refusal ends the run as an error; spend already incurred is still debited', async () => {
    const t = await liveStudio([{ stop: 'refusal', category: 'cyber' }]);
    const p = await makeTestPersona(t);
    await expect(
      t.services.runtime.run({ agent: 'compliance-gate', scope: { studioId: t.studioId, personaId: p.id }, label: 'gate', system: 's', prompt: 'p', fake: () => 'x' }),
    ).rejects.toBeInstanceOf(AgentRefusalError);
    const run = await t.db.one<{ outcome: string; error: string }>('SELECT outcome, error FROM agent_run');
    expect(run.outcome).toBe('error');
    expect(run.error).toMatch(/declined/);
    // Haiku: no fallback beta on the fast tier.
    expect(t.client.calls[0]).not.toHaveProperty('fallbacks');
    const debits = await t.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM credit_ledger WHERE entry_type = 'debit'`);
    expect(debits.n).toBe(1);
    await t.db.close();
  });

  it('refuses before calling Claude when the cap is reached', async () => {
    const t = await liveStudio([{ text: 'never' }]);
    const p = await makeTestPersona(t, { budget: { llm_usd_month: 0 } });
    await expect(
      t.services.runtime.run({ agent: 'persona-manager', scope: { studioId: t.studioId, personaId: p.id }, label: 'x', system: 's', prompt: 'p', fake: () => 'ok' }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(t.client.calls).toHaveLength(0);
    expect((await t.db.one<{ outcome: string }>('SELECT outcome FROM agent_run')).outcome).toBe('refused');
    await t.db.close();
  });
});

describe('live runtime: Claude Agent SDK engine', () => {
  function fakeSdk(handlerArgs: (handlers: Map<string, (a: Record<string, unknown>) => Promise<unknown>>) => Promise<void>) {
    const seen: { options?: Record<string, unknown>; prompt?: string } = {};
    const handlers = new Map<string, (a: Record<string, unknown>) => Promise<unknown>>();
    const sdk: AgentSdk = {
      SYSTEM_PROMPT_DYNAMIC_BOUNDARY: '__BOUNDARY__',
      tool: (name, _d, _s, h) => {
        handlers.set(name, h as (a: Record<string, unknown>) => Promise<unknown>);
        return { name };
      },
      createSdkMcpServer: (o) => ({ type: 'sdk', name: o.name, tools: o.tools }),
      async *query({ prompt, options }) {
        seen.prompt = prompt;
        seen.options = options as Record<string, unknown>;
        await handlerArgs(handlers);
        yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } } } as never;
        yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Owner.' } } } as never;
        yield {
          type: 'result',
          subtype: 'success',
          result: 'Hello Owner.',
          stop_reason: 'end_turn',
          usage: { input_tokens: 500, output_tokens: 50, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 },
          modelUsage: { 'claude-opus-5-5': {} },
        } as never;
      },
    };
    return { sdk, seen };
  }

  it('runs with hard tool limits, project skills, cached system prefix and registry-checked MCP tools', async () => {
    let refused: unknown;
    let allowed: unknown;
    const { sdk, seen } = fakeSdk(async (handlers) => {
      const status = handlers.get('persona__status')!;
      refused = await status({ persona_id: '00000000-0000-4000-8000-000000000000' });
      allowed = await handlers.get('studio__overview')!({});
    });
    const t = await liveStudio([], sdk);
    await makeTestPersona(t);
    const deltas: string[] = [];
    const res = await runAgent(
      t.services,
      {
        agent: 'studio-manager',
        scope: { studioId: t.studioId, personaId: null },
        label: 'chat',
        system: 'You are the Studio Manager.',
        cached: [{ key: 'rules:v1', text: 'Studio rules' }],
        skills: ['kill-scale-analyst'],
        prompt: 'How are we doing?',
        tools: ['studio.overview', 'persona.status'],
        fake: () => '',
      },
      { onText: (d) => deltas.push(d) },
    );
    const o = seen.options!;
    expect(o).toMatchObject({
      model: 'claude-opus-5-5',
      cwd: '/repo',
      settingSources: ['project'],
      settings: { disableSkillShellExecution: true },
      tools: ['Skill'],
      skills: ['kill-scale-analyst'],
      permissionMode: 'dontAsk',
      strictMcpConfig: true,
      persistSession: false,
      includePartialMessages: true,
      systemPrompt: ['Studio rules', '__BOUNDARY__', 'You are the Studio Manager.'],
      allowedTools: ['mcp__studio__persona__status', 'mcp__studio__studio__overview'],
    });
    for (const banned of ['Bash', 'Write', 'Edit', 'Read', 'WebFetch']) expect(o.disallowedTools).toContain(banned);
    expect(DISALLOWED_BUILTINS).toContain('Bash');
    // The subprocess gets the Anthropic key and PATH/HOME, never the app's other env (DATABASE_URL, other keys).
    const env = o.env as Record<string, string | undefined>;
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-test-only');
    expect(Object.keys(env).sort()).toEqual(['ANTHROPIC_API_KEY', 'CLAUDE_AGENT_SDK_CLIENT_APP', 'DISABLE_AUTOUPDATER', 'HOME', 'PATH', 'TMPDIR']);
    expect(Number(o.maxBudgetUsd)).toBeGreaterThan(0);
    // An unknown persona is refused by the registry and returned to the model as a tool error.
    expect(refused).toMatchObject({ isError: true });
    expect((allowed as { content: Array<{ text: string }> }).content[0]!.text).toMatch(/"personas"/);
    expect(res).toMatchObject({ text: 'Hello Owner.', mode: 'live', model: 'claude-opus-5-5' });
    expect(deltas.join('')).toBe('Hello Owner.');
    const run = await t.db.one<{ engine: string; cache_read_tokens: number }>('SELECT engine, cache_read_tokens FROM agent_run WHERE id = $1', [res.runId]);
    expect(run).toEqual({ engine: 'agent-sdk', cache_read_tokens: 9000 });
    await t.db.close();
  });
});

describe('live mode switch and live providers', () => {
  it("'auto' stays fake without the Anthropic adapter; 'live' needs it; keys never print", async () => {
    const t = await createTestStudio();
    expect(createServices({ db: t.db, mode: 'auto' }).runtime.mode).toBe('fake');
    expect(() => createServices({ db: t.db, mode: 'live' })).toThrow(/Anthropic key/);
    expect(liveProviders({ isLive: () => false, secret: () => 'x' })).toEqual({});
    const live = liveProviders({ isLive: (id) => id === 'anthropic' || id === 'resend', secret: (n) => `secret-${n}` });
    expect(live.llm).toBeInstanceOf(AnthropicLlm);
    expect(live.email?.name).toBe('resend');
    expect(JSON.stringify(live)).not.toMatch(/secret-/);
    // The studio manager acting through the registry is never mistaken for the Owner.
    expect(STUDIO_MANAGER.type).toBe('agent');
    await t.db.close();
  });
});
