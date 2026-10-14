import { type Actor, actorRef, ApprovalError, audit, NotFoundError, propose } from '@ios/core';
import { type Db, json } from '@ios/db';
import { latestBible } from './data';

/**
 * The Persona Manager's feedback loop (PRD §3.1): classify → restate with a before/after → apply (one-off now;
 * persona rule and strategy after the Owner's one-tap Yes; studio-wide goes to the Studio Manager as a proposed
 * studio rule) → write Bible vN+1 or a playbook rule → audit → confirm. The weekly review measures the effect.
 */
export const FEEDBACK_CLASSES = ['one_off', 'persona_rule', 'strategy', 'studio'] as const;
export type FeedbackClass = (typeof FEEDBACK_CLASSES)[number];

/** Bible sections a manager may revise. Identity (handles, AI-label settings) and compliance/disclosure are the Owner's. */
export const BIBLE_SECTIONS = [
  'character_lore',
  'worldview',
  'expertise_map',
  'signature_frameworks',
  'positions_on_debates',
  'news_beats',
  'audience',
  'voice',
  'look',
  'content_dna',
  'engagement_style',
  'products',
  'community',
  'metrics',
] as const;
export const OWNER_SECTIONS = ['compliance', 'identity', 'disclosure'] as const;

export interface FeedbackProposal {
  class: FeedbackClass;
  /** The change in one line. */
  restated: string;
  /** A concrete example as it is today, and as it would be. */
  before: string;
  after: string;
  /** Bible section (persona_rule). */
  section: string | null;
  /** The rule text that gets written (bible rule, playbook rule or studio rule). */
  rule: string;
  /** When it takes effect, e.g. "tomorrow's batch". */
  applies_from: string;
}

export interface MessageClassification {
  /** feedback = an instruction that changes how the persona works; question/command = answer it; confirm/decline = reply to a pending proposal. */
  kind: 'feedback' | 'question' | 'command' | 'confirm' | 'decline';
  proposal: FeedbackProposal | null;
}

export const CLASSIFICATION_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'proposal'],
  properties: {
    kind: { type: 'string', enum: ['feedback', 'question', 'command', 'confirm', 'decline'] },
    proposal: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['class', 'restated', 'before', 'after', 'section', 'rule', 'applies_from'],
          properties: {
            class: { type: 'string', enum: [...FEEDBACK_CLASSES] },
            restated: { type: 'string' },
            before: { type: 'string' },
            after: { type: 'string' },
            section: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            rule: { type: 'string' },
            applies_from: { type: 'string' },
          },
        },
      ],
    },
  },
};

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Validates a classification (the model's JSON or the fake). Throws on anything malformed. */
export function parseClassification(v: unknown): MessageClassification {
  const r = v as { kind?: unknown; proposal?: unknown };
  const kinds = ['feedback', 'question', 'command', 'confirm', 'decline'] as const;
  if (!r || typeof r !== 'object' || !kinds.includes(r.kind as (typeof kinds)[number])) throw new Error('classification.kind is invalid');
  const kind = r.kind as MessageClassification['kind'];
  if (kind !== 'feedback') return { kind, proposal: null };
  const p = r.proposal as Record<string, unknown> | null;
  if (!p || typeof p !== 'object') throw new Error('feedback needs a proposal');
  if (!FEEDBACK_CLASSES.includes(p.class as FeedbackClass)) throw new Error('proposal.class is invalid');
  const proposal: FeedbackProposal = {
    class: p.class as FeedbackClass,
    restated: str(p.restated, 300),
    before: str(p.before, 400),
    after: str(p.after, 400),
    section: typeof p.section === 'string' && p.section.trim() ? p.section.trim().toLowerCase().replace(/[^a-z_]/g, '_').slice(0, 40) : null,
    rule: str(p.rule, 500),
    applies_from: str(p.applies_from, 80) || 'the next batch',
  };
  if (!proposal.restated || !proposal.rule) throw new Error('proposal needs restated and rule');
  return { kind, proposal };
}

const AFFIRM = /^(yes|yep|yeah|y|ok|okay|sure|apply( it)?|do it|go( ahead)?|confirm(ed)?|approved?|ship it|sounds good)\b[.! ]*$/i;
const DECLINE = /^(no|nope|n|not now|cancel|skip|don'?t|stop|never ?mind|leave it)\b[.! ]*$/i;
const QUESTION = /\?\s*$|^\s*(\/\w+|what|how|why|when|where|who|which|is|are|can|could|should i|do we|does|did|show|list|tell me|give me)\b/i;
const FEEDBACK_CUES = /\b(make|more|less|stop|drop|avoid|never|always|don'?t|do not|warmer|colder|shorter|longer|tone|hooks?|voice|style|preachy|punchier|softer|change|switch|use|should|need(s)? to|feel(s)?|too)\b/i;

/** Deterministic classifier used by the fake runtime (no key) and as the zero-cost first pass for yes/no replies. */
export function heuristicClassify(text: string, ctx: { pending: boolean; sample: string | null }): MessageClassification {
  const t = text.trim();
  if (ctx.pending && AFFIRM.test(t)) return { kind: 'confirm', proposal: null };
  if (ctx.pending && DECLINE.test(t)) return { kind: 'decline', proposal: null };
  if (/^\/(pause|resume)\b/i.test(t)) return { kind: 'command', proposal: null };
  if (QUESTION.test(t) || !FEEDBACK_CUES.test(t)) return { kind: 'question', proposal: null };
  const lower = t.toLowerCase();
  const cls: FeedbackClass = /\b(all personas|every persona|every persona's|studio-wide|across the studio|all of them|everyone)\b/.test(lower)
    ? 'studio'
    : /\b(this post|this script|that post|that video|this one|today'?s (post|script|video)|the last post|tomorrow'?s post)\b/.test(lower)
      ? 'one_off'
      : /\b(post (more|less)|cadence|focus on|pivot|pricing|price|product|launch|strategy|schedule|posting times?|format mix|more (carousels|reels|statics?)|fewer)\b/.test(lower)
        ? 'strategy'
        : 'persona_rule';
  const section = /\b(hook|hooks|caption|series|pillar|format)\b/.test(lower)
    ? 'content_dna'
    : /\b(reply|replies|comment|comments|dm|dms)\b/.test(lower)
      ? 'engagement_style'
      : /\b(look|outfit|wardrobe|setting|palette|style)\b/.test(lower)
        ? 'look'
        : 'voice';
  const rule = t.replace(/\s+/g, ' ').slice(0, 300);
  const before = ctx.sample ?? 'Current wording in the queued scripts';
  return {
    kind: 'feedback',
    proposal: {
      class: cls,
      restated: `${cls === 'studio' ? 'Studio-wide rule' : cls === 'strategy' ? 'Strategy change' : cls === 'one_off' ? 'One-off fix' : `Change ${section.replace('_', ' ')} rules`}: ${rule}`,
      before,
      after: `${before.replace(/[.!?"”]+$/, '')}, rewritten to follow: "${rule}"`,
      section: cls === 'persona_rule' ? section : null,
      rule,
      applies_from: cls === 'one_off' ? 'now' : "tomorrow's batch",
    },
  };
}

export interface FeedbackRow {
  id: string;
  persona_id: string;
  text: string;
  class: FeedbackClass | null;
  status: 'received' | 'proposed' | 'applied' | 'rejected';
  applied_change: { proposal?: FeedbackProposal; result?: Record<string, unknown>; applied_at?: string; decided_by?: string } | null;
  created_at: Date;
}

/** The newest proposal still waiting for the Owner's Yes. */
export async function pendingFeedback(db: Db, personaId: string): Promise<FeedbackRow | null> {
  return db.maybeOne<FeedbackRow>(
    `SELECT * FROM feedback WHERE persona_id = $1 AND status = 'proposed' ORDER BY created_at DESC LIMIT 1`,
    [personaId],
  );
}

/** Logs an Owner instruction with its proposal (status 'proposed'). */
export async function logFeedback(db: Db, input: { personaId: string; studioId: string; text: string; proposal: FeedbackProposal }): Promise<FeedbackRow> {
  return db.transaction(async (tx) => {
    // A newer instruction supersedes an older unanswered proposal.
    await tx.query(
      `UPDATE feedback SET status = 'rejected', applied_change = COALESCE(applied_change, '{}'::jsonb) || '{"superseded": true}'::jsonb
        WHERE persona_id = $1 AND status = 'proposed'`,
      [input.personaId],
    );
    const row = await tx.one<FeedbackRow>(
      `INSERT INTO feedback (persona_id, text, class, applied_change, status) VALUES ($1, $2, $3, $4::jsonb, 'proposed') RETURNING *`,
      [input.personaId, input.text, input.proposal.class, json({ proposal: input.proposal })],
    );
    await audit(tx, {
      studioId: input.studioId,
      personaId: input.personaId,
      actor: { type: 'agent', id: 'persona-manager' },
      action: 'feedback.proposed',
      entityType: 'feedback',
      entityId: row.id,
      data: { class: input.proposal.class, restated: input.proposal.restated },
    });
    return row;
  });
}

export interface ApplyResult {
  feedbackId: string;
  class: FeedbackClass;
  /** What changed: a bible version, a playbook rule, a proposed studio rule, a decision, or an Owner approval card. */
  result: { bibleVersion?: number; playbookRuleId?: string; studioRuleId?: string; decisionId?: string; approvalId?: string };
  summary: string;
}

/**
 * Applies a proposed feedback item. persona_rule → Bible vN+1 (identity/compliance sections go to the Owner as a
 * legal_text_change approval instead); strategy → persona playbook rule; studio → proposed studio rule for the
 * Studio Manager; one_off → a decision record. Audited as feedback.applied with the before/after.
 */
export async function applyFeedback(db: Db, input: { feedbackId: string; actor: Actor; studioId: string }): Promise<ApplyResult> {
  return db.transaction(async (tx) => {
    const f = await tx.maybeOne<FeedbackRow>('SELECT * FROM feedback WHERE id = $1 FOR UPDATE', [input.feedbackId]);
    if (!f) throw new NotFoundError(`feedback ${input.feedbackId} not found`);
    const persona = await tx.maybeOne<{ id: string; name: string; studio_id: string }>(
      'SELECT id, name, studio_id FROM persona WHERE id = $1',
      [f.persona_id],
    );
    if (!persona || persona.studio_id !== input.studioId) throw new NotFoundError('feedback is not in this studio');
    if (f.status !== 'proposed') throw new ApprovalError(`this change is already ${f.status}`);
    const p = f.applied_change?.proposal;
    if (!p) throw new ApprovalError('feedback has no proposal to apply');

    let result: ApplyResult['result'] = {};
    let summary: string;
    const section = p.section ?? 'voice';
    if (p.class === 'persona_rule' && (OWNER_SECTIONS as readonly string[]).includes(section)) {
      const a = await propose(tx, {
        studioId: persona.studio_id,
        personaId: persona.id,
        kind: 'legal_text_change',
        title: `${persona.name}: change ${section} text`,
        summary: p.restated,
        payload: { section, text: p.rule, before: p.before, after: p.after, feedback_id: f.id },
        proposedBy: { type: 'agent', id: 'persona-manager' },
      });
      result = { approvalId: a.id };
      summary = `${section} text is yours to approve: I opened an approval card.`;
    } else if (p.class === 'persona_rule') {
      const version = await reviseBible(tx, {
        personaId: persona.id,
        studioId: persona.studio_id,
        section: (BIBLE_SECTIONS as readonly string[]).includes(section) ? section : 'voice',
        rule: p.rule,
        feedbackId: f.id,
        actor: input.actor,
      });
      result = { bibleVersion: version };
      summary = `Bible v${version} is live (${section.replace(/_/g, ' ')}).`;
    } else if (p.class === 'strategy') {
      const r = await tx.one<{ id: string }>(
        `INSERT INTO playbook_rule (studio_id, persona_id, scope, rule, evidence, source, status)
         VALUES ($1, $2, 'persona', $3, $4::jsonb, 'feedback', 'active') RETURNING id`,
        [persona.studio_id, persona.id, p.rule, json([{ feedback_id: f.id, before: p.before, after: p.after }])],
      );
      result = { playbookRuleId: r.id };
      summary = 'Added to the playbook.';
    } else if (p.class === 'studio') {
      const r = await tx.one<{ id: string }>(
        `INSERT INTO playbook_rule (studio_id, persona_id, scope, rule, evidence, source, status)
         VALUES ($1, NULL, 'studio', $2, $3::jsonb, 'feedback', 'proposed') RETURNING id`,
        [persona.studio_id, p.rule, json([{ feedback_id: f.id, from_persona: persona.id }])],
      );
      result = { studioRuleId: r.id };
      summary = 'Sent to the Studio Manager as a proposed studio rule.';
    } else {
      const d = await tx.one<{ id: string }>(
        `INSERT INTO decision (studio_id, persona_id, agent, summary, rationale) VALUES ($1, $2, 'persona-manager', $3, $4) RETURNING id`,
        [persona.studio_id, persona.id, `One-off fix: ${p.restated}`.slice(0, 300), `Owner feedback ${f.id}`],
      );
      result = { decisionId: d.id };
      summary = 'Applied to that item only.';
    }
    await tx.query(
      `UPDATE feedback SET status = 'applied', applied_change = applied_change || $2::jsonb WHERE id = $1`,
      [f.id, json({ result, applied_at: new Date().toISOString(), decided_by: actorRef(input.actor) })],
    );
    await audit(tx, {
      studioId: persona.studio_id,
      personaId: persona.id,
      actor: input.actor,
      action: 'feedback.applied',
      entityType: 'feedback',
      entityId: f.id,
      data: { class: p.class, before: p.before, after: p.after, rule: p.rule, result },
    });
    return { feedbackId: f.id, class: p.class, result, summary };
  });
}

export async function rejectFeedback(db: Db, input: { feedbackId: string; actor: Actor; studioId: string }): Promise<void> {
  await db.transaction(async (tx) => {
    const f = await tx.maybeOne<FeedbackRow & { studio_id: string }>(
      `SELECT f.*, p.studio_id FROM feedback f JOIN persona p ON p.id = f.persona_id WHERE f.id = $1 FOR UPDATE OF f`,
      [input.feedbackId],
    );
    if (!f || f.studio_id !== input.studioId) throw new NotFoundError(`feedback ${input.feedbackId} not found`);
    if (f.status !== 'proposed') throw new ApprovalError(`this change is already ${f.status}`);
    await tx.query(`UPDATE feedback SET status = 'rejected' WHERE id = $1`, [f.id]);
    await audit(tx, { studioId: f.studio_id, personaId: f.persona_id, actor: input.actor, action: 'feedback.rejected', entityType: 'feedback', entityId: f.id });
  });
}

/**
 * Writes Bible vN+1: the previous version's content plus the rule in its section (`owner_rules`) and a changelog
 * entry; the previous approved version is superseded. Persona creative decisions are delegated (no approval card),
 * so the new version is approved by whoever confirmed it. No timestamps inside the content (it is prompt-cached).
 */
export async function reviseBible(
  db: Db,
  input: { personaId: string; studioId: string; section: string; rule: string; feedbackId?: string; actor: Actor },
): Promise<number> {
  if ((OWNER_SECTIONS as readonly string[]).includes(input.section)) {
    throw new ApprovalError(`${input.section} is Owner-only: propose it as a legal_text_change approval`);
  }
  return db.transaction(async (tx) => {
    await tx.query('SELECT id FROM persona WHERE id = $1 FOR UPDATE', [input.personaId]);
    const cur = await latestBible(tx, input.personaId);
    const max = await tx.one<{ v: number }>('SELECT COALESCE(MAX(version), 0)::int AS v FROM persona_bible WHERE persona_id = $1', [input.personaId]);
    const version = max.v + 1;
    const content = structuredClone(cur?.content ?? {}) as Record<string, unknown>;
    // Only the Owner's confirmed feedback becomes an Owner rule; an agent's own change is labelled as such.
    const key = input.actor.type === 'owner' ? 'owner_rules' : 'agent_rules';
    const sec = content[input.section];
    if (sec && typeof sec === 'object' && !Array.isArray(sec)) {
      const s = sec as Record<string, unknown>;
      s[key] = [...(Array.isArray(s[key]) ? (s[key] as unknown[]) : []), input.rule];
    } else if (sec === undefined) {
      content[input.section] = { [key]: [input.rule] };
    } else {
      content[key] = [...(Array.isArray(content[key]) ? (content[key] as unknown[]) : []), { section: input.section, rule: input.rule }];
    }
    content.changelog = [
      ...(Array.isArray(content.changelog) ? content.changelog : []),
      { version, section: input.section, change: input.rule, by: input.actor.type === 'owner' ? 'owner' : 'agent', ...(input.feedbackId ? { feedback_id: input.feedbackId } : {}) },
    ];
    await tx.query(`UPDATE persona_bible SET status = 'superseded' WHERE persona_id = $1 AND status = 'approved'`, [input.personaId]);
    const by = actorRef(input.actor);
    await tx.query(
      `INSERT INTO persona_bible (persona_id, version, content, status, created_by, approved_by, approved_at)
       VALUES ($1, $2, $3::jsonb, 'approved', $4, $5, now())`,
      [input.personaId, version, json(content), input.actor.type === 'owner' ? 'agent:persona-manager' : by, by],
    );
    await tx.query('UPDATE persona SET current_bible_version = $2, updated_at = now() WHERE id = $1', [input.personaId, version]);
    await audit(tx, {
      studioId: input.studioId,
      personaId: input.personaId,
      actor: input.actor,
      action: 'bible.revised',
      entityType: 'persona_bible',
      entityId: `${input.personaId}:v${version}`,
      data: { section: input.section, rule: input.rule, from: cur?.version ?? null, to: version },
    });
    return version;
  });
}

