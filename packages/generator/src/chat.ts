import { type RunTrust, runAgent, STUDIO_RULES_BLOCK, type StudioServices, type ToolContext } from '@ios/agents';
import { BudgetExceededError, STUDIO_MANAGER } from '@ios/core';
import { GENERATOR_SYSTEM } from './steps';
import { addDraftMessage, DraftError, listDraftMessages, requireDraft } from './store';
import { CHAT_TOOLS, draftSummary } from './tools';
import { type DraftMessage, type DraftRow, STEPS, stepKey } from './types';

/**
 * The chat panel on every generator step: the Owner talks to the Studio Manager about this draft. Instructions
 * ("combine A's look with B's mechanic", "make her older") revise the draft through the generator.* tools, which the
 * registry gates: the draft holds outside research, so the run is untrusted and a change goes through only when the
 * Owner's own message asks for it. Without a key the Studio Manager maps the instruction itself (same tools, same
 * gate) and answers with precise suggestions from the scorecard.
 */

export const MAX_CHAT_CHARS = 4000;

const QUESTION = /\?\s*$|^\s*(?:what|how|why|which|who|should|would|could|is|are|do|does|can)\b/i;
const INTENT = /\b(?:make|change|combine|mix|merge|swap|use|pick|choose|go\s+with|select|rename|call|name|revise|regenerate|redo|edit|set|try|take|turn|switch|older|younger|drier|warmer|funnier|sharper|softer|calmer|bolder|sassier|price|new\s+options|try\s+again)\b/i;

/** One to three precise next moves for the step, from the draft's own numbers. */
export function suggestionsFor(d: DraftRow, step: number): string[] {
  const s = d.state;
  const out: string[] = [];
  switch (stepKey(step)) {
    case 'opportunity': {
      const ranked = [...s.opportunity.options].sort((a, b) => b.scores.total - a.scores.total);
      const [a, b] = ranked;
      if (s.opportunity.chosen) out.push(`${s.opportunity.chosen.niche} is picked; the concepts are drafted on the next step.`);
      else if (a) {
        out.push(`Pick ${a.id} (${a.niche}, ${a.scores.total}/100): ${a.evidence.find((e) => e.signal === 'intent')?.detail ?? a.evidence[0]?.detail ?? ''}.`);
        if (b) out.push(`${b.id} (${b.niche}) is the runner-up: ${b.buyingMoments[0] ?? ''} is its buying moment.`);
      }
      break;
    }
    case 'concept': {
      const ranked = [...s.concept.options].sort((x, y) => (y.scorecard?.total ?? 0) - (x.scorecard?.total ?? 0));
      const top = ranked[0];
      if (top) out.push(`${top.id} scores highest: ${top.scorecard?.total}/100 (captivation ${top.scorecard?.captivation}/30, line safety ${top.scorecard?.lineSafety}/10).`);
      const shortest = [...s.concept.options].sort((x, y) => x.hooks.join(' ').length - y.hooks.join(' ').length)[0];
      if (shortest && top && shortest.id !== top.id) out.push(`${shortest.id} has the tightest hooks: try "combine ${top.id}'s premise with ${shortest.id}'s hooks".`);
      else if (ranked[1] && top) out.push(`Try "combine ${ranked[1].id}'s look with ${top.id}'s mechanic" if you prefer ${ranked[1].id}'s styling.`);
      break;
    }
    case 'character': {
      const ch = s.character.chosen;
      if (ch) {
        out.push(`${ch.name}, ${ch.age}: ${ch.catchphrases[0] ? `the sign-off "${ch.catchphrases[0]}" is the most quotable line.` : 'add a sign-off: it is the most quotable line a character has.'}`);
        out.push('Swap any field for an alternative, or say "make her older and drier".');
      }
      break;
    }
    case 'look': {
      const look = s.look.chosen;
      if (look) {
        out.push(`Anchors: ${look.profile.anchors.join(', ')}. Keep them in every frame: they carry recognition more than the face.`);
        out.push(look.check ? `${look.check.drift.note} ${look.check.distinct.note}` : 'Pick a sheet to run the drift and distinctness check.');
      }
      break;
    }
    case 'voice':
      out.push(s.voice.chosen ? `Voice ${s.voice.chosen.id} (${s.voice.chosen.label}) is picked.` : 'A matches the concept\'s voice line; B and C are variations. Pick one, or say "regenerate" for three more.');
      break;
    case 'content': {
      const c = s.content.chosen;
      if (c) {
        const core = c.ladder.find((r) => r.rung === 'core_bundle');
        out.push(`Entry $${(c.firstProductBrief.priceCents / 100).toFixed(0)}, core $${((core?.priceCents ?? 0) / 100).toFixed(0)}: ${c.firstProductBrief.priceCents >= 900 && c.firstProductBrief.priceCents <= 1900 ? 'inside the bands that sell.' : 'move the entry into the $9–19 band.'}`);
        out.push(`${c.hookBank.length} hooks in the bank; the series "${c.series[0]?.name ?? ''}" carries the mechanic three times a week.`);
      }
      break;
    }
    case 'review': {
      const r = s.review.chosen;
      if (r) {
        const dims = (['captivation', 'demand', 'ladder', 'gap', 'producibility', 'lineSafety'] as const).map((k) => ({
          k,
          ratio: r.scorecard[k] / ({ captivation: 30, demand: 20, ladder: 15, gap: 10, producibility: 15, lineSafety: 10 } as const)[k],
        }));
        const weakest = dims.sort((a, b) => a.ratio - b.ratio)[0]!;
        out.push(`Scorecard ${r.scorecard.total}/100; weakest: ${weakest.k} (${r.scorecard.notes[weakest.k] ?? ''}).`);
        out.push(`Distinctness ${r.distinctness.score}/100${r.distinctness.nearest[0] ? `; nearest ${r.distinctness.nearest[0].name} (${r.distinctness.nearest[0].source})` : ''}.`);
        out.push(r.ready ? 'Ready: approve the launch when you are happy.' : `Not ready: ${[...r.missing.map((m) => `${m} missing`), ...r.risks.filter((x) => x.startsWith('Line:') || x.startsWith('Too close'))].map((x) => x.replace(/\.$/, '')).join('; ')}.`);
      }
      break;
    }
  }
  return out.filter(Boolean);
}

export interface GeneratorTurn {
  owner: DraftMessage;
  reply: DraftMessage;
  draft: DraftRow;
}

/** Saves the Owner's message, runs the Studio Manager on it, saves and returns the reply. */
export async function generatorTurn(services: StudioServices, input: { draftId: string; step: number; text: string; onText?: (delta: string) => void }): Promise<GeneratorTurn> {
  const text = input.text.trim();
  if (!text) throw new DraftError('say something first');
  if (text.length > MAX_CHAT_CHARS) throw new DraftError(`messages are limited to ${MAX_CHAT_CHARS} characters`);
  const step = Math.max(1, Math.min(7, Math.round(input.step)));
  let d = await requireDraft(services.db, input.draftId);
  const history = await listDraftMessages(services.db, d.id, 14);
  const owner = await addDraftMessage(services.db, { draftId: d.id, step, role: 'owner', author: 'owner:hossam', body: text });
  const lastAgent = [...history].reverse().find((m) => m.role === 'agent');
  // A draft carries outside research (evidence, trends): treat the run as untrusted, so mutating tools need the Owner's ask.
  const trust: RunTrust = { untrusted: true, ownerText: text, proposal: lastAgent?.body ?? null };
  const toolCtx: ToolContext = { services, studioId: d.studio_id, personaId: null, caller: 'studio-manager', actor: STUDIO_MANAGER, trust };
  let body: string;
  let meta: Record<string, unknown> = { kind: 'reply', mode: services.runtime.mode };
  try {
    if (services.runtime.mode === 'fake' || d.status !== 'active') {
      const lines: string[] = [];
      if (d.status !== 'active') lines.push(`This draft is ${d.status}; nothing changes here.${d.status === 'archived' ? ' Restore it from /archive to keep working.' : ''}`);
      else if (!QUESTION.test(text) && INTENT.test(text)) {
        try {
          const r = (await services.tools.invoke(toolCtx, 'generator.revise_step', { draft_id: d.id, step, instruction: text })) as { changed: boolean; summary: string; version: number; score: number | null };
          lines.push(r.summary);
          if (r.changed) meta = { ...meta, changed: true, version: r.version };
        } catch (err) {
          lines.push(`I couldn't apply that: ${err instanceof Error ? err.message : String(err)}.`);
        }
      }
      d = await requireDraft(services.db, d.id);
      const tips = suggestionsFor(d, step);
      if (!lines.length) lines.push(`On ${STEPS[step - 1]!.title.toLowerCase()}:`);
      body = [...lines, ...tips].join('\n');
      const res = await runAgent(
        services,
        { agent: 'studio-manager', scope: { studioId: d.studio_id, personaId: null }, label: 'generator: chat', system: GENERATOR_SYSTEM, cached: [STUDIO_RULES_BLOCK], prompt: text, fake: () => body, costRef: { type: 'studio', id: d.studio_id }, trust },
        { onText: input.onText },
      );
      meta.runId = res.runId;
    } else {
      const res = await runAgent(
        services,
        {
          agent: 'studio-manager',
          scope: { studioId: d.studio_id, personaId: null },
          label: 'generator: chat',
          system: `${GENERATOR_SYSTEM}\nYou are in the draft's chat panel on step ${step} (${STEPS[step - 1]!.title}). Give precise suggestions tied to the scorecard. When the Owner asks for a change, make it with the generator tools (draft_id ${d.id}), then say in one line what changed. Never launch: only the Owner's "Approve launch" button does that. Plain text, under 120 words.`,
          cached: [STUDIO_RULES_BLOCK],
          prompt: [`Draft: ${JSON.stringify(draftSummary(d))}`, `Conversation so far:\n${history.map((m) => `${m.role === 'owner' ? 'Owner' : 'You'}: ${m.body}`).join('\n') || '(none)'}`, `The Owner says: ${text}`].join('\n\n'),
          tools: [...CHAT_TOOLS],
          trust,
          maxTokens: 1500,
          fake: () => '',
          costRef: { type: 'studio', id: d.studio_id },
        },
        { onText: input.onText },
      );
      body = res.text || 'Done.';
      d = await requireDraft(services.db, d.id);
      meta = { ...meta, runId: res.runId, version: d.version, changed: res.toolCalls.some((c) => c.ok && c.tool !== 'generator.read_draft' && c.tool !== 'generator.score_draft') };
    }
  } catch (err) {
    body = err instanceof BudgetExceededError ? `The LLM budget is spent for this month (${err.message}). Nothing changed.` : `Something went wrong and nothing changed: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}.`;
    input.onText?.(body);
    meta = { kind: 'notice', error: true };
  }
  const reply = await addDraftMessage(services.db, { draftId: d.id, step, role: 'agent', author: 'agent:studio-manager', body, meta });
  return { owner, reply, draft: d };
}
