'use server';

import { OWNER } from '@troupe/core';
import { backfillWorld, steerStoryline, updateBible, loadWorld } from '@troupe/world';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { authOff, currentSession } from '@/lib/auth';
import { getServices } from '@/lib/services';
import { studioContext } from '@/lib/server';

/**
 * Persona-page World Bible and storyline actions (stream J). Every one is the Owner's (session checked here), runs
 * as OWNER, and returns to the persona page with ?ok= or ?error=.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (f: FormData, k: string, max = 600) => String(f.get(k) ?? '').trim().slice(0, max);

async function persona(f: FormData): Promise<{ id: string; slug: string }> {
  const id = str(f, 'persona_id');
  if (!UUID.test(id)) throw new Error('unknown persona');
  const { db, studio } = await studioContext();
  const p = await db.maybeOne<{ id: string; slug: string }>('SELECT id, slug FROM persona WHERE id = $1 AND studio_id = $2', [id, studio.id]);
  if (!p) throw new Error('unknown persona');
  return p;
}

async function run(form: FormData, fn: (p: { id: string; slug: string }) => Promise<string>): Promise<never> {
  if (!authOff() && !(await currentSession())) redirect('/login');
  let target = '/personas';
  try {
    const p = await persona(form);
    target = `/personas/${p.slug}`;
    const ok = await fn(p);
    target = `${target}?ok=${encodeURIComponent(ok)}#world`;
  } catch (err) {
    target = `${target}?error=${encodeURIComponent(err instanceof Error ? err.message : String(err))}#world`;
  }
  revalidatePath('/', 'layout');
  redirect(target);
}

export async function steerStorylineAction(form: FormData): Promise<void> {
  await run(form, async (p) => {
    const instruction = str(form, 'instruction');
    const r = await steerStoryline(await getServices(), { personaId: p.id, instruction, actor: OWNER });
    return `Storyline steered: ${r.added} added, ${r.rewritten} rewritten, ${r.dropped} dropped`;
  });
}

export async function addCastMemberAction(form: FormData): Promise<void> {
  await run(form, async (p) => {
    const { db } = await studioContext();
    const w = await loadWorld(db, p.id);
    if (!w) throw new Error('no World Bible yet');
    const name = str(form, 'name', 40);
    const relation = str(form, 'relation', 40).toLowerCase();
    if (!/^[A-Z][A-Za-z'-]+(?: [A-Z][A-Za-z'-]+)?$/.test(name)) throw new Error('a first name, capitalised (fictional people only)');
    if (!relation) throw new Error('say who they are (sister, neighbour, dog…)');
    const age = Number(str(form, 'age', 3));
    const cast = [...w.bible.cast, { name, relation, age: Number.isFinite(age) && age > 0 ? age : null, traits: str(form, 'traits', 200), role: str(form, 'role', 200) }];
    await updateBible(db, { personaId: p.id, patch: { cast }, actor: OWNER, change: `cast: added ${name} (${relation})` });
    return `${name} joined the cast`;
  });
}

export async function addLocalEventAction(form: FormData): Promise<void> {
  await run(form, async (p) => {
    const { db } = await studioContext();
    const w = await loadWorld(db, p.id);
    if (!w) throw new Error('no World Bible yet');
    const name = str(form, 'name', 80);
    const [mm, dd] = str(form, 'date', 10).split('-').slice(-2).map(Number);
    if (!name || !mm || !dd) throw new Error('an event name and a date');
    await updateBible(db, { personaId: p.id, patch: { localEvents: [...w.bible.localEvents, { name, month: mm, day: dd }] }, actor: OWNER, change: `local event: ${name}` });
    return `${name} added to the local calendar`;
  });
}

export async function backfillWorldAction(form: FormData): Promise<void> {
  await run(form, async (p) => {
    const r = await backfillWorld(await getServices(), { personaId: p.id, actor: OWNER });
    return r.created ? 'World Bible and storyline drafted' : 'This persona already has a World Bible';
  });
}
