import type { Caller, ToolDef } from '@ios/agents';
import { accountSetupSheet } from './accounts';
import { enqueuePull, personaScorecard } from './analytics';
import { enqueueHandle } from './community';
import { UUID_RE } from './util';

/**
 * Agent tools for stream F's namespaces (publish.*, community.*, analytics.*, accounts.*). Read tools are open to the
 * managers; the two mutating tools only queue work and need the Owner's ask in untrusted runs. Creating accounts,
 * approving posts, resolving S1s and approving the crisis text are Owner actions, never tools.
 */

type Raw = Record<string, unknown>;
const READERS: readonly Caller[] = ['studio-manager', 'persona-manager', 'community-manager', 'monetization-agent', 'profit-engine', 'owner', 'system'];

function obj(raw: unknown, allowed: readonly string[]): Raw {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('input must be an object');
  const extra = Object.keys(raw).filter((k) => !allowed.includes(k));
  if (extra.length) throw new Error(`unknown input fields: ${extra.join(', ')}`);
  return raw as Raw;
}
function personaId(r: Raw): string {
  const v = r.persona_id;
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw new Error('persona_id must be a uuid');
  return v;
}
const PID = { persona_id: { type: 'string', description: 'Persona id (uuid).' } };
const schema = (props: Record<string, object>, required: string[]) => ({ type: 'object', properties: { ...PID, ...props }, required: ['persona_id', ...required], additionalProperties: false });

const publishStatus: ToolDef<{ persona_id: string; limit: number }> = {
  name: 'publish.status',
  description: "A persona's recent posts per platform: status (awaiting approval, scheduled, live, blocked, failed), time, URL and why a post is blocked. The AI flag is always on.",
  scope: 'persona',
  callers: READERS,
  inputSchema: schema({ limit: { type: 'integer', minimum: 1, maximum: 50 } }, []),
  parse(raw) {
    const r = obj(raw, ['persona_id', 'limit']);
    const limit = r.limit === undefined ? 20 : Number(r.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('limit must be 1–50');
    return { persona_id: personaId(r), limit };
  },
  async run(ctx, i) {
    return ctx.services.db.query(
      `SELECT id, platform, format, status, scheduled_at, published_at, url, ai_flag, meta->>'mode' AS mode, meta->>'blocked_reason' AS blocked_reason
         FROM post WHERE persona_id = $1 ORDER BY COALESCE(published_at, scheduled_at, created_at) DESC LIMIT $2`,
      [i.persona_id, i.limit],
    );
  },
};

const communityQueue: ToolDef<{ persona_id: string }> = {
  name: 'community.queue',
  description: "A persona's community state: open escalations (S1/S2), recent comments by class and action, paused DM threads, and counts for the last 7 days. Contains commenters' text (untrusted).",
  scope: 'persona',
  callers: READERS,
  untrustedOutput: true,
  inputSchema: schema({}, []),
  parse: (raw) => ({ persona_id: personaId(obj(raw, ['persona_id'])) }),
  async run(ctx, i) {
    const { db } = ctx.services;
    const since = new Date(ctx.services.now().getTime() - 7 * 86_400_000);
    const [escalations, byClass, recent, paused] = await Promise.all([
      db.query(`SELECT id, severity, category, summary, sla_due_at, status FROM escalation WHERE persona_id = $1 AND status <> 'resolved' ORDER BY severity, created_at`, [i.persona_id]),
      db.query(`SELECT classification, action, count(*)::int AS n FROM comment WHERE persona_id = $1 AND created_at > $2 GROUP BY 1, 2 ORDER BY n DESC`, [i.persona_id, since]),
      db.query(`SELECT platform, classification, action, status, left(text, 200) AS text, created_at FROM comment WHERE persona_id = $1 ORDER BY created_at DESC LIMIT 15`, [i.persona_id]),
      db.query(`SELECT platform, classification, paused_reason, last_message_at FROM dm_thread WHERE persona_id = $1 AND status = 'bot_paused' ORDER BY last_message_at DESC LIMIT 10`, [i.persona_id]),
    ]);
    return { escalations, byClass, recent, paused };
  },
};

const communityHandle: ToolDef<{ persona_id: string }> = {
  name: 'community.handle_now',
  description: "Queue the community worker for a persona now: classify new comments and DMs, hide spam, reply and DM by policy (Gate-checked, within reply budgets), escalate S1/S2.",
  scope: 'persona',
  mutates: true,
  callers: ['studio-manager', 'persona-manager', 'community-manager', 'owner', 'system'],
  ownerIntent: /\b(?:handle|process|answer|reply to|clear|work through)\b.*\b(?:comments?|dms?|messages|community|inbox)\b/i,
  inputSchema: schema({}, []),
  parse: (raw) => ({ persona_id: personaId(obj(raw, ['persona_id'])) }),
  async run(ctx, i) {
    return { queued: await enqueueHandle(ctx.services, i.persona_id, ctx.studioId) };
  },
};

const scorecard: ToolDef<{ persona_id: string; days: number }> = {
  name: 'analytics.scorecard',
  description: "A persona's scorecard from post metrics: posts, views, average watch time, like/save/share rates, follows and link clicks per 1,000 views, median views at 1h/24h/72h/7d, and the top posts.",
  scope: 'persona',
  callers: READERS,
  inputSchema: schema({ days: { type: 'integer', minimum: 1, maximum: 90, description: 'Look-back in days (default 7).' } }, []),
  parse(raw) {
    const r = obj(raw, ['persona_id', 'days']);
    const days = r.days === undefined ? 7 : Number(r.days);
    if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error('days must be 1–90');
    return { persona_id: personaId(r), days };
  },
  run: (ctx, i) => personaScorecard(ctx.services, i.persona_id, i.days),
};

const pullNow: ToolDef<{ persona_id: string }> = {
  name: 'analytics.pull_now',
  description: 'Queue a metrics pull now (captures any due 1h/24h/72h/7d windows for live posts).',
  scope: 'persona',
  mutates: true,
  callers: ['studio-manager', 'persona-manager', 'profit-engine', 'owner', 'system'],
  ownerIntent: /\b(?:pull|refresh|update|fetch|sync)\b.*\b(?:metrics|analytics|stats|numbers|views)\b/i,
  inputSchema: schema({}, []),
  parse: (raw) => ({ persona_id: personaId(obj(raw, ['persona_id'])) }),
  async run(ctx) {
    return { queued: await enqueuePull(ctx.services) };
  },
};

const setupSheet: ToolDef<{ persona_id: string }> = {
  name: 'accounts.setup_sheet',
  description: "The persona's account-setup sheet for the Owner: per platform the handle (or a suggestion), bio, profile image, link-in-bio and the AI-label steps, with each account's status. Creating accounts is the Owner's job.",
  scope: 'persona',
  callers: READERS,
  inputSchema: schema({}, []),
  parse: (raw) => ({ persona_id: personaId(obj(raw, ['persona_id'])) }),
  run: (ctx, i) => accountSetupSheet(ctx.services.db, i.persona_id, ctx.services.now()),
};

export const F_TOOLS: ReadonlyArray<ToolDef<any, any>> = [publishStatus, communityQueue, communityHandle, scorecard, pullNow, setupSheet];
