import { createHash } from 'node:crypto';
import { type ChatMessageRow, clearKillSwitch, OWNER, setKillSwitch } from '@ios/core';
import type { LlmCacheBlock } from '@ios/providers';
import type { CostRef } from '@ios/core';
import type { StudioServices } from '../contracts';
import { bibleText, compact, latestBible, personaStatus, type PersonaStatus, playbookRules, usd } from '../data';
import {
  applyFeedback,
  CLASSIFICATION_SCHEMA,
  type FeedbackProposal,
  heuristicClassify,
  logFeedback,
  type MessageClassification,
  parseClassification,
  pendingFeedback,
  rejectFeedback,
} from '../feedback';
import { runAgent } from '../runtime';
import { type AgentReply, emitChunks, today, toolNamesFor, transcript } from './common';
import { CLASSIFIER_SYSTEM, PERSONA_MANAGER_SYSTEM, STUDIO_RULES_BLOCK } from './prompts';

export interface PersonaContext {
  persona: { id: string; name: string; slug: string; studio_id: string };
  /** Most stable first: studio rules → bible vN → playbook. */
  cached: LlmCacheBlock[];
  /** An example line in the persona's voice (for before/after). */
  sample: string | null;
}

/** Loads what every Persona Manager run carries as prompt-cached context. */
export async function personaContext(services: StudioServices, personaId: string): Promise<PersonaContext> {
  const persona = await services.db.one<PersonaContext['persona']>('SELECT id, name, slug, studio_id FROM persona WHERE id = $1', [personaId]);
  const bible = await latestBible(services.db, personaId);
  const rules = await playbookRules(services.db, persona.studio_id, personaId);
  const playbook = rules.length
    ? rules.map((r) => `- [${r.scope}] ${r.rule}`).join('\n')
    : '- (no learned rules yet)';
  const playbookHash = createHash('sha256').update(playbook).digest('hex').slice(0, 12);
  const dna = (bible?.content as { content_dna?: { hook_library?: unknown } } | undefined)?.content_dna;
  const hooks = Array.isArray(dna?.hook_library) ? (dna.hook_library as unknown[]).filter((h): h is string => typeof h === 'string') : [];
  const script = await services.db.maybeOne<{ hooks: unknown; body: string }>(
    `SELECT hooks, body FROM script WHERE persona_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [personaId],
  );
  const scriptHook = Array.isArray(script?.hooks) && typeof script.hooks[0] === 'string' ? (script.hooks[0] as string) : null;
  const sample = (scriptHook ?? hooks[0] ?? script?.body?.split(/(?<=[.!?])\s/)[0] ?? null)?.replace(/^["“]|["”]$/g, '') ?? null;
  return {
    persona,
    cached: [
      STUDIO_RULES_BLOCK,
      { key: `bible:${personaId}:v${bible?.version ?? 0}`, text: bibleText(persona.name, bible) },
      { key: `playbook:${personaId}:${playbookHash}`, text: `# ${persona.name}: playbook (learned rules)\n${playbook}` },
    ],
    sample,
  };
}

/** Numbers-first status line(s), from live data (the no-key reply and the /status shortcut). */
export function statusText(s: PersonaStatus): string {
  const state = s.state.toLowerCase().replace('_', '-');
  const lines = [
    `${s.name} · ${state} · ${s.autonomy}${s.days_live !== null ? ` · day ${s.days_live}` : ''}. Last 7 days: ${compact(s.views_7d)} views, ${compact(s.followers)} followers, ${s.orders_7d} sale${s.orders_7d === 1 ? '' : 's'} (${usd(s.revenue_7d_cents)}).`,
    s.next_slots.length ? `Next: "${s.next_slots[0]!.title}" (${s.next_slots[0]!.format.replace('_', ' ')}, ${s.next_slots[0]!.purpose}).` : 'Nothing scheduled yet.',
    `LLM spend $${s.budget.llm_usd.used.toFixed(2)}${s.budget.llm_usd.limit !== null ? ` of $${s.budget.llm_usd.limit}` : ''} this month.`,
  ];
  if (s.pending_approvals.length) lines.push(`Needs you: ${s.pending_approvals.map((a) => a.title).join('; ')} (/approvals).`);
  if (s.paused) lines.push('Posting is paused.');
  return lines.join('\n');
}

const CLASS_LABEL: Record<FeedbackProposal['class'], string> = {
  one_off: 'one-off fix',
  persona_rule: 'persona rule',
  strategy: 'strategy change',
  studio: 'studio-wide',
};

/** The restate-with-before/after message (PRD §3.1 step 3). */
export function proposalText(p: FeedbackProposal, appliedSummary?: string): string {
  const head = `Got it: ${p.restated} (${CLASS_LABEL[p.class]}).`;
  const example = `Before: ${p.before}\nAfter: ${p.after}`;
  if (appliedSummary) return `${head}\n\n${example}\n\n${appliedSummary}`;
  const tail =
    p.class === 'studio'
      ? 'This should apply to every persona, so on your Yes it goes to the Studio Manager as a proposed studio rule.'
      : `Applies from ${p.applies_from}. Tap Apply or reply "yes".`;
  return `${head}\n\n${example}\n\n${tail}`;
}

export interface PersonaTurnInput {
  personaId: string;
  threadId: string;
  text: string;
  history: readonly ChatMessageRow[];
  onText?: (delta: string) => void;
}

/**
 * One Persona Manager turn in its chat: shortcuts (/status, /pause, /resume…), the feedback loop (classify →
 * propose with before/after → apply on Yes → Bible vN+1 or a playbook rule → audit), or a normal answer with its
 * tools (scoped to its own persona in code).
 */
export async function personaManagerTurn(services: StudioServices, input: PersonaTurnInput): Promise<AgentReply> {
  const { db } = services;
  const ctx = await personaContext(services, input.personaId);
  const studioId = ctx.persona.studio_id;
  const costRef: CostRef = { type: 'chat_thread', id: input.threadId };
  const mode = services.runtime.mode;
  const status = await personaStatus(db, studioId, input.personaId);
  if (!status) throw new Error('persona not found');
  const text = input.text.trim();
  const reply = async (body: string, meta: Record<string, unknown> = {}, runId: string | null = null): Promise<AgentReply> => {
    await emitChunks(body, input.onText);
    return { text: body, runId, mode, meta: { kind: 'reply', ...meta } };
  };

  // Shortcuts that act with the Owner's own authority (the Owner typed them); never model-interpreted.
  const cmd = /^\/(\w+)\b/.exec(text)?.[1]?.toLowerCase();
  if (cmd === 'pause') {
    await setKillSwitch(db, studioId, { scope: 'persona', personaId: input.personaId }, OWNER, 'paused from the persona chat');
    return reply(`Paused all posting for ${ctx.persona.name}. Send /resume to start again.`, { kind: 'notice' });
  }
  if (cmd === 'resume') {
    await clearKillSwitch(db, studioId, { scope: 'persona', personaId: input.personaId }, OWNER);
    return reply(`Resumed posting for ${ctx.persona.name}${status.paused ? '' : ' (it was not paused)'}.`, { kind: 'notice' });
  }
  if (cmd === 'status' || cmd === 'today' || cmd === 'budget' || cmd === 'queue') return reply(statusText(status));
  if (cmd === 'bible') {
    const b = await latestBible(db, input.personaId);
    const changes = ((b?.content as { changelog?: Array<{ version: number; change: string }> } | undefined)?.changelog ?? []).slice(-5);
    return reply(
      b
        ? `Bible v${b.version} (${b.status}). ${changes.length ? `Recent changes:\n${changes.map((c) => `- v${c.version}: ${c.change}`).join('\n')}` : 'No changes since it was written.'}\nFull text: /personas/${ctx.persona.slug}`
        : 'No bible yet.',
    );
  }

  // The feedback loop.
  const pending = await pendingFeedback(db, input.personaId);
  const quick = heuristicClassify(text, { pending: Boolean(pending), sample: ctx.sample });
  if (pending && (quick.kind === 'confirm' || quick.kind === 'decline')) return settle(services, ctx, pending.id, quick.kind, input.onText);

  let classification: MessageClassification = quick;
  let classifyRun: string | null = null;
  const obviousQuestion = /\?\s*$/.test(text) || Boolean(cmd);
  if (!obviousQuestion) {
    const res = await runAgent(services, {
      agent: 'persona-manager',
      tier: 'fast',
      scope: { studioId, personaId: input.personaId },
      label: 'feedback: classify',
      system: CLASSIFIER_SYSTEM,
      cached: ctx.cached,
      prompt: [
        `Pending proposal: ${pending?.applied_change?.proposal ? JSON.stringify(pending.applied_change.proposal) : 'none'}`,
        `Sample line in the persona's voice: ${ctx.sample ?? '(none)'}`,
        `Owner's message: ${text}`,
      ].join('\n'),
      parse: parseClassification,
      jsonSchema: CLASSIFICATION_SCHEMA,
      maxTokens: 800,
      fake: () => quick,
      costRef,
    });
    classification = res.output;
    classifyRun = res.runId;
  }
  if (pending && (classification.kind === 'confirm' || classification.kind === 'decline')) {
    return settle(services, ctx, pending.id, classification.kind, input.onText);
  }
  if (classification.kind === 'feedback' && classification.proposal) {
    const p = classification.proposal;
    const row = await logFeedback(db, { personaId: input.personaId, studioId, text, proposal: p });
    if (p.class === 'one_off') {
      const applied = await applyFeedback(db, { feedbackId: row.id, actor: { type: 'agent', id: 'persona-manager' }, studioId });
      return reply(proposalText(p, `Applied now. ${applied.summary}`), { feedback: { id: row.id, status: 'applied', class: p.class } }, classifyRun);
    }
    return reply(proposalText(p), { feedback: { id: row.id, status: 'proposed', class: p.class } }, classifyRun);
  }

  // A question or a command: answer with tools (scoped to this persona in code).
  const res = await runAgent(
    services,
    {
      agent: 'persona-manager',
      scope: { studioId, personaId: input.personaId },
      label: 'chat: persona manager',
      system: PERSONA_MANAGER_SYSTEM,
      cached: ctx.cached,
      prompt: [
        `Today is ${today(services.now())}. You manage ${ctx.persona.name} (persona_id ${input.personaId}).`,
        `Current numbers: ${JSON.stringify(status)}`,
        `Conversation so far:\n${transcript(input.history)}`,
        `The Owner says: ${text}`,
      ].join('\n\n'),
      tools: toolNamesFor(services, 'persona-manager', { exclude: ['studio'] }),
      maxTokens: 1500,
      fake: () => `${statusText(status)}\n\nNoted: "${text.slice(0, 140)}".`,
      costRef,
    },
    { onText: input.onText },
  );
  return { text: res.text, runId: res.runId, mode, meta: { kind: 'reply' } };
}

/** The Owner's Yes / No on a pending proposal: apply it (Bible vN+1, playbook rule…) or drop it, then confirm. */
async function settle(
  services: StudioServices,
  ctx: PersonaContext,
  feedbackId: string,
  decision: 'confirm' | 'decline',
  onText?: (delta: string) => void,
): Promise<AgentReply> {
  const studioId = ctx.persona.studio_id;
  let body: string;
  let meta: Record<string, unknown>;
  if (decision === 'decline') {
    await rejectFeedback(services.db, { feedbackId, actor: OWNER, studioId });
    body = 'Dropped it. Nothing changed.';
    meta = { kind: 'reply', feedback: { id: feedbackId, status: 'rejected' } };
  } else {
    const r = await applyFeedback(services.db, { feedbackId, actor: OWNER, studioId });
    body = `Done. ${r.summary}${r.result.bibleVersion ? ' New scripts use it from the next batch.' : ''} I'll report the measured effect in the weekly review.`;
    meta = { kind: 'reply', feedback: { id: feedbackId, status: 'applied', class: r.class, ...r.result } };
  }
  await emitChunks(body, onText);
  return { text: body, runId: null, mode: services.runtime.mode, meta };
}

/**
 * A persona manager answering in the Studio chat (an @mention) or for the Studio Manager (delegation): read and act
 * through its own scoped tools; no feedback loop.
 */
export async function personaManagerAnswer(
  services: StudioServices,
  input: { personaId: string; question: string; from: 'owner-mention' | 'studio-manager'; costRef: CostRef; onText?: (delta: string) => void },
): Promise<AgentReply> {
  const ctx = await personaContext(services, input.personaId);
  const status = await personaStatus(services.db, ctx.persona.studio_id, input.personaId);
  if (!status) throw new Error('persona not found');
  const asker = input.from === 'owner-mention' ? 'The Owner mentioned you in the Studio chat' : 'The Studio Manager asks you';
  const res = await runAgent(
    services,
    {
      agent: 'persona-manager',
      scope: { studioId: ctx.persona.studio_id, personaId: input.personaId },
      label: input.from === 'owner-mention' ? 'chat: @mention' : 'delegation from studio manager',
      system: PERSONA_MANAGER_SYSTEM,
      cached: ctx.cached,
      prompt: [
        `Today is ${today(services.now())}. You manage ${ctx.persona.name} (persona_id ${input.personaId}).`,
        `Current numbers: ${JSON.stringify(status)}`,
        `${asker}: ${input.question}`,
        'Answer for your persona only, in under 100 words.',
      ].join('\n\n'),
      tools: toolNamesFor(services, 'persona-manager', { exclude: ['studio'] }),
      maxTokens: 1000,
      fake: () => statusText(status),
      costRef: input.costRef,
    },
    { onText: input.onText },
  );
  return { text: res.text, runId: res.runId, mode: services.runtime.mode, meta: { kind: 'reply', personaId: input.personaId, via: input.from } };
}
