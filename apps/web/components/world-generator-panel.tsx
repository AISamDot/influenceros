import { getDb } from '@troupe/db';
import type { DraftRow } from '@troupe/generator';
import { asBible, asStoryline, listPins, moodBoard } from '@troupe/world';
import { editDraftWorldAction, pickPinsAction, searchPinsAction } from '@/app/generator/world-actions';
import { SubmitButton } from './submit-button';

/**
 * Persona Generator step 6, stream J (docs/IOS-5-CONTRACTS.md §4, §5.5): the drafted World Bible and ~12-week
 * storyline (editable; each edit is a new draft version), plus the Pinterest mood board: mood and format only,
 * never a face reference. A failure here returns null and never takes the step down.
 */
export async function WorldGeneratorPanel({ draft, studioId }: { draft: DraftRow; studioId: string }) {
  try {
    const world = draft.state.world;
    const bible = world ? asBible(world.bible) : null;
    const story = world ? asStoryline(world.storyline) : null;
    const db = await getDb();
    const [board, candidates] = await Promise.all([moodBoard(db, { draftId: draft.id }), listPins(db, { studioId, draftId: draft.id }, { picked: false })]);
    const editable = draft.status === 'active';
    const tiles = [
      ...board.pins.map((p) => ({ key: `p-${p.id}`, rowId: null as string | null, title: p.title, img: p.imageUrl, picked: true })),
      ...candidates.slice(0, 18).map((p) => ({ key: p.id, rowId: p.id as string | null, title: p.title, img: p.image_url, picked: false })),
    ];
    return (
      <section id="world" className="card space-y-4 p-4 text-[13px]" aria-label="World Bible">
        <div>
          <div className="eyebrow">World Bible + storyline · Studio Manager</div>
          {world && bible ? <p className="mt-1">{world.summary}</p> : <p className="mt-1 text-muted">Drafted with the content step: pick or regenerate step 6 to write it.</p>}
        </div>
        {bible ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <div className="text-[12px] font-medium text-muted">Place</div>
              <p>
                {bible.home.dwelling} · {bible.place.neighbourhood}, {bible.place.city}
                {bible.place.region ? `, ${bible.place.region}` : ''} ({bible.place.timezone}){bible.self.era ? ` · ${bible.self.era}` : ''}
              </p>
              <div className="mt-2 text-[12px] font-medium text-muted">Cast</div>
              <ul className="list-disc pl-4">
                {bible.cast.map((c) => (
                  <li key={`${c.name}-${c.relation}`}>
                    <b>{c.name}</b>, {c.relation}
                    {c.age ? ` (${c.age})` : ''}: {c.traits}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="text-[12px] font-medium text-muted">Recurring places</div>
              <ul className="list-disc pl-4">
                {bible.recurringPlaces.map((p) => (
                  <li key={p.name}>
                    {p.name}: <span className="text-muted">{p.description}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-2 text-[12px] font-medium text-muted">Seasons</div>
              <p className="text-muted">{bible.seasons.winter}</p>
              <div className="mt-2 text-[12px] font-medium text-muted">Local holidays</div>
              <p className="text-muted">{bible.holidays.slice(0, 12).join(' · ')}</p>
            </div>
          </div>
        ) : null}
        {story ? (
          <div>
            <div className="text-[12px] font-medium text-muted">
              {story.title} · {story.weeks} weeks
            </div>
            <ol className="mt-1 space-y-1">
              {story.chapters.map((c) => (
                <li key={c.id}>
                  <b>
                    Weeks {c.weeks[0]}–{c.weeks[1]}: {c.title}
                  </b>{' '}
                  <span className="text-muted">
                    {c.tension} → {c.payoff}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
        {bible && editable ? (
          <details>
            <summary className="btn btn-sm cursor-pointer list-none [&::-webkit-details-marker]:hidden">Edit the world…</summary>
            <form action={editDraftWorldAction} className="mt-3 grid gap-2 sm:grid-cols-2">
              <input type="hidden" name="draft_id" value={draft.id} />
              <input type="hidden" name="version" value={draft.version} />
              <input name="neighbourhood" className="input" placeholder="Neighbourhood" maxLength={120} />
              <input name="arc_title" className="input" placeholder="Season 1 title" maxLength={120} />
              <textarea name="layout" className="input sm:col-span-2" rows={2} placeholder="Home layout" maxLength={600} />
              <input name="cast_name" className="input" placeholder="New cast member's first name" maxLength={40} />
              <input name="cast_relation" className="input" placeholder="Relation (sister, neighbour, dog…)" maxLength={40} />
              <input name="cast_age" className="input" placeholder="Age" inputMode="numeric" maxLength={3} />
              <input name="cast_traits" className="input" placeholder="Traits" maxLength={200} />
              <input name="event_name" className="input" placeholder="Local event (e.g. the town gala)" maxLength={80} />
              <input name="event_date" type="date" className="input" />
              <SubmitButton className="btn btn-sm btn-ink sm:col-span-2">Save (new draft version)</SubmitButton>
            </form>
          </details>
        ) : null}
        <div className="space-y-2 border-t border-line pt-3">
          <div className="eyebrow">Mood board · Pinterest (mood and format only, never a face)</div>
          {board.descriptors.length ? <p>{board.descriptors.join(' · ')}</p> : <p className="text-muted">No pins picked yet.</p>}
          {editable ? (
            <form action={searchPinsAction} className="flex gap-2">
              <input type="hidden" name="draft_id" value={draft.id} />
              <input name="query" required minLength={2} maxLength={100} className="input flex-1" placeholder="e.g. cosy cottage kitchen, sage cardigan" />
              <SubmitButton className="btn btn-sm">Search</SubmitButton>
            </form>
          ) : null}
          {tiles.length ? (
            <form action={pickPinsAction} className="space-y-2">
              <input type="hidden" name="draft_id" value={draft.id} />
              <ul className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                {tiles.map((p) => (
                  <li key={p.key} className={`rounded-lg border p-1 ${p.picked ? 'border-line-strong bg-surface-2' : 'border-line'}`}>
                    {p.img ? <img src={p.img} alt="" referrerPolicy="no-referrer" className="aspect-[4/5] w-full rounded object-cover" loading="lazy" /> : null}
                    <label className="mt-1 flex items-start gap-1 text-[11.5px]">
                      {p.rowId ? <input type="checkbox" name="pin" value={p.rowId} /> : <span className="pill bg-surface-3">picked</span>}
                      <span className="line-clamp-2">{p.title}</span>
                    </label>
                  </li>
                ))}
              </ul>
              {candidates.length && editable ? <SubmitButton className="btn btn-sm">Add ticked pins to the mood board</SubmitButton> : null}
            </form>
          ) : null}
        </div>
      </section>
    );
  } catch {
    return null;
  }
}
