'use server';

import { OWNER, POST_FORMATS, type PostFormat } from '@ios/core';
import { approveStoryFrame, defaultPlan, editPlan, type PlanPatch, planInForce, recommendPlan, savePlan, mediaBudgetUsd } from '@ios/formats';
import { getDraft, setDraftExtension } from '@ios/generator';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { authOff, currentSession } from '@/lib/auth';
import { getServices } from '@/lib/services';
import { studioContext } from '@/lib/server';

/**
 * Stream L actions (docs/IOS-5-CONTRACTS.md §5.5): the Owner edits a Format Plan in the Persona Generator (a new draft
 * version through `setDraftExtension`) or on the persona page (a new plan version), and releases held Story frames.
 * Every one is the Owner's (session checked here), runs as OWNER and returns with ?ok= or ?error=.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9-]{1,80}$/;
const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();

async function run(fallback: string, fn: () => Promise<{ to: string; ok?: string }>): Promise<never> {
  if (!authOff() && !(await currentSession())) redirect('/login');
  let target: string;
  try {
    const r = await fn();
    target = r.ok ? `${r.to}${r.to.includes('?') ? '&' : '?'}ok=${encodeURIComponent(r.ok)}` : r.to;
  } catch (err) {
    target = `${fallback}${fallback.includes('?') ? '&' : '?'}error=${encodeURIComponent(err instanceof Error ? err.message : String(err))}`;
  }
  revalidatePath('/', 'layout');
  redirect(target);
}

/** The form's patch: `count_<format>` numbers, `on_<format>` checkboxes (optional formats), `stories_per_day`. */
function patchFrom(form: FormData, current: { lines: ReadonlyArray<{ format: PostFormat; perWeek: number; enabled: boolean }>; stories: { perDay: number } }): PlanPatch {
  const counts: Partial<Record<PostFormat, number>> = {};
  const enabled: Partial<Record<PostFormat, boolean>> = {};
  for (const f of POST_FORMATS) {
    const line = current.lines.find((l) => l.format === f);
    const raw = form.get(`count_${f}`);
    if (raw !== null && String(raw).trim() !== '') {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > 21) throw new Error(`${f}: a whole number 0–21`);
      if (n !== (line?.enabled ? line.perWeek : 0)) counts[f] = n;
    }
    if (form.has(`has_on_${f}`)) {
      const on = form.get(`on_${f}`) === 'on';
      if (on !== !!line?.enabled) enabled[f] = on;
    }
  }
  const spd = Number(str(form, 'stories_per_day') || current.stories.perDay);
  if (!Number.isInteger(spd) || spd < 3 || spd > 5) throw new Error('Stories: 3–5 a day');
  const note = str(form, 'note').slice(0, 200);
  return {
    ...(Object.keys(counts).length ? { counts } : {}),
    ...(Object.keys(enabled).length ? { enabled } : {}),
    ...(spd !== current.stories.perDay ? { storiesPerDay: spd } : {}),
    ...(note ? { note } : {}),
  };
}

/** Generator step 6: the Owner's edit of the recommended plan (a new draft version). */
export async function saveDraftPlan(form: FormData): Promise<void> {
  const id = str(form, 'draft_id');
  if (!UUID.test(id)) throw new Error('unknown draft');
  const back = `/generator/${id}?step=6`;
  await run(back, async () => {
    const services = await getServices();
    const d = await getDraft(services.db, id);
    if (!d) throw new Error('unknown draft');
    const current = d.state.formatPlan ?? defaultPlan();
    const patch = patchFrom(form, current);
    if (!patch.counts && !patch.enabled && patch.storiesPerDay === undefined) return { to: back, ok: 'Nothing changed' };
    const v = Number(str(form, 'version'));
    await setDraftExtension(services, id, 'formatPlan', editPlan(current, patch), { actor: OWNER, expectVersion: Number.isInteger(v) && v > 0 ? v : undefined, change: 'format plan: edited' });
    return { to: back, ok: 'Format Plan saved' };
  });
}

/** Generator step 6: redo the Studio Manager's recommendation for the draft's concept. */
export async function resetDraftPlan(form: FormData): Promise<void> {
  const id = str(form, 'draft_id');
  if (!UUID.test(id)) throw new Error('unknown draft');
  const back = `/generator/${id}?step=6`;
  await run(back, async () => {
    const services = await getServices();
    const d = await getDraft(services.db, id);
    if (!d) throw new Error('unknown draft');
    const concept = d.state.concept.chosen;
    const ladder = (d.state.content.chosen?.ladder ?? []).map((x) => ({ rung: x.rung, priceCents: x.priceCents }));
    const plan = await services.formatPlans.recommend({ studioId: d.studio_id, niche: d.state.opportunity.chosen?.niche ?? 'general', archetype: concept?.archetype ?? '', ladder });
    if (!plan) throw new Error('no recommendation available');
    await setDraftExtension(services, id, 'formatPlan', plan, { actor: OWNER, change: 'format plan: recommendation restored' });
    return { to: back, ok: 'Recommendation restored' };
  });
}

/** Persona page: the Owner's edit of the plan in force (a new version, used from the next week planned). */
export async function savePersonaPlan(form: FormData): Promise<void> {
  const slug = str(form, 'slug');
  if (!SLUG.test(slug)) throw new Error('unknown persona');
  const back = `/personas/${slug}`;
  await run(back, async () => {
    const services = await getServices();
    const { studio } = await studioContext();
    const p = await services.db.maybeOne<{ id: string; niche: string; budget: Record<string, unknown> }>('SELECT id, niche, budget FROM persona WHERE studio_id = $1 AND slug = $2', [studio.id, slug]);
    if (!p) throw new Error('unknown persona');
    const now = services.now();
    const inForce = await planInForce(services.db, p.id, now);
    let current = inForce ? (({ version: _v, leverReason: _l, ...rest }) => rest)(inForce) : null;
    if (!current) current = recommendPlan({ niche: p.niche, archetype: '', ladder: [], budgetUsdPerMonth: await mediaBudgetUsd(services.db, studio.id, p.budget), benchmark: null });
    const patch = patchFrom(form, current);
    if (!patch.counts && !patch.enabled && patch.storiesPerDay === undefined) return { to: back, ok: 'Nothing changed' };
    const v = await savePlan(services.db, { studioId: studio.id, personaId: p.id, plan: editPlan(current, patch), actor: OWNER, now, action: 'formats.plan_edited' });
    return { to: back, ok: `Format Plan v${v.version} saved: used from the next week planned` };
  });
}

/** Releases a Story frame held for the Owner (Gate amber or an L0 persona). */
export async function approveFrame(form: FormData): Promise<void> {
  const id = str(form, 'frame_id');
  const back = str(form, 'back').startsWith('/') ? str(form, 'back') : '/pipeline';
  if (!UUID.test(id)) throw new Error('unknown frame');
  await run(back, async () => {
    const services = await getServices();
    const { studio } = await studioContext();
    const f = await services.db.maybeOne('SELECT 1 FROM story_frame WHERE id = $1 AND studio_id = $2', [id, studio.id]);
    if (!f) throw new Error('unknown frame');
    await approveStoryFrame(services, id, OWNER);
    return { to: back, ok: 'Story frame approved' };
  });
}
