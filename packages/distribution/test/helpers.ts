import type { AgentResult, AgentTask, PublishPreparePayload, RenderedMedia, StudioServices } from '@ios/agents';
import { createTestStudio, makeTestPersona, type TestStudio } from '@ios/agents/testing';
import type { PostFormat } from '@ios/core';
import { json } from '@ios/db';
import type { Platform } from '@ios/providers';

export interface Ctx extends TestStudio {
  /** Services with a controllable clock and an optional runtime override. */
  svc: StudioServices;
  clock: { now: Date };
  tasks: AgentTask<any>[];
  /** Return a value to replace a run's output (e.g. a model reply that denies being AI); undefined = task.fake(). */
  override: { fn: ((task: AgentTask<any>) => unknown) | null };
}

export async function setup(): Promise<Ctx> {
  const t = await createTestStudio();
  const clock = { now: new Date('2026-10-20T12:00:00Z') };
  const tasks: AgentTask<any>[] = [];
  const override: Ctx['override'] = { fn: null };
  const runtime = {
    mode: 'fake' as const,
    async run<T>(task: AgentTask<T>): Promise<AgentResult<T>> {
      tasks.push(task);
      const o = override.fn?.(task);
      const output = (o === undefined ? task.fake() : o) as T;
      return { output, text: typeof output === 'string' ? output : JSON.stringify(output), mode: 'fake', model: 'fake', runId: 'run', costUsd: 0, toolCalls: [] };
    },
  };
  const svc: StudioServices = { ...t.services, runtime, now: () => clock.now };
  return { ...t, svc, clock, tasks, override };
}

export async function persona(ctx: Ctx, opts: Parameters<typeof makeTestPersona>[1] & { ageDays?: number } = {}) {
  const p = await makeTestPersona(ctx, opts);
  const started = new Date(ctx.clock.now.getTime() - (opts.ageDays ?? 5) * 86_400_000);
  await ctx.db.query(`UPDATE persona SET launched_at = $2, created_at = $2 WHERE id = $1`, [p.id, started]);
  return p;
}

let handleSeq = 0;
export async function account(ctx: Ctx, personaId: string, platform: Platform, opts: { aiLabel?: boolean; status?: string; tokenRef?: string | null } = {}) {
  handleSeq += 1;
  const handle = `h${handleSeq}_${Math.random().toString(36).slice(2, 7)}`;
  return ctx.db.one<{ id: string; handle: string }>(
    `INSERT INTO account (persona_id, platform, handle, status, ai_label_ok, token_ref) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, handle`,
    [personaId, platform, handle, opts.status ?? 'active', opts.aiLabel ?? true, opts.tokenRef === undefined ? `zr_${handle}` : opts.tokenRef],
  );
}

export async function slot(ctx: Ctx, personaId: string, format: PostFormat = 'talking', opts: { ctaKeyword?: string; at?: Date } = {}) {
  return ctx.db.one<{ id: string }>(
    `INSERT INTO calendar_slot (persona_id, slot_at, format, purpose, title, status, cta_keyword) VALUES ($1, $2, $3, 'reach', 'Budget in 5 minutes', 'final_gate', $4) RETURNING id`,
    [personaId, opts.at ?? new Date(ctx.clock.now.getTime() + 3_600_000), format, opts.ctaKeyword ?? 'BUDGET'],
  );
}

export async function stored(ctx: Ctx, key: string, kind: 'video' | 'image', width: number, height: number, durationS: number | null): Promise<RenderedMedia> {
  const contentType = kind === 'video' ? 'video/mp4' : 'image/jpeg';
  const o = await ctx.providers.storage.put({ key, data: `fake ${kind} bytes`, contentType });
  return { assetId: '00000000-0000-4000-8000-000000000001', kind, storageKey: key, url: o.url, contentType, width, height, durationS };
}

/** A payload as stream E would enqueue it, with the files in the memory store. */
export async function preparePayload(
  ctx: Ctx,
  personaId: string,
  slotId: string,
  format: PostFormat,
  opts: { caption?: string; size?: [number, number]; trendingSound?: boolean; slides?: number } = {},
): Promise<PublishPreparePayload> {
  const base = `media/${personaId}/${slotId}`;
  const media: RenderedMedia[] = [];
  if (format === 'carousel') {
    for (let i = 0; i < (opts.slides ?? 6); i++) media.push(await stored(ctx, `${base}/slide-${i + 1}.jpg`, 'image', opts.size?.[0] ?? 1080, opts.size?.[1] ?? 1350, null));
  } else if (format === 'static') {
    media.push(await stored(ctx, `${base}/static.jpg`, 'image', opts.size?.[0] ?? 1080, opts.size?.[1] ?? 1920, null));
  } else {
    media.push(await stored(ctx, `${base}/final.mp4`, 'video', opts.size?.[0] ?? 1080, opts.size?.[1] ?? 1920, 28.5));
  }
  const cover = await stored(ctx, `${base}/cover.jpg`, 'image', 1080, 1920, null);
  return {
    slotId,
    personaId,
    scriptId: '',
    format,
    media,
    cover,
    caption: opts.caption ?? 'Three envelopes, one rule: spend on purpose. Comment BUDGET and I will send you the free tracker.',
    hashtags: ['budgeting', 'moneytips', 'personalfinance', 'savings', 'frugal', 'finance', 'extra'],
    ctaKeyword: 'BUDGET',
    aiGenerated: true,
    q4ReportId: '',
    ...(opts.trendingSound ? { trendingSound: true } : {}),
  };
}

export const status = async (ctx: Ctx, table: string, id: string) => (await ctx.db.one<{ status: string }>(`SELECT status FROM ${table} WHERE id = $1`, [id])).status;
export { json };
