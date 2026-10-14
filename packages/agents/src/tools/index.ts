import {
  addMessage,
  decide,
  findThread,
  ForbiddenError,
  notify,
  PLATFORMS,
  type Platform,
  proposeKill,
  setKillSwitch,
  updatePersonaControls,
  withdraw,
} from '@ios/core';
import type { Caller, ToolContext, ToolDef } from '../contracts';
import { latestBible, personaStatus, personaSummaries, playbookRules, recentFeedback, recentPosts, studioOverview } from '../data';
import { applyFeedback, BIBLE_SECTIONS, rejectFeedback, reviseBible } from '../feedback';
import { type Field, input, type Parsed, PERSONA_ID, ToolInputError } from './schema';

/** Builds a ToolDef from a field map (JSON Schema for the model and `parse` for the registry come from one place). */
function tool<S extends Record<string, Field>, O>(
  d: Omit<ToolDef<Parsed<S>, O>, 'inputSchema' | 'parse'> & { input: S },
): ToolDef<Parsed<S>, O> {
  const { schema, parse } = input(d.input);
  const { input: _fields, ...rest } = d;
  return { ...rest, inputSchema: schema, parse };
}

/** Studio-level reads and actions: the Studio Manager (and the Profit Engine for reads). */
const STUDIO_READERS: readonly Caller[] = ['studio-manager', 'profit-engine'];
const MANAGERS: readonly Caller[] = ['studio-manager', 'persona-manager'];

const agentRef = (ctx: ToolContext) => `agent:${ctx.caller}`;

async function assertPersonaInStudio(ctx: ToolContext, personaId: string): Promise<void> {
  if (ctx.personaId !== null && ctx.personaId !== personaId) throw new ForbiddenError(`${ctx.caller} may only act on its own persona`);
  const ok = await ctx.services.db.maybeOne('SELECT 1 FROM persona WHERE id = $1 AND studio_id = $2', [personaId, ctx.studioId]);
  if (!ok) throw new ForbiddenError(`persona ${personaId} is not in this studio`);
}

// ───────────────────────────── studio.* ─────────────────────────────

export const studioOverviewTool = tool({
  name: 'studio.overview',
  description: 'Studio numbers: active personas by state, last 7 days of views, revenue and orders, pending approvals, LLM and credit spend, active pauses, top personas.',
  scope: 'studio',
  callers: STUDIO_READERS,
  input: {},
  run: (ctx) => studioOverview(ctx.services.db, ctx.studioId),
});

export const studioPersonasTool = tool({
  name: 'studio.personas',
  description: 'Every persona with id, slug, state, autonomy, 7-day views, followers, revenue, orders and whether a kill is proposed. Use it to find persona ids.',
  scope: 'studio',
  callers: STUDIO_READERS,
  input: {},
  run: (ctx) => personaSummaries(ctx.services.db, ctx.studioId),
});

export const studioProposeKillTool = tool({
  name: 'studio.propose_kill',
  description:
    'Propose killing or retiring a persona. Opens an Owner-only approval card (no timer) and shows it in the Studio chat; the persona keeps running until the Owner approves. Give the rationale and the evidence (numbers).',
  scope: 'persona',
  callers: ['studio-manager'],
  mutates: true,
  ownerIntent: /\b(?:kill|retire|shut (?:\w+ )?down)\b/i,
  input: {
    persona_id: PERSONA_ID,
    action: { type: 'string', enum: ['kill', 'retire'] },
    rationale: { type: 'string', maxLength: 1000, description: 'Why, in one or two sentences, numbers first.' },
    evidence: { type: 'object', optional: true, description: 'Key numbers, e.g. {"views_30d": 4100, "forecast_profit_4w": -120}.' },
  },
  run: async (ctx, i) => {
    const { approval } = await proposeKill(ctx.services.db, {
      personaId: i.persona_id,
      action: i.action as 'kill' | 'retire',
      rationale: i.rationale,
      evidence: { source: 'studio-manager', ...(i.evidence ?? {}) },
      proposedBy: { type: 'agent', id: ctx.caller },
    });
    const thread = await findThread(ctx.services.db, ctx.studioId, 'studio');
    await addMessage(ctx.services.db, {
      threadId: thread.id,
      role: 'agent',
      author: agentRef(ctx),
      body: `${approval.title}: ${i.rationale}`,
      personaId: i.persona_id,
      meta: { kind: 'approval_card', approvalId: approval.id, fake: ctx.services.runtime.mode === 'fake' },
    });
    return { approval_id: approval.id, title: approval.title, status: approval.status, link: '/approvals' };
  },
});

export const studioPausePostingTool = tool({
  name: 'studio.pause_posting',
  description: 'Pause posting: everything (global), one persona, or one platform. Takes effect before the next publish. Only the Owner can resume.',
  scope: 'studio',
  callers: ['studio-manager'],
  mutates: true,
  ownerIntent: /\b(?:pause|halt|freeze|stop (?:all |the )?post(?:s|ing))\b/i,
  input: {
    scope: { type: 'string', enum: ['global', 'persona', 'platform'] },
    persona_id: { ...PERSONA_ID, optional: true },
    platform: { type: 'string', enum: PLATFORMS, optional: true },
    reason: { type: 'string', maxLength: 300 },
  },
  run: async (ctx, i) => {
    const db = ctx.services.db;
    const actor = { type: 'agent' as const, id: ctx.caller };
    if (i.scope === 'persona') {
      if (!i.persona_id) throw new ToolInputError('persona_id is required for scope persona');
      await assertPersonaInStudio(ctx, i.persona_id);
      await setKillSwitch(db, ctx.studioId, { scope: 'persona', personaId: i.persona_id }, actor, i.reason);
    } else if (i.scope === 'platform') {
      if (!i.platform) throw new ToolInputError('platform is required for scope platform');
      await setKillSwitch(db, ctx.studioId, { scope: 'platform', platform: i.platform as Platform }, actor, i.reason);
    } else {
      await setKillSwitch(db, ctx.studioId, { scope: 'global' }, actor, i.reason);
    }
    return { paused: i.scope, persona_id: i.persona_id ?? null, platform: i.platform ?? null, resume: 'Owner only (Settings)' };
  },
});

export const studioDelegateTool = tool({
  name: 'studio.delegate',
  description:
    "Hand a persona-specific task or question to that persona's manager. Your instruction and its reply are posted in the persona's chat; the reply comes back to you.",
  scope: 'persona',
  callers: ['studio-manager'],
  mutates: true,
  ownerIntent: /\b(?:ask|tell|have|get|delegate|check with|hand)\b|@\w/i,
  input: { persona_id: PERSONA_ID, instruction: { type: 'string', maxLength: 2000 } },
  run: async (ctx, i) => {
    const { personaManagerAnswer } = await import('../agents/persona-manager');
    const db = ctx.services.db;
    const thread = await findThread(db, ctx.studioId, 'persona', i.persona_id);
    await addMessage(db, { threadId: thread.id, role: 'agent', author: agentRef(ctx), body: i.instruction, personaId: i.persona_id, meta: { kind: 'notice', via: 'delegation' } });
    const r = await personaManagerAnswer(ctx.services, {
      personaId: i.persona_id,
      question: i.instruction,
      from: 'studio-manager',
      costRef: { type: 'chat_thread', id: thread.id },
      trust: ctx.trust,
    });
    await addMessage(db, {
      threadId: thread.id,
      role: 'agent',
      author: 'agent:persona-manager',
      body: r.text,
      personaId: i.persona_id,
      meta: { ...r.meta, runId: r.runId, fake: r.mode === 'fake' },
    });
    return { reply: r.text };
  },
});

export const studioAdoptRuleTool = tool({
  name: 'studio.adopt_rule',
  description: 'Adopt (or drop) a proposed studio-wide playbook rule, e.g. one a persona manager sent up from Owner feedback.',
  scope: 'studio',
  callers: ['studio-manager'],
  mutates: true,
  ownerIntent: /\b(?:adopt|rules?)\b/i,
  input: { rule_id: { type: 'string', uuid: true }, adopt: { type: 'boolean' } },
  run: async (ctx, i) => {
    const rows = await ctx.services.db.query(
      `UPDATE playbook_rule SET status = $3 WHERE id = $1 AND studio_id = $2 AND scope = 'studio' AND status = 'proposed' RETURNING id`,
      [i.rule_id, ctx.studioId, i.adopt ? 'active' : 'retired'],
    );
    if (!rows.length) throw new ToolInputError('no proposed studio rule with that id');
    return { rule_id: i.rule_id, status: i.adopt ? 'active' : 'retired' };
  },
});

// ───────────────────────────── persona.* ─────────────────────────────

export const personaStatusTool = tool({
  name: 'persona.status',
  description: "A persona's state, autonomy, day count, 7-day numbers, next scheduled posts, pending approvals, budget used and whether posting is paused.",
  scope: 'persona',
  input: { persona_id: PERSONA_ID },
  run: (ctx, i) => personaStatus(ctx.services.db, ctx.studioId, i.persona_id),
});

export const personaPostsTool = tool({
  name: 'persona.posts',
  description: "A persona's recent posts with platform, format, status and latest views, saves and shares.",
  scope: 'persona',
  input: { persona_id: PERSONA_ID, limit: { type: 'integer', minimum: 1, maximum: 50, optional: true } },
  run: (ctx, i) => recentPosts(ctx.services.db, i.persona_id, i.limit ?? 10),
});

export const personaLowerControlsTool = tool({
  name: 'persona.lower_controls',
  description: "Lower a persona's autonomy (L2 → L1 → L0) or monthly caps (circuit breaker). Raising them is the Owner's call and is refused.",
  scope: 'persona',
  callers: ['studio-manager', 'persona-manager', 'profit-engine'],
  mutates: true,
  ownerIntent: /\b(?:lower|reduce|cut|decrease|limit|autonomy|caps?|budget)\b/i,
  input: {
    persona_id: PERSONA_ID,
    autonomy: { type: 'string', enum: ['L0', 'L1', 'L2'], optional: true },
    llm_usd_month: { type: 'number', minimum: 0, optional: true },
    hf_credits_month: { type: 'number', minimum: 0, optional: true },
  },
  run: async (ctx, i) => {
    const budget: Record<string, number> = {};
    if (i.llm_usd_month !== undefined) budget.llm_usd_month = i.llm_usd_month;
    if (i.hf_credits_month !== undefined) budget.hf_credits_month = i.hf_credits_month;
    await updatePersonaControls(
      ctx.services.db,
      i.persona_id,
      { autonomy: i.autonomy as 'L0' | 'L1' | 'L2' | undefined, budget },
      { type: 'agent', id: ctx.caller },
    );
    return { ok: true };
  },
});

// ───────────────────────────── bible.* / playbook.* ─────────────────────────────

export const bibleReadTool = tool({
  name: 'bible.read',
  description: "A persona's current bible (identity, voice, content DNA, products, rules) with its version.",
  scope: 'persona',
  input: { persona_id: PERSONA_ID },
  run: async (ctx, i) => (await latestBible(ctx.services.db, i.persona_id)) ?? { version: 0, content: {} },
});

export const bibleReviseTool = tool({
  name: 'bible.revise',
  description:
    'Write the persona bible vN+1 with a rule added to one section (persona creative decisions are delegated; tell the Owner what changed). Identity, compliance and disclosure text are Owner-only and refused.',
  scope: 'persona',
  callers: MANAGERS,
  mutates: true,
  ownerIntent: /\b(?:bible|voice|tone|style|hooks?|look|revise|rewrite|change|update)\b/i,
  input: {
    persona_id: PERSONA_ID,
    section: { type: 'string', enum: [...BIBLE_SECTIONS] },
    rule: { type: 'string', maxLength: 500, description: 'An instruction future runs can follow.' },
  },
  run: async (ctx, i) => ({
    version: await reviseBible(ctx.services.db, { personaId: i.persona_id, studioId: ctx.studioId, section: i.section, rule: i.rule, actor: { type: 'agent', id: ctx.caller } }),
  }),
});

export const playbookListTool = tool({
  name: 'playbook.list',
  description: "Active playbook rules for a persona, plus the studio's rules.",
  scope: 'persona',
  input: { persona_id: PERSONA_ID },
  run: (ctx, i) => playbookRules(ctx.services.db, ctx.studioId, i.persona_id, 50),
});

export const playbookAddRuleTool = tool({
  name: 'playbook.add_rule',
  description: 'Record a learned rule for a persona (e.g. "question hooks beat stat hooks 2:1 on TikTok"), with its evidence.',
  scope: 'persona',
  callers: MANAGERS,
  mutates: true,
  ownerIntent: /\b(?:rules?|playbook|always|never|from now on)\b/i,
  input: {
    persona_id: PERSONA_ID,
    rule: { type: 'string', maxLength: 500 },
    source: { type: 'string', enum: ['data', 'feedback'] },
    evidence: { type: 'object', optional: true },
  },
  run: async (ctx, i) =>
    ctx.services.db.one<{ id: string }>(
      `INSERT INTO playbook_rule (studio_id, persona_id, scope, rule, evidence, source, status)
       VALUES ($1, $2, 'persona', $3, $4::jsonb, $5, 'active') RETURNING id`,
      [ctx.studioId, i.persona_id, i.rule, JSON.stringify(i.evidence ? [i.evidence] : []), i.source],
    ),
});

// ───────────────────────────── feedback.* ─────────────────────────────

export const feedbackRecentTool = tool({
  name: 'feedback.recent',
  description: "The persona's feedback log: the Owner's recent instructions, how each was classified and applied.",
  scope: 'persona',
  input: { persona_id: PERSONA_ID },
  run: (ctx, i) => recentFeedback(ctx.services.db, i.persona_id),
});

export const feedbackDecideTool = tool({
  name: 'feedback.decide',
  description: "The Owner's one-tap Apply / Not now on a persona manager's proposal (dashboard action).",
  scope: 'studio',
  ownerOnly: true,
  mutates: true,
  input: { feedback_id: { type: 'string', uuid: true }, decision: { type: 'string', enum: ['apply', 'reject'] } },
  run: async (ctx, i) => {
    if (i.decision === 'reject') {
      await rejectFeedback(ctx.services.db, { feedbackId: i.feedback_id, actor: ctx.actor, studioId: ctx.studioId });
      return { status: 'rejected' };
    }
    const r = await applyFeedback(ctx.services.db, { feedbackId: i.feedback_id, actor: ctx.actor, studioId: ctx.studioId });
    return { status: 'applied', ...r };
  },
});

// ───────────────────────────── approvals.* / chat.* ─────────────────────────────

export const approvalsPendingTool = tool({
  name: 'approvals.pending',
  description: 'Approvals waiting for the Owner (kill proposals first). A persona manager sees only its own persona.',
  scope: 'studio',
  input: {},
  run: (ctx) =>
    ctx.services.db.query(
      `SELECT a.id, a.kind, a.mode, a.title, a.summary, a.auto_approve_at, p.name AS persona
         FROM approval a LEFT JOIN persona p ON p.id = a.persona_id
        WHERE a.studio_id = $1 AND a.status = 'pending' AND ($2::uuid IS NULL OR a.persona_id = $2)
        ORDER BY CASE WHEN a.kind IN ('persona_kill','persona_retire') THEN 0 ELSE 1 END, a.created_at`,
      [ctx.studioId, ctx.personaId],
    ),
});

export const approvalsWithdrawTool = tool({
  name: 'approvals.withdraw',
  description: 'Withdraw a pending approval you proposed (for example a kill proposal that is no longer needed).',
  scope: 'studio',
  callers: MANAGERS,
  mutates: true,
  ownerIntent: /\b(?:withdraw|cancel|retract|drop|pull)\b/i,
  input: { approval_id: { type: 'string', uuid: true } },
  run: async (ctx, i) => {
    // A persona manager may only withdraw its own persona's approvals (every persona manager shares one agent id).
    const a = await ctx.services.db.maybeOne('SELECT 1 FROM approval WHERE id = $1 AND studio_id = $2 AND ($3::uuid IS NULL OR persona_id = $3)', [
      i.approval_id,
      ctx.studioId,
      ctx.personaId,
    ]);
    if (!a) throw new ToolInputError('no such approval');
    await withdraw(ctx.services.db, i.approval_id, { type: 'agent', id: ctx.caller });
    return { status: 'withdrawn' };
  },
});

export const approvalsDecideTool = tool({
  name: 'approvals.decide',
  description: 'Owner-only: approve or reject an approval. Kills and retirements need the typed persona name and the payload hash.',
  scope: 'studio',
  ownerOnly: true,
  mutates: true,
  input: {
    approval_id: { type: 'string', uuid: true },
    decision: { type: 'string', enum: ['approve', 'reject'] },
    payload_hash: { type: 'string', optional: true, maxLength: 64 },
    confirm_name: { type: 'string', optional: true, maxLength: 200 },
    note: { type: 'string', optional: true, maxLength: 1000 },
  },
  run: async (ctx, i) => {
    const a = await ctx.services.db.maybeOne('SELECT 1 FROM approval WHERE id = $1 AND studio_id = $2', [i.approval_id, ctx.studioId]);
    if (!a) throw new ToolInputError('no such approval');
    const d = await decide(ctx.services.db, {
      approvalId: i.approval_id,
      decision: i.decision as 'approve' | 'reject',
      actor: ctx.actor,
      payloadHash: i.payload_hash,
      confirmName: i.confirm_name,
      note: i.note,
    });
    return { id: d.id, status: d.status };
  },
});

/** Same rule as @ios/auth's sameOriginPath (no control characters, whitespace or backslashes; stays on origin). */
function sameOriginPath(v: unknown): string | null {
  if (typeof v !== 'string' || !v.startsWith('/') || v.startsWith('//') || /[\x00-\x20\x7f\\]/.test(v)) return null;
  try {
    const u = new URL(v, 'http://x');
    return u.origin === 'http://x' ? `${u.pathname}${u.search}${u.hash}` : null;
  } catch {
    return null;
  }
}

export const chatNotifyOwnerTool = tool({
  name: 'chat.notify_owner',
  description:
    'Tell the Owner about a decision you made (creative changes are yours to make; the Owner is notified, not asked). Posts to the notification centre and the Studio chat.',
  scope: 'studio',
  mutates: true,
  ownerIntent: /\b(?:notify|remind|let me know|tell me|ping me|alert)\b/i,
  input: { title: { type: 'string', maxLength: 140 }, body: { type: 'string', maxLength: 1500 }, link: { type: 'string', maxLength: 200, optional: true } },
  run: async (ctx, i) => {
    const db = ctx.services.db;
    const link = sameOriginPath(i.link) ?? undefined;
    const id = await notify(db, { studioId: ctx.studioId, personaId: ctx.personaId, kind: 'digest', severity: 'info', title: i.title, body: i.body, link });
    const thread = await findThread(db, ctx.studioId, 'studio');
    await addMessage(db, {
      threadId: thread.id,
      role: 'agent',
      author: agentRef(ctx),
      body: `${i.title}\n\n${i.body}`,
      personaId: ctx.personaId,
      meta: { kind: 'notice', notificationId: id, fake: ctx.services.runtime.mode === 'fake' },
    });
    return { notification_id: id };
  },
});

/** Every stream A tool, registered through @ios/agents `tools` (composed by @ios/wiring). */
export const A_TOOLS: ReadonlyArray<ToolDef<any, any>> = [
  studioOverviewTool,
  studioPersonasTool,
  studioProposeKillTool,
  studioPausePostingTool,
  studioDelegateTool,
  studioAdoptRuleTool,
  personaStatusTool,
  personaPostsTool,
  personaLowerControlsTool,
  bibleReadTool,
  bibleReviseTool,
  playbookListTool,
  playbookAddRuleTool,
  feedbackRecentTool,
  feedbackDecideTool,
  approvalsPendingTool,
  approvalsWithdrawTool,
  approvalsDecideTool,
  chatNotifyOwnerTool,
];
