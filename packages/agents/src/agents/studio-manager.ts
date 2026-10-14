import { type ChatMessageRow, PLATFORMS, type Platform, STUDIO_MANAGER } from '@ios/core';
import type { CostRef } from '@ios/core';
import type { StudioServices, ToolContext } from '../contracts';
import { compact, studioOverview, type StudioOverview, usd } from '../data';
import { errorMessage } from '../live/engine';
import { runAgent } from '../runtime';
import { type AgentReply, today, toolNamesFor, transcript } from './common';
import { STUDIO_MANAGER_SYSTEM, STUDIO_RULES_BLOCK } from './prompts';

export interface StudioTurnInput {
  studioId: string;
  threadId: string;
  text: string;
  history: readonly ChatMessageRow[];
  mentions: ReadonlyArray<{ id: string; slug: string; name: string }>;
  onText?: (delta: string) => void;
}

export function overviewText(o: StudioOverview): string {
  const states = Object.entries(o.personas.by_state)
    .filter(([s]) => s !== 'KILLED' && s !== 'RETIRED')
    .map(([s, n]) => `${n} ${s.toLowerCase().replace('_', '-')}`)
    .join(', ');
  const lines = [
    `Studio, last 7 days: ${o.personas.active} active personas${states ? ` (${states})` : ''}, ${compact(o.last_7d.views)} views, ${usd(o.last_7d.revenue_cents)} revenue from ${o.last_7d.orders} order${o.last_7d.orders === 1 ? '' : 's'}.`,
    `${o.approvals.pending} item${o.approvals.pending === 1 ? '' : 's'} waiting in /approvals${o.approvals.kill_proposals ? `, including ${o.approvals.kill_proposals} kill proposal${o.approvals.kill_proposals === 1 ? '' : 's'}` : ''}. LLM spend $${o.budget.llm_usd.used.toFixed(2)}${o.budget.llm_usd.limit !== null ? ` of $${o.budget.llm_usd.limit}` : ''} this month.`,
  ];
  if (o.top.length) lines.push(`Top: ${o.top.map((t) => `${t.name} ${usd(t.revenue_7d_cents)} / ${compact(t.views_7d)} views`).join(' · ')}.`);
  if (o.paused.length) lines.push(`Paused: ${o.paused.map((p) => (p.scope === 'global' ? 'all posting' : p.platform ?? 'a persona')).join(', ')}.`);
  return lines.join('\n');
}

/**
 * The no-key Studio Manager: the intents it can recognise deterministically (pause posting, propose a kill or
 * retirement) run through the same registry tools the live model calls, permission-checked as studio-manager.
 */
async function fakeActions(services: StudioServices, input: StudioTurnInput, toolCtx: ToolContext): Promise<string[]> {
  const out: string[] = [];
  // Questions ("should we pause TikTok?") are answered, not acted on.
  if (/\?\s*$/.test(input.text)) return out;
  const lower = input.text.toLowerCase();
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const personas = input.mentions.length
    ? input.mentions
    : (
        await services.db.query<{ id: string; slug: string; name: string }>(
          `SELECT id, slug, name FROM persona WHERE studio_id = $1 AND state NOT IN ('KILLED','RETIRED')`,
          [input.studioId],
        )
      ).filter((p) => new RegExp(`\\b${escape(p.name.split(' ')[0]!.toLowerCase())}\\b`).test(lower));
  const call = async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
    try {
      return await services.tools.invoke(toolCtx, tool, args);
    } catch (err) {
      out.push(`I couldn't run ${tool}: ${errorMessage(err)}.`);
      return null;
    }
  };
  if (/\bpause\b/.test(lower)) {
    const platform = PLATFORMS.find((p) => lower.includes(p));
    const reason = `Owner asked in the Studio chat: "${input.text.slice(0, 120)}"`;
    if (platform) {
      if (await call('studio.pause_posting', { scope: 'platform', platform, reason })) out.push(`Paused all ${platform} posting. Only you can resume it (Settings).`);
    } else if (personas.length) {
      for (const p of personas) {
        if (await call('studio.pause_posting', { scope: 'persona', persona_id: p.id, reason })) out.push(`Paused posting for ${p.name}.`);
      }
    } else if (/\b(all|everything|every|global)\b/.test(lower)) {
      if (await call('studio.pause_posting', { scope: 'global', reason })) out.push('Paused all posting, studio-wide. Only you can resume it (Settings).');
    }
  }
  const kill = /\b(kill|retire)\b/.exec(lower)?.[1] as 'kill' | 'retire' | undefined;
  if (kill && personas.length) {
    for (const p of personas) {
      const r = (await call('studio.propose_kill', {
        persona_id: p.id,
        action: kill,
        rationale: `Owner asked in the Studio chat: "${input.text.slice(0, 200)}"`,
      })) as { approval_id?: string } | null;
      if (r?.approval_id) out.push(`Opened a ${kill} proposal for ${p.name}. It waits for your approval in /approvals; ${p.name} keeps running until you decide.`);
    }
  }
  return out;
}

/** One Studio Manager turn in the Studio chat (the Owner's main conversation). */
export async function studioManagerTurn(services: StudioServices, input: StudioTurnInput): Promise<AgentReply> {
  const toolCtx: ToolContext = { services, studioId: input.studioId, personaId: null, caller: 'studio-manager', actor: STUDIO_MANAGER };
  const costRef: CostRef = { type: 'chat_thread', id: input.threadId };
  const actions = services.runtime.mode === 'fake' ? await fakeActions(services, input, toolCtx) : [];
  const overview = await studioOverview(services.db, input.studioId);
  const mentionNote = input.mentions.length
    ? `${input.mentions.map((m) => `${m.name}'s manager`).join(' and ')} will answer in this thread after you; don't answer for them.`
    : '';
  const res = await runAgent(
    services,
    {
      agent: 'studio-manager',
      scope: { studioId: input.studioId, personaId: null },
      label: 'chat: studio manager',
      system: STUDIO_MANAGER_SYSTEM,
      cached: [STUDIO_RULES_BLOCK],
      prompt: [
        `Today is ${today(services.now())}.`,
        `Studio snapshot: ${JSON.stringify(overview)}`,
        `Conversation so far:\n${transcript(input.history)}`,
        mentionNote,
        `The Owner says: ${input.text}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
      tools: toolNamesFor(services, 'studio-manager'),
      maxTokens: 2000,
      fake: () =>
        [
          ...actions,
          overviewText(overview),
          input.mentions.length ? `Bringing in ${input.mentions.map((m) => `${m.name}'s manager`).join(' and ')}.` : '',
          actions.length ? '' : `Noted: "${input.text.slice(0, 140)}".`,
        ]
          .filter(Boolean)
          .join('\n\n'),
      costRef,
    },
    { onText: input.onText },
  );
  return { text: res.text, runId: res.runId, mode: services.runtime.mode, meta: { kind: 'reply' } };
}

/** Matches a platform word, for callers that need the typed value. */
export const asPlatform = (v: string): Platform | null => (PLATFORMS.includes(v as Platform) ? (v as Platform) : null);
