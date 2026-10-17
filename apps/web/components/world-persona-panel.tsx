import type { Db } from '@troupe/db';
import { computeGrounding, ledgerOf, loadWorld, moodBoard, storylineView } from '@troupe/world';
import { addCastMemberAction, addLocalEventAction, backfillWorldAction, steerStorylineAction } from '@/app/world/actions';
import { SubmitButton } from './submit-button';

const STATUS_TONE: Record<string, string> = { planned: 'bg-surface-3 text-muted', assigned: 'bg-warn-soft text-warn', used: 'bg-ok-soft text-ok', dropped: 'bg-surface-3 text-muted line-through' };

/**
 * Persona page panel for stream J (docs/IOS-5-CONTRACTS.md §4): the World Bible (place, home, recurring places and
 * cast, seasons, holidays; editable), today's grounding, the storyline arc with chapters and beats (steerable),
 * recent continuity facts and no-repeat blocks, and the mood board. A failure here never takes the page down.
 */
export async function WorldPersonaPanel({ db, personaId, slug: _slug }: { db: Db; studioId: string; personaId: string; slug: string }) {
  try {
    const world = await loadWorld(db, personaId);
    if (!world) {
      return (
        <section id="world" className="card p-4 text-[13px]" aria-label="World">
          <div className="eyebrow">World Bible · storyline</div>
          <p className="mt-1 text-muted">No World Bible yet (launched before TH-5 or restored). Draft one so scripts are grounded and the storyline runs.</p>
          <form action={backfillWorldAction} className="mt-2">
            <input type="hidden" name="persona_id" value={personaId} />
            <SubmitButton className="btn btn-sm btn-ink">Draft the World Bible</SubmitButton>
          </form>
        </section>
      );
    }
    const now = new Date();
    const cached = await db.maybeOne<{ fetched_at: Date; data: Record<string, unknown> }>('SELECT fetched_at, data FROM world_weather WHERE persona_id = $1', [personaId]);
    const fresh = cached && now.getTime() - new Date(cached.fetched_at).getTime() < 2 * 3_600_000 ? (cached.data as never) : null;
    const g = computeGrounding(personaId, world.bible, now, fresh);
    const [story, facts, blocks, board] = await Promise.all([
      storylineView(db, personaId, now),
      ledgerOf(db, personaId),
      db.query<{ check_name: string; reason: string; created_at: Date }>(`SELECT check_name, reason, created_at FROM concept_block WHERE persona_id = $1 ORDER BY created_at DESC LIMIT 5`, [personaId]),
      moodBoard(db, { personaId }),
    ]);
    const b = world.bible;
    const week = story?.arc.currentWeek ?? null;
    return (
      <section id="world" className="card space-y-4 p-4 text-[13px]" aria-label="World">
        <div>
          <div className="eyebrow">World Bible v{world.row.version} · storyline · continuity</div>
          <p className="mt-1">{world.row.summary}</p>
        </div>
        <div className="rounded-lg bg-surface-2 p-3">
          <div className="text-[12px] font-medium text-muted">Right now in {g.place.city}</div>
          <p>{g.block}</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <div className="text-[12px] font-medium text-muted">Cast</div>
            <ul className="list-disc pl-4">
              {b.cast.map((c) => (
                <li key={`${c.name}-${c.relation}`}>
                  <b>{c.name}</b>, {c.relation}
                  {c.age ? ` (${c.age})` : ''}
                  {c.role ? <span className="text-muted">: {c.role}</span> : null}
                </li>
              ))}
            </ul>
            <details className="mt-2">
              <summary className="btn btn-sm cursor-pointer list-none [&::-webkit-details-marker]:hidden">Add to the cast…</summary>
              <form action={addCastMemberAction} className="mt-2 grid gap-2">
                <input type="hidden" name="persona_id" value={personaId} />
                <input name="name" required className="input" placeholder="First name (fictional)" maxLength={40} />
                <input name="relation" required className="input" placeholder="Relation (sister, neighbour, dog…)" maxLength={40} />
                <input name="age" className="input" placeholder="Age" inputMode="numeric" maxLength={3} />
                <input name="role" className="input" placeholder="How they show up" maxLength={200} />
                <SubmitButton className="btn btn-sm btn-ink">Add</SubmitButton>
              </form>
            </details>
          </div>
          <div>
            <div className="text-[12px] font-medium text-muted">Home and places</div>
            <p>
              {b.home.dwelling}, {b.place.neighbourhood}
            </p>
            <ul className="list-disc pl-4 text-muted">
              {b.recurringPlaces.slice(0, 6).map((p) => (
                <li key={p.name}>{p.name}</li>
              ))}
            </ul>
            <div className="mt-2 text-[12px] font-medium text-muted">Local events</div>
            <p className="text-muted">{b.localEvents.length ? b.localEvents.map((e) => `${e.name} (${e.day}/${e.month})`).join(' · ') : 'none yet'}</p>
            <form action={addLocalEventAction} className="mt-1 flex gap-2">
              <input type="hidden" name="persona_id" value={personaId} />
              <input name="name" required className="input flex-1" placeholder="e.g. the town gala" maxLength={80} />
              <input name="date" type="date" required className="input w-36" />
              <SubmitButton className="btn btn-sm">Add</SubmitButton>
            </form>
          </div>
        </div>
        {story ? (
          <div className="space-y-2">
            <div className="text-[12px] font-medium text-muted">
              Season {story.arc.season}: {story.arc.title} {week ? `· week ${week} of ${story.arc.weeks}` : '· starts with the next planned week'}
            </div>
            <ol className="space-y-2">
              {story.chapters.map((c) => (
                <li key={c.id}>
                  <b>
                    Weeks {c.weeks[0]}–{c.weeks[1]}: {c.title}
                  </b>{' '}
                  <span className="text-muted">
                    {c.tension} → {c.payoff}
                  </span>
                  <ul className="mt-1 space-y-0.5 pl-3">
                    {c.beats.map((x) => (
                      <li key={x.id} className="flex items-start gap-2">
                        <span className={`pill shrink-0 ${STATUS_TONE[x.status] ?? ''}`}>w{x.week}</span>
                        <span className={x.status === 'dropped' ? 'text-muted line-through' : ''}>{x.text}</span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
            <form action={steerStorylineAction} className="flex gap-2">
              <input type="hidden" name="persona_id" value={personaId} />
              <input name="instruction" required minLength={4} maxLength={600} className="input flex-1" placeholder="Steer the storyline, e.g. her sister visits unannounced next week" />
              <SubmitButton className="btn btn-sm btn-ink">Steer</SubmitButton>
            </form>
          </div>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <div className="text-[12px] font-medium text-muted">Continuity ledger ({facts.length} facts)</div>
            <ul className="list-disc pl-4">
              {facts.slice(-8).map((f) => (
                <li key={f.id}>
                  {f.kind}: {f.subject} = {f.value} <span className="text-muted">({f.sourceType})</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="text-[12px] font-medium text-muted">Recent blocks (continuity, no-repeat)</div>
            {blocks.length ? (
              <ul className="list-disc pl-4">
                {blocks.map((x, i) => (
                  <li key={i}>{x.reason}</li>
                ))}
              </ul>
            ) : (
              <p className="text-muted">None.</p>
            )}
            {board.descriptors.length ? (
              <>
                <div className="mt-2 text-[12px] font-medium text-muted">Mood board</div>
                <p className="text-muted">{board.descriptors.join(' · ')}</p>
              </>
            ) : null}
          </div>
        </div>
      </section>
    );
  } catch {
    return null;
  }
}
