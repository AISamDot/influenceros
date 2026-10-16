'use server';

import { OWNER } from '@ios/core';
import {
  addOwnerIdea,
  archiveDraft,
  archiveStudioPersona,
  CHARACTER_FIELDS,
  type CharacterField,
  chooseOption,
  CONCEPT_PARTS,
  type ConceptPart,
  createDraft,
  editChosen,
  ensureReviewDraft,
  keepStep,
  launchDraft,
  mixConcepts,
  pickAlternative,
  regenerateStep,
  restoreDraft,
  restoreFromArchive,
  restoreStudioPersona,
  restoreVersion,
  setLaunchPlan,
} from '@ios/generator';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { authOff, currentSession } from '@/lib/auth';
import { getServices } from '@/lib/services';
import { studioContext } from '@/lib/server';

/**
 * Persona Generator and archive actions. Every one is the Owner's (session checked here: server actions post to the
 * page URL), runs as OWNER, and returns to a page with ?ok= or ?error= (never the error page).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const draftIdOf = (f: FormData) => {
  const id = str(f, 'draft_id');
  if (!UUID.test(id)) throw new Error('unknown draft');
  return id;
};
const stepOf = (f: FormData) => {
  const n = Number(str(f, 'step'));
  if (!Number.isInteger(n) || n < 1 || n > 7) throw new Error('unknown step');
  return n;
};
const versionOf = (f: FormData) => {
  const v = Number(str(f, 'version'));
  return Number.isInteger(v) && v > 0 ? v : undefined;
};

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

const draftPage = (id: string, step?: number) => `/generator/${id}${step ? `?step=${step}` : ''}`;

export async function startDraft(form: FormData): Promise<void> {
  await run('/generator', async () => {
    const services = await getServices();
    const { studio } = await studioContext();
    const idea = str(form, 'idea').slice(0, 600) || null;
    const d = await createDraft(services, { studioId: studio.id, idea, actor: OWNER });
    return { to: draftPage(d.id, 1) };
  });
}

export async function pickOption(form: FormData): Promise<void> {
  const id = draftIdOf(form);
  const step = stepOf(form);
  await run(draftPage(id, step), async () => {
    const d = await chooseOption(await getServices(), id, step, str(form, 'option') || 'A', { actor: OWNER, expectVersion: versionOf(form) });
    return { to: draftPage(id, Math.min(7, d.current_step)) };
  });
}

export async function regenerate(form: FormData): Promise<void> {
  const id = draftIdOf(form);
  const step = stepOf(form);
  await run(draftPage(id, step), async () => {
    await regenerateStep(await getServices(), id, step, { actor: OWNER, instruction: str(form, 'instruction') || null, expectVersion: versionOf(form) });
    return { to: draftPage(id, step), ok: 'New options drafted' };
  });
}

/** Owner edits: every field the form posts for the step (lists one per line). */
export async function editStep(form: FormData): Promise<void> {
  const id = draftIdOf(form);
  const step = stepOf(form);
  await run(draftPage(id, step), async () => {
    const patch: Record<string, unknown> = {};
    for (const [k, v] of form.entries()) {
      if (k.startsWith('f_')) patch[k.slice(2)] = String(v);
    }
    await editChosen(await getServices(), id, step, patch, { actor: OWNER, expectVersion: versionOf(form) });
    return { to: draftPage(id, step), ok: 'Saved' };
  });
}

/** "Keep as is" on a stale step: the Owner confirms what was drafted before an earlier change. */
export async function keepAsIs(form: FormData): Promise<void> {
  const id = draftIdOf(form);
  const step = stepOf(form);
  await run(draftPage(id, step), async () => {
    await keepStep(await getServices(), id, step, { actor: OWNER, expectVersion: versionOf(form) });
    return { to: draftPage(id, step), ok: 'Kept as is' };
  });
}

/** The Owner's own idea as an option on step 1. */
export async function addIdea(form: FormData): Promise<void> {
  const id = draftIdOf(form);
  await run(draftPage(id, 1), async () => {
    await addOwnerIdea(await getServices(), id, str(form, 'idea'), { actor: OWNER, expectVersion: versionOf(form) });
    return { to: draftPage(id, 1), ok: 'Your idea is on the list' };
  });
}

/** Step 7: the first-post date and timezone. */
export async function setLaunch(form: FormData): Promise<void> {
  const id = draftIdOf(form);
  await run(draftPage(id, 7), async () => {
    await setLaunchPlan(await getServices(), id, { launchDate: str(form, 'launch_date'), timezone: str(form, 'timezone') }, { actor: OWNER, expectVersion: versionOf(form) });
    return { to: draftPage(id, 7), ok: 'Launch plan saved' };
  });
}

/** Version history: make an earlier version current again (as a new version). */
export async function restoreVersionAction(form: FormData): Promise<void> {
  const id = draftIdOf(form);
  const back = draftPage(id, Number(str(form, 'back_step')) || undefined);
  await run(back, async () => {
    const v = Number(str(form, 'restore_version'));
    const d = await restoreVersion(await getServices(), id, v, { actor: OWNER, expectVersion: versionOf(form) });
    return { to: draftPage(id, Math.min(7, Math.max(1, d.current_step))), ok: `Version ${v} restored as v${d.version}` };
  });
}

/** An Owner-only launch card: open (or create) its review draft, where the launch is decided. */
export async function openLaunchReview(form: FormData): Promise<void> {
  const personaId = str(form, 'persona_id');
  await run('/approvals', async () => {
    if (!UUID.test(personaId)) throw new Error('unknown persona');
    const d = await ensureReviewDraft(await getServices(), { personaId, actor: OWNER });
    return { to: draftPage(d.id, 7) };
  });
}

export async function swapAlternative(form: FormData): Promise<void> {
  const id = draftIdOf(form);
  await run(draftPage(id, 3), async () => {
    const field = str(form, 'field') as CharacterField;
    if (!CHARACTER_FIELDS.includes(field)) throw new Error('unknown field');
    await pickAlternative(await getServices(), id, field, Number(str(form, 'index')), { actor: OWNER, expectVersion: versionOf(form) });
    return { to: draftPage(id, 3) };
  });
}

export async function mix(form: FormData): Promise<void> {
  const id = draftIdOf(form);
  await run(draftPage(id, 2), async () => {
    const parts: Partial<Record<ConceptPart, string>> = {};
    for (const p of CONCEPT_PARTS) {
      const v = str(form, `part_${p}`);
      if (/^[A-E]$/.test(v)) parts[p] = v;
    }
    const base = str(form, 'base');
    const d = await mixConcepts(await getServices(), id, parts, { actor: OWNER, expectVersion: versionOf(form), ...(/^[A-E]$/.test(base) ? { base } : {}) });
    return { to: draftPage(id, 2), ok: `Mixed: ${d.state.concept.chosen?.name ?? 'concept'}` };
  });
}

export async function archiveDraftAction(form: FormData): Promise<void> {
  const id = draftIdOf(form);
  await run(draftPage(id), async () => {
    await archiveDraft(await getServices(), id, { actor: OWNER });
    return { to: '/archive', ok: 'Draft archived' };
  });
}

export async function restoreDraftAction(form: FormData): Promise<void> {
  const id = draftIdOf(form);
  await run('/archive', async () => {
    const d = await restoreDraft(await getServices(), id, { actor: OWNER });
    return { to: draftPage(id, d.current_step), ok: 'Draft restored' };
  });
}

/** "Approve launch": the Owner's explicit approval (a ticked confirmation and the version the Owner reviewed). */
export async function approveLaunch(form: FormData): Promise<void> {
  const id = draftIdOf(form);
  await run(draftPage(id, 7), async () => {
    if (form.get('confirm') !== 'on') throw new Error('tick the box to confirm you approve this launch');
    const r = await launchDraft(await getServices(), id, { actor: OWNER, expectVersion: versionOf(form) });
    return { to: `/personas/${r.persona.slug}`, ok: `${r.persona.name} launched into setup` };
  });
}

export async function restoreArchived(form: FormData): Promise<void> {
  await run('/archive', async () => {
    const slug = str(form, 'slug');
    const label = str(form, 'label');
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug) || !/^\d{4}-\d{2}-\d{2}$/.test(label)) throw new Error('unknown archived persona');
    const { studio } = await studioContext();
    const [r] = await restoreFromArchive(await getServices(), { studioId: studio.id, slugs: [slug], from: label, actor: OWNER });
    if (!r || r.status === 'skipped') throw new Error(r?.reason ?? 'nothing restored');
    return r.draftId ? { to: draftPage(r.draftId, 7), ok: `${r.name} restored: review and approve the launch` } : { to: '/archive', ok: `${r.name} restored` };
  });
}

export async function archivePersonaAction(form: FormData): Promise<void> {
  const personaId = str(form, 'persona_id');
  const back = str(form, 'back').startsWith('/personas/') ? str(form, 'back') : '/';
  await run(back, async () => {
    if (!UUID.test(personaId)) throw new Error('unknown persona');
    const p = await archiveStudioPersona(await getServices(), { personaId, actor: OWNER, confirmName: str(form, 'confirm') || undefined, reason: str(form, 'reason') || undefined });
    return { to: '/archive', ok: `${p.name} archived (everything kept)` };
  });
}

export async function restorePersonaAction(form: FormData): Promise<void> {
  const personaId = str(form, 'persona_id');
  await run('/archive', async () => {
    if (!UUID.test(personaId)) throw new Error('unknown persona');
    const r = await restoreStudioPersona(await getServices(), { personaId, actor: OWNER });
    const { db } = await studioContext();
    const p = await db.one<{ slug: string; name: string }>('SELECT slug, name FROM persona WHERE id = $1', [personaId]);
    return r.draftId ? { to: draftPage(r.draftId, 7), ok: `${p.name} restored: review and approve the launch` } : { to: `/personas/${p.slug}`, ok: `${p.name} restored (${r.state.toLowerCase()})` };
  });
}
