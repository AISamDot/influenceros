'use server';

import { OWNER } from '@troupe/core';
import { getDraft, setDraftExtension } from '@troupe/generator';
import { asBible, asStoryline, mergeBible, pickPins, searchInspiration, type WorldBible } from '@troupe/world';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { authOff, currentSession } from '@/lib/auth';
import { getServices } from '@/lib/services';
import { studioContext } from '@/lib/server';

/**
 * Persona Generator step 6, stream J: edit the drafted World Bible (every edit is a new draft version through
 * `setDraftExtension`), search Pinterest for mood and format inspiration, and pick pins into the draft's mood board.
 * Owner only (session checked here); pins are never a face or identity reference.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (f: FormData, k: string, max = 600) => String(f.get(k) ?? '').trim().slice(0, max);
const page = (id: string) => `/generator/${id}?step=6`;

async function run(form: FormData, fn: (draftId: string, studioId: string) => Promise<string>): Promise<never> {
  if (!authOff() && !(await currentSession())) redirect('/login');
  const id = str(form, 'draft_id');
  if (!UUID.test(id)) redirect('/generator?error=unknown%20draft');
  let target: string;
  try {
    const { db, studio } = await studioContext();
    const d = await getDraft(db, id);
    if (!d || d.studio_id !== studio.id) throw new Error('unknown draft');
    const ok = await fn(id, studio.id);
    target = `${page(id)}&ok=${encodeURIComponent(ok)}#world`;
  } catch (err) {
    target = `${page(id)}&error=${encodeURIComponent(err instanceof Error ? err.message : String(err))}#world`;
  }
  revalidatePath('/', 'layout');
  redirect(target);
}

const versionOf = (f: FormData) => {
  const v = Number(str(f, 'version'));
  return Number.isInteger(v) && v > 0 ? v : undefined;
};

/** Edits the drafted world: neighbourhood, home layout, a new cast member, a local event, the season-1 title. */
export async function editDraftWorldAction(form: FormData): Promise<void> {
  await run(form, async (draftId) => {
    const services = await getServices();
    const d = await getDraft(services.db, draftId);
    const world = d?.state.world;
    const bible = world ? asBible(world.bible) : null;
    if (!world || !bible) throw new Error('no World Bible drafted yet: draft step 6 first');
    const patch: Record<string, unknown> = {};
    const neighbourhood = str(form, 'neighbourhood', 120);
    if (neighbourhood) patch.place = { neighbourhood };
    const layout = str(form, 'layout', 600);
    if (layout) patch.home = { layout };
    const castName = str(form, 'cast_name', 40);
    if (castName) {
      if (!/^[A-Z][A-Za-z'-]+(?: [A-Z][A-Za-z'-]+)?$/.test(castName)) throw new Error('cast: a capitalised first name (fictional people only)');
      patch.cast = [...bible.cast, { name: castName, relation: str(form, 'cast_relation', 40).toLowerCase() || 'friend', age: Number(str(form, 'cast_age', 3)) || null, traits: str(form, 'cast_traits', 200), role: '' }];
    }
    const event = str(form, 'event_name', 80);
    const [mm, dd] = str(form, 'event_date', 10).split('-').slice(-2).map(Number);
    if (event && mm && dd) patch.localEvents = [...bible.localEvents, { name: event, month: mm, day: dd }];
    const story = asStoryline(world.storyline);
    const title = str(form, 'arc_title', 120);
    if (!Object.keys(patch).length && !title) throw new Error('nothing to change');
    const next: WorldBible = mergeBible(bible, patch);
    await setDraftExtension(
      services,
      draftId,
      'world',
      {
        ...world,
        bible: { ...(next as unknown as Record<string, unknown>), sourceDraftId: draftId },
        storyline: story && title ? ({ ...story, title } as unknown as Record<string, unknown>) : world.storyline,
      },
      { actor: OWNER, expectVersion: versionOf(form), change: `world bible: edited ${[...Object.keys(patch), ...(title ? ['storyline title'] : [])].join(', ')}` },
    );
    return 'World Bible updated';
  });
}

export async function searchPinsAction(form: FormData): Promise<void> {
  await run(form, async (draftId, studioId) => {
    const r = await searchInspiration(await getServices(), { studioId, draftId, query: str(form, 'query', 100), limit: 12, agent: 'owner' });
    return `${r.pins.length} pins found (${r.source === 'apify' ? 'Apify scraper' : 'Pinterest API'})`;
  });
}

export async function pickPinsAction(form: FormData): Promise<void> {
  await run(form, async (draftId, studioId) => {
    const ids = form.getAll('pin').map(String).filter((x) => UUID.test(x)).slice(0, 30);
    const unpick = str(form, 'mode') === 'unpick';
    if (!ids.length) throw new Error('tick at least one pin');
    const r = await pickPins(await getServices(), { studioId, draftId, pinRowIds: ids, picked: !unpick });
    return `${r.picked} pins ${unpick ? 'removed from' : 'added to'} the mood board`;
  });
}
