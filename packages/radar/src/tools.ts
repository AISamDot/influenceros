import type { Caller, ToolDef } from '@ios/agents';
import { addSeeds, loadConfig, type NicheSeeds } from './config';
import { formatBenchmarks, monetisationPatterns } from './insights';
import { enqueueWeekly } from './jobs';
import { createRemixBrief } from './remix';
import { radarSummary, reportText } from './report';
import { internalWinners, shortlistFor } from './winners';

/**
 * Stream I tools (namespaces `radar.*`, `winners.*`, `remix.*`). The Studio Manager's three: `radar.report`,
 * `winners.shortlist`, `remix.brief`. Reads that return scraped labels (tags, sound names, handles, URLs) set
 * `untrustedOutput`, so the rest of that run can't drive a write; every mutating tool needs the Owner to have asked
 * for it (`ownerIntent`) when the run is untrusted. Raising the Apify cap is not a tool: it's an Owner setting.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READERS: readonly Caller[] = ['studio-manager', 'persona-manager', 'monetization-agent', 'trend-scout', 'owner', 'system'];
const MANAGERS: readonly Caller[] = ['studio-manager', 'persona-manager', 'owner', 'system'];

function obj(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('input must be an object');
  const o = raw as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !keys.includes(k));
  if (extra.length) throw new Error(`unknown input keys: ${extra.join(', ')}`);
  return o;
}
const uuid = (o: Record<string, unknown>, k: string, optional = false): string | undefined => {
  const v = o[k];
  if ((v === undefined || v === null) && optional) return undefined;
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw new Error(`${k} must be a uuid`);
  return v;
};
const text = (o: Record<string, unknown>, k: string, max = 120, optional = false): string | undefined => {
  const v = o[k];
  if ((v === undefined || v === null || v === '') && optional) return undefined;
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${k} must be a non-empty string`);
  if (v.length > max) throw new Error(`${k} is longer than ${max} characters`);
  return v.trim();
};
const list = (o: Record<string, unknown>, k: string): string[] | undefined => {
  const v = o[k];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x.length > 60)) throw new Error(`${k} must be a list of short strings`);
  return (v as string[]).slice(0, 20);
};
const intIn = (o: Record<string, unknown>, k: string, min: number, max: number): number | undefined => {
  const v = o[k];
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${k} must be an integer from ${min} to ${max}`);
  return n;
};
const PERSONA = { type: 'string', format: 'uuid', description: 'The persona id (uuid). A persona manager may only pass its own.' } as const;

const radarReport: ToolDef<Record<string, never>, { text: string; summary: Awaited<ReturnType<typeof radarSummary>> }> = {
  name: 'radar.report',
  description:
    'The Growth Radar right now: tracked and accelerating accounts, this week’s trends (hooks, formats, topics, sounds adopted by several accelerating accounts), what breaks out by format per niche, Viral Remix bookings and Apify spend against the weekly cap. Handles, tags and sound names are third-party labels.',
  scope: 'studio',
  callers: READERS,
  untrustedOutput: true,
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  parse: (raw) => (obj(raw, []), {}),
  async run(ctx) {
    const summary = await radarSummary(ctx.services.db, ctx.studioId, ctx.services.now());
    return { text: reportText(summary), summary };
  },
};

const radarBenchmarks: ToolDef<{ niche: string }, unknown> = {
  name: 'radar.benchmarks',
  description:
    'Format and cadence benchmarks for a niche from the Growth Radar: share of the niche’s outlier posts per format (talking, text overlay, voiceover, static, carousel, photo dump, …), the median outlier score per format, and how often the fast growers post. null when the Radar has no data for the niche yet.',
  scope: 'studio',
  callers: READERS,
  inputSchema: { type: 'object', additionalProperties: false, required: ['niche'], properties: { niche: { type: 'string', maxLength: 80 } } },
  parse: (raw) => ({ niche: text(obj(raw, ['niche']), 'niche', 80)! }),
  run: (ctx, i) => formatBenchmarks(ctx.services.db, ctx.studioId, i.niche, ctx.services.now()),
};

const radarPatterns: ToolDef<{ niche: string }, unknown> = {
  name: 'radar.patterns',
  description: 'How the fast-growing accounts in a niche make money (bio link, digital products, memberships, Fanvue, brand deals, affiliate), as shares of the accounts reviewed.',
  scope: 'studio',
  callers: READERS,
  inputSchema: { type: 'object', additionalProperties: false, required: ['niche'], properties: { niche: { type: 'string', maxLength: 80 } } },
  parse: (raw) => ({ niche: text(obj(raw, ['niche']), 'niche', 80)! }),
  run: (ctx, i) => monetisationPatterns(ctx.services.db, ctx.studioId, i.niche),
};

const radarScan: ToolDef<Record<string, never>, { job_id: string | null; note: string }> = {
  name: 'radar.scan',
  description: 'Queue this week’s Growth Radar run now (discovery, snapshots, reviews, trends, remix briefs, Trend Report). It is deduplicated per week and stays inside the Apify weekly cap.',
  scope: 'studio',
  callers: ['studio-manager', 'owner', 'system'],
  mutates: true,
  ownerIntent: /\b(?:run|start|refresh|redo|kick\s+off|trigger|launch)\b.*\b(?:radar|scan|trend\s+scan|growth\s+radar)\b/i,
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  parse: (raw) => (obj(raw, []), {}),
  async run(ctx) {
    const id = await enqueueWeekly(ctx.services, ctx.studioId);
    return { job_id: id, note: id ? 'Radar run queued.' : 'This week’s Radar run is already queued or done.' };
  },
};

const radarSeed: ToolDef<{ niche: string; hashtags?: string[]; keywords?: string[]; accounts?: string[] }, NicheSeeds> = {
  name: 'radar.seed',
  description: 'Add seed hashtags, keywords or public accounts (\'@handle\' for Instagram, \'tiktok:@handle\') for a niche, so the next Radar run tracks them.',
  scope: 'studio',
  callers: ['studio-manager', 'owner'],
  mutates: true,
  ownerIntent: /\b(?:add|track|follow|watch|seed|monitor)\b.*\b(?:accounts?|hashtags?|keywords?|seeds?|creators?|handles?|@\w+)/i,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['niche'],
    properties: {
      niche: { type: 'string', maxLength: 80 },
      hashtags: { type: 'array', items: { type: 'string', maxLength: 60 } },
      keywords: { type: 'array', items: { type: 'string', maxLength: 60 } },
      accounts: { type: 'array', items: { type: 'string', maxLength: 60 } },
    },
  },
  parse: (raw) => {
    const o = obj(raw, ['niche', 'hashtags', 'keywords', 'accounts']);
    return { niche: text(o, 'niche', 80)!, hashtags: list(o, 'hashtags'), keywords: list(o, 'keywords'), accounts: list(o, 'accounts') };
  },
  run: (ctx, i) => addSeeds(ctx.services.db, ctx.studioId, i.niche, { hashtags: i.hashtags, keywords: i.keywords, accounts: i.accounts }),
};

const winnersShortlist: ToolDef<{ persona_id: string; limit?: number }, unknown> = {
  name: 'winners.shortlist',
  description:
    'Winner Finder shortlist for a persona: fresh (≤ 14 days) public posts in its niche at ≥ 5× their creator’s median, ranked by outlier score, views ÷ followers, saves+shares ÷ views, recency, replicability, monetisation fit and novelty against the persona’s history. Labels and numbers only; handles, tags and URLs are third-party.',
  scope: 'persona',
  callers: MANAGERS,
  untrustedOutput: true,
  inputSchema: { type: 'object', additionalProperties: false, required: ['persona_id'], properties: { persona_id: PERSONA, limit: { type: 'integer', minimum: 1, maximum: 25 } } },
  parse: (raw) => {
    const o = obj(raw, ['persona_id', 'limit']);
    return { persona_id: uuid(o, 'persona_id')!, limit: intIn(o, 'limit', 1, 25) };
  },
  async run(ctx, i) {
    const cfg = await loadConfig(ctx.services.db, ctx.studioId);
    return shortlistFor(ctx.services.db, i.persona_id, ctx.services.now(), { limit: i.limit ?? cfg.limits.shortlistSize });
  },
};

const winnersInternal: ToolDef<{ persona_id: string }, unknown> = {
  name: 'winners.internal',
  description: 'The persona’s own winners: posts from the last 14 days beating its median by ≥ 2× on views and saves + shares (candidates to double down on).',
  scope: 'persona',
  callers: MANAGERS,
  inputSchema: { type: 'object', additionalProperties: false, required: ['persona_id'], properties: { persona_id: PERSONA } },
  parse: (raw) => ({ persona_id: uuid(obj(raw, ['persona_id']), 'persona_id')! }),
  run: (ctx, i) => internalWinners(ctx.services.db, i.persona_id, ctx.services.now()),
};

const remixBrief: ToolDef<{ persona_id: string; radar_post_id?: string }, unknown> = {
  name: 'remix.brief',
  description:
    'Turn a winner into a Viral Remix brief for a persona: the same mechanic (hook type, format, structure) as a new concept in the persona’s own world and voice. It passes the no-repeat check and is booked as an idea in the calendar. Omit radar_post_id to use the persona’s top shortlisted winner.',
  scope: 'persona',
  callers: MANAGERS,
  mutates: true,
  ownerIntent: /\b(?:remix|brief|make|create|draft|book|turn|rebuild)\b.*\b(?:remix|brief|winner|outlier|reel|trend)/i,
  inputSchema: { type: 'object', additionalProperties: false, required: ['persona_id'], properties: { persona_id: PERSONA, radar_post_id: { type: 'string', format: 'uuid' } } },
  parse: (raw) => {
    const o = obj(raw, ['persona_id', 'radar_post_id']);
    return { persona_id: uuid(o, 'persona_id')!, radar_post_id: uuid(o, 'radar_post_id', true) };
  },
  async run(ctx, i) {
    const r = await createRemixBrief(ctx.services, { personaId: i.persona_id, radarPostId: i.radar_post_id ?? null, actor: ctx.actor });
    if (!r) return { status: 'none', note: 'No fresh winner in this persona’s niche yet.' };
    return { brief_id: r.briefId, status: r.status, idea_id: r.ideaId, format: r.format, target_format: r.targetFormat, title: r.concept.title, hook: r.concept.hook, no_repeat: r.noRepeat };
  },
};

const remixList: ToolDef<{ persona_id: string }, unknown> = {
  name: 'remix.list',
  description: 'The persona’s recent Viral Remix briefs and double-downs: concept, format, status (booked / blocked as a repeat) and the idea they became.',
  scope: 'persona',
  callers: MANAGERS,
  inputSchema: { type: 'object', additionalProperties: false, required: ['persona_id'], properties: { persona_id: PERSONA } },
  parse: (raw) => ({ persona_id: uuid(obj(raw, ['persona_id']), 'persona_id')! }),
  run: (ctx, i) =>
    ctx.services.db.query(
      `SELECT id, kind, format, status, concept->>'title' AS title, concept->>'hook' AS hook, mechanic->>'hook_label' AS mechanic, idea_id, created_at
         FROM remix_brief WHERE persona_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [i.persona_id],
    ),
};

export const radarTools: ReadonlyArray<ToolDef<any, any>> = [radarReport, radarBenchmarks, radarPatterns, radarScan, radarSeed, winnersShortlist, winnersInternal, remixBrief, remixList];
