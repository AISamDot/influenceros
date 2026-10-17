import type { QcCheck } from '@troupe/agents';
import type { Db } from '@troupe/db';
import type { ColorGrade } from './toolkit';

/** Read models for the dashboard: the slot page's media section and the persona page's media panel. */

export interface SlotMediaAsset {
  id: string;
  type: string;
  role: string | null;
  url: string;
  contentType: string | null;
  width: number | null;
  height: number | null;
  durationS: number | null;
  credits: number;
  usd: number;
  provider: string | null;
  index: number | null;
  /** A fake-mode stand-in (no keys): not a playable file. */
  fake: boolean;
  createdAt: Date;
}

export interface SlotMedia {
  step: string;
  waiting: string | null;
  loops: Record<string, number>;
  credits: number;
  usd: number;
  final: SlotMediaAsset[];
  cover: SlotMediaAsset | null;
  voice: SlotMediaAsset | null;
  generations: SlotMediaAsset[];
  reports: Array<{ id: string; stage: string; pass: boolean; score: number | null; checks: QcCheck[]; loop: number | null; createdAt: Date }>;
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));

function toAsset(r: { id: string; type: string; role: string | null; url: string; render_meta: Record<string, unknown>; credit_cost: number; usd_cost: string; provider: string | null; created_at: Date }): SlotMediaAsset {
  const m = r.render_meta ?? {};
  return {
    id: r.id,
    type: r.type,
    role: r.role,
    url: r.url,
    contentType: (m.content_type as string | undefined) ?? null,
    width: num(m.width),
    height: num(m.height),
    durationS: num(m.duration_s),
    credits: Number(r.credit_cost),
    usd: Number(r.usd_cost),
    provider: r.provider,
    index: num(m.index),
    fake: m.fake === true,
    createdAt: new Date(r.created_at),
  };
}

export async function slotMedia(db: Db, slotId: string): Promise<SlotMedia | null> {
  const mr = await db.maybeOne<{ step: string; waiting: string | null; loops: Record<string, number>; credits: string; usd_cost: string; cover_asset_id: string | null; state: { final?: { assetIds?: string[] } } }>(
    'SELECT step, waiting, loops, credits, usd_cost, cover_asset_id, state FROM media_render WHERE slot_id = $1',
    [slotId],
  );
  if (!mr) return null;
  const assets = (
    await db.query<Parameters<typeof toAsset>[0]>(
      `SELECT id, type, role, url, render_meta, credit_cost, usd_cost, provider, created_at FROM asset WHERE slot_id = $1 ORDER BY created_at`,
      [slotId],
    )
  ).map(toAsset);
  // The current final render (one video or image, or every carousel slide in order).
  const final = (mr.state?.final?.assetIds ?? []).map((id) => assets.find((a) => a.id === id)).filter((a): a is SlotMediaAsset => !!a);
  const ids = assets.map((a) => a.id);
  const reports = ids.length
    ? await db.query<{ id: string; stage: string; pass: boolean; score: string | null; details: { checks?: QcCheck[]; loop?: number }; created_at: Date }>(
        `SELECT id, stage, pass, score, details, created_at FROM qc_report WHERE subject_type = 'asset' AND subject_id = ANY($1::uuid[]) ORDER BY created_at`,
        [ids],
      )
    : [];
  return {
    step: mr.step,
    waiting: mr.waiting,
    loops: mr.loops ?? {},
    credits: Number(mr.credits),
    usd: Number(mr.usd_cost),
    final,
    cover: mr.cover_asset_id ? (assets.find((a) => a.id === mr.cover_asset_id) ?? null) : null,
    voice: [...assets].reverse().find((a) => a.role === 'voice') ?? null,
    generations: assets.filter((a) => a.role === 'still' || a.role === 'clip'),
    reports: reports.map((q) => ({ id: q.id, stage: q.stage, pass: q.pass, score: num(q.score), checks: q.details?.checks ?? [], loop: q.details?.loop ?? null, createdAt: new Date(q.created_at) })),
  };
}

export interface PersonaMedia {
  soulId: string | null;
  soulStatus: string;
  referenceUrl: string | null;
  voiceProvider: string | null;
  voiceId: string | null;
  grade: ColorGrade | null;
  looks: Array<{ url: string; label: string }>;
  renders: Array<{ slotId: string; title: string; format: string; status: string; step: string; coverUrl: string | null; credits: number; updatedAt: Date }>;
  monthCredits: number;
  monthUsd: number;
}

export async function personaMedia(db: Db, personaId: string, now: Date = new Date()): Promise<PersonaMedia> {
  const p = await db.maybeOne<{ soul_id: string | null; soul_status: string; reference_key: string | null; voice_provider: string | null; voice_id: string | null; grade: ColorGrade | Record<string, never> }>(
    'SELECT soul_id, soul_status, reference_key, voice_provider, voice_id, grade FROM media_profile WHERE persona_id = $1',
    [personaId],
  );
  const ref = await db.maybeOne<{ url: string }>(`SELECT url FROM asset WHERE persona_id = $1 AND role = 'reference' AND COALESCE(render_meta->>'fake', 'false') <> 'true' ORDER BY created_at DESC LIMIT 1`, [personaId]);
  const looks = await db.query<{ url: string; render_meta: { setting?: string; outfit?: string } }>(`SELECT url, render_meta FROM asset WHERE persona_id = $1 AND role = 'look' AND COALESCE(render_meta->>'fake', 'false') <> 'true' ORDER BY created_at DESC LIMIT 6`, [personaId]);
  const renders = await db.query<{ slot_id: string; title: string; format: string; status: string; step: string; cover: string | null; credits: string; updated_at: Date }>(
    `SELECT m.slot_id, s.title, s.format, s.status, m.step, (SELECT url FROM asset a WHERE a.id = m.cover_asset_id) AS cover, m.credits, m.updated_at
       FROM media_render m JOIN calendar_slot s ON s.id = m.slot_id WHERE m.persona_id = $1 ORDER BY m.updated_at DESC LIMIT 8`,
    [personaId],
  );
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const spend = await db.one<{ credits: string; usd: string }>(
    `SELECT COALESCE(sum(credits), 0) AS credits, COALESCE(sum(usd_cost), 0) AS usd FROM media_generation WHERE persona_id = $1 AND created_at >= $2`,
    [personaId, month],
  );
  return {
    soulId: p?.soul_id ?? null,
    soulStatus: p?.soul_status ?? 'none',
    referenceUrl: ref?.url ?? null,
    voiceProvider: p?.voice_provider ?? null,
    voiceId: p?.voice_id ?? null,
    grade: p?.grade && 'contrast' in p.grade ? (p.grade as ColorGrade) : null,
    looks: looks.map((l) => ({ url: l.url, label: [l.render_meta?.setting, l.render_meta?.outfit].filter(Boolean).join(' · ') })),
    renders: renders.map((r) => ({ slotId: r.slot_id, title: r.title, format: r.format, status: r.status, step: r.step, coverUrl: r.cover, credits: Number(r.credits), updatedAt: new Date(r.updated_at) })),
    monthCredits: Number(spend.credits),
    monthUsd: Number(spend.usd),
  };
}
