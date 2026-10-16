import { HIGHLIGHT_SETS, type HighlightSet, type StoryFrameKind, type StudioServices } from '@ios/agents';
import { type Actor, audit } from '@ios/core';
import { json } from '@ios/db';
import { editPlan } from './plan';
import { planInForce, savePlan } from './store';
import { storyStats } from './stories';
import { DAY_MS, isoDate, mondayOf } from './time';

/**
 * Highlights (FR-4.3d): the Persona Manager keeps the best published frames in four sets, "Start here", "Free guide",
 * "Shop" and "Lore", refreshed weekly from story metrics. And the Stories lever: the frames-a-day count moves within
 * 3–5 from the same metrics (feeds the Format Plan).
 */

/** Which frame kinds feed each highlight set. */
export const HIGHLIGHT_KINDS: Readonly<Record<HighlightSet, readonly StoryFrameKind[]>> = {
  'Start here': ['world', 'storyline'],
  'Free guide': ['engagement'],
  Shop: ['sell'],
  Lore: ['storyline'],
};
export const HIGHLIGHT_MAX = 6;
const PERSONA_MANAGER: Actor = { type: 'agent', id: 'persona-manager' };

export interface HighlightRow {
  set_name: HighlightSet;
  frame_ids: string[];
  reason: string | null;
  curated_by: string;
  updated_at: Date;
}

export async function highlightsFor(services: Pick<StudioServices, 'db'>, personaId: string): Promise<HighlightRow[]> {
  return services.db.query<HighlightRow>(`SELECT set_name, frame_ids, reason, curated_by, updated_at FROM story_highlight WHERE persona_id = $1 ORDER BY set_name`, [personaId]);
}

interface Candidate {
  id: string;
  kind: StoryFrameKind;
  text: string;
  reach: number;
  replies: number;
  exits: number;
  story_date: string;
}

const SETS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sets'],
  properties: { sets: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['set', 'frame_ids', 'reason'], properties: { set: { type: 'string' }, frame_ids: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' } } } } },
} as const;

/** Ranks published frames per set (reach + 20 × replies − exits), newest first on ties. */
export function rankForSet(set: HighlightSet, frames: readonly Candidate[]): Candidate[] {
  const kinds = HIGHLIGHT_KINDS[set];
  const score = (c: Candidate) => c.reach + 20 * c.replies - c.exits;
  return frames.filter((f) => kinds.includes(f.kind)).sort((a, b) => score(b) - score(a) || b.story_date.localeCompare(a.story_date)).slice(0, HIGHLIGHT_MAX);
}

/** The Persona Manager's weekly highlight refresh. Only published frames from the last 60 days qualify. */
export async function curateHighlights(services: StudioServices, personaId: string, actor: Actor = PERSONA_MANAGER): Promise<HighlightRow[]> {
  const now = services.now();
  const persona = await services.db.one<{ studio_id: string; name: string }>('SELECT studio_id, name FROM persona WHERE id = $1', [personaId]);
  const frames = await services.db.query<Candidate>(
    `WITH latest AS (SELECT DISTINCT ON (story_frame_id) story_frame_id, reach, replies, exits FROM story_metric WHERE persona_id = $1 ORDER BY story_frame_id, captured_on DESC)
     SELECT f.id, f.kind, COALESCE(f.text, '') AS text, COALESCE(l.reach, 0)::int AS reach, COALESCE(l.replies, 0)::int AS replies, COALESCE(l.exits, 0)::int AS exits, f.story_date::text AS story_date
       FROM story_frame f LEFT JOIN latest l ON l.story_frame_id = f.id
      WHERE f.persona_id = $1 AND f.status = 'published' AND f.story_date >= $2::date`,
    [personaId, isoDate(new Date(now.getTime() - 60 * DAY_MS))],
  );
  const ranked = Object.fromEntries(HIGHLIGHT_SETS.map((s) => [s, rankForSet(s, frames)])) as Record<HighlightSet, Candidate[]>;
  const res = await services.runtime.run<{ sets: Array<{ set: string; frame_ids: string[]; reason: string }> }>({
    agent: 'persona-manager',
    scope: { studioId: persona.studio_id, personaId },
    label: 'highlights: weekly refresh',
    system: `You are ${persona.name}'s Persona Manager. Keep the Story highlight sets fresh: pick up to ${HIGHLIGHT_MAX} frames per set from the candidates only, best first. "Start here" introduces the persona; "Free guide" pushes the lead magnet; "Shop" the products; "Lore" the storyline. Return {"sets": [{"set": "...", "frame_ids": [...], "reason": "..."}]}.`,
    prompt: HIGHLIGHT_SETS.map((s) => `${s}:\n${ranked[s].map((c) => `- ${c.id} (${c.kind}, reach ${c.reach}, replies ${c.replies}): ${c.text.slice(0, 100)}`).join('\n') || '- none yet'}`).join('\n\n'),
    maxTokens: 1200,
    jsonSchema: SETS_SCHEMA,
    parse: (v) => v as { sets: Array<{ set: string; frame_ids: string[]; reason: string }> },
    fake: () => ({ sets: HIGHLIGHT_SETS.map((s) => ({ set: s, frame_ids: ranked[s].map((c) => c.id), reason: ranked[s].length ? `top ${ranked[s].length} by reach and replies` : 'no published frames yet' })) }),
    costRef: { type: 'persona', id: personaId },
  });
  for (const s of HIGHLIGHT_SETS) {
    const allowed = new Set(ranked[s].map((c) => c.id));
    const pick = res.output.sets?.find((x) => x.set === s);
    const ids = [...new Set((pick?.frame_ids ?? []).filter((id) => allowed.has(id)))].slice(0, HIGHLIGHT_MAX);
    const finalIds = ids.length ? ids : ranked[s].map((c) => c.id);
    await services.db.query(
      `INSERT INTO story_highlight (persona_id, set_name, frame_ids, reason, curated_by, updated_at) VALUES ($1, $2, $3::jsonb, $4, $5, $6)
       ON CONFLICT (persona_id, set_name) DO UPDATE SET frame_ids = EXCLUDED.frame_ids, reason = EXCLUDED.reason, curated_by = EXCLUDED.curated_by, updated_at = EXCLUDED.updated_at`,
      [personaId, s, json(finalIds), (pick?.reason ?? '').slice(0, 300) || null, `${actor.type}:${actor.id}`, now],
    );
  }
  await audit(services.db, { studioId: persona.studio_id, personaId, actor, action: 'highlights.curated', entityType: 'persona', entityId: personaId, data: Object.fromEntries(HIGHLIGHT_SETS.map((s) => [s, ranked[s].length])) });
  return highlightsFor(services, personaId);
}

/** Stories lever thresholds: viewers dropping (exits + taps forward ÷ reach) and replies per 100 reached. */
export const STORY_TUNE = { minFrames: 14, lowDrop: 0.3, highDrop: 0.5, minReplyRate: 0.5 } as const;

/**
 * The Stories lever (weekly): with ≥ 2 weeks of frames, add a frame a day while viewers stay and reply, drop one when
 * they leave; always within 3–5. Writes a new Format Plan version (source 'lever') when it moves.
 */
export async function tuneStories(services: StudioServices, personaId: string): Promise<{ from: number; to: number; reason: string } | null> {
  const now = services.now();
  const plan = await planInForce(services.db, personaId, now);
  if (!plan) return null;
  const stats = await storyStats(services, personaId, now, 14);
  const frames = stats.reduce((a, s) => a + s.frames, 0);
  const reach = stats.reduce((a, s) => a + s.reach, 0);
  if (frames < STORY_TUNE.minFrames || !reach) return null;
  const drop = stats.reduce((a, s) => a + s.exits + s.tapsForward, 0) / reach;
  const replyRate = (stats.reduce((a, s) => a + s.replies, 0) / reach) * 100;
  const from = plan.stories.perDay;
  let to = from;
  if (drop < STORY_TUNE.lowDrop && replyRate >= STORY_TUNE.minReplyRate && from < 5) to = from + 1;
  else if (drop > STORY_TUNE.highDrop && from > 3) to = from - 1;
  if (to === from) return null;
  const reason = `Stories lever: ${Math.round(drop * 100)}% of viewers tap away or exit, ${replyRate.toFixed(1)} replies per 100 reached over ${frames} frames: ${from} → ${to} frames a day.`;
  const { version: _v, leverReason: _l, ...current } = plan;
  const next = editPlan(current, { storiesPerDay: to, note: reason }, 'lever');
  const persona = await services.db.one<{ studio_id: string }>('SELECT studio_id FROM persona WHERE id = $1', [personaId]);
  await savePlan(services.db, { studioId: persona.studio_id, personaId, plan: { ...next, reason }, actor: { type: 'agent', id: 'profit-engine' }, now, effectiveFrom: mondayOf(now), action: 'formats.stories_tuned' });
  return { from, to, reason };
}
