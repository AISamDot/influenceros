import { listDrafts, STEPS } from '@ios/generator';
import Link from 'next/link';
import { Flash } from '@/components/flash';
import { SubmitButton } from '@/components/submit-button';
import { requireOwnerPage } from '@/lib/auth';
import { relative } from '@/lib/format';
import { studioContext } from '@/lib/server';
import { startDraft } from './actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Persona Generator' };

export default async function GeneratorHome({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  await requireOwnerPage();
  const sp = await searchParams;
  const { db, studio } = await studioContext();
  const drafts = await listDrafts(db, studio.id);
  const active = drafts.filter((d) => d.status === 'active');
  const launched = drafts.filter((d) => d.status === 'launched');
  const archived = drafts.filter((d) => d.status === 'archived').length;

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <div>
        <div className="eyebrow">You decide · the Studio Manager recommends, scores and drafts</div>
        <h1 className="font-[family-name:var(--font-display)] text-[44px] leading-none tracking-tight sm:text-[52px]">Persona Generator</h1>
        <p className="mt-2 max-w-2xl text-[14px] text-muted">
          Seven steps from an opportunity to a launch: opportunity, concept, character, look, voice, content and money, then review. Pick, edit or mix at every step, or tell the
          Studio Manager what to change in the chat. Nothing launches until you approve it.
        </p>
      </div>
      <Flash error={sp.error} ok={sp.ok} />

      <section className="grid gap-4 md:grid-cols-2">
        <form action={startDraft} className="card flex flex-col gap-3 p-5">
          <div className="eyebrow">Start from the evidence</div>
          <h2 className="text-[20px] font-semibold tracking-tight">Let the Studio Manager recommend</h2>
          <p className="text-[13.5px] text-muted">Ranked niche and angle opportunities with demand, buyer intent, competition, seasonality and the studio&rsquo;s own gaps.</p>
          <div className="flex-1" />
          <SubmitButton className="btn btn-ink self-start">Rank opportunities</SubmitButton>
        </form>
        <form action={startDraft} className="card flex flex-col gap-3 p-5">
          <div className="eyebrow">Start from your idea</div>
          <h2 className="text-[20px] font-semibold tracking-tight">I have an idea</h2>
          <label className="block text-[13px] text-muted">
            A niche, a character, an angle: one or two lines.
            <textarea
              name="idea"
              required
              minLength={8}
              maxLength={600}
              rows={3}
              className="input mt-1.5 h-auto py-2"
              placeholder="A retired air-traffic controller who runs your bedtime like a runway"
            />
          </label>
          <SubmitButton className="btn btn-ink self-start">Score my idea</SubmitButton>
        </form>
      </section>

      <section className="space-y-3">
        <h2 className="eyebrow">In progress · {active.length}</h2>
        {active.length === 0 ? <p className="text-[13px] text-muted">No drafts yet. Start one above.</p> : null}
        <div className="grid gap-3 md:grid-cols-2">
          {active.map((d) => (
            <Link key={d.id} href={`/generator/${d.id}?step=${d.current_step}`} className="card block p-4 transition hover:shadow-lift">
              <div className="flex items-center justify-between gap-2">
                <span className="pill bg-accent-soft text-accent">
                  Step {d.current_step} · {STEPS[d.current_step - 1]?.title}
                </span>
                {d.scores.total ? <span className="text-[13px] font-semibold tabular-nums">{d.scores.total}/100</span> : null}
              </div>
              <h3 className="mt-2 truncate font-[family-name:var(--font-display)] text-[26px] leading-tight">{d.title}</h3>
              <p className="mt-0.5 text-[12.5px] text-muted">
                {d.source === 'archive' ? 'Restored from the archive · ' : d.source === 'owner_idea' ? 'Your idea · ' : ''}
                v{d.version} · updated {relative(new Date(d.updated_at))}
              </p>
              <div className="mt-3 flex gap-1" aria-hidden>
                {STEPS.map((s) => (
                  <span key={s.n} className={`h-1.5 flex-1 rounded-full ${s.n < d.current_step ? 'bg-ink' : s.n === d.current_step ? 'bg-accent' : 'bg-surface-3'}`} />
                ))}
              </div>
            </Link>
          ))}
        </div>
      </section>

      {launched.length ? (
        <section className="space-y-2">
          <h2 className="eyebrow">Launched · {launched.length}</h2>
          <div className="card divide-y divide-line">
            {launched.map((d) => (
              <Link key={d.id} href={`/generator/${d.id}?step=7`} className="flex items-center gap-3 px-4 py-2.5 text-[13px] hover:bg-surface-2">
                <span className="pill bg-ok-soft text-ok">launched</span>
                <span className="min-w-0 flex-1 truncate font-medium">{d.title}</span>
                <span className="text-muted">{d.launched_at ? relative(new Date(d.launched_at)) : ''}</span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}
      <p className="text-[12.5px] text-muted">
        {archived ? `${archived} archived draft${archived === 1 ? '' : 's'} and the` : 'The'} archived launch five are on the <Link href="/archive" className="font-medium text-accent hover:underline">Archive</Link> page.
      </p>
    </div>
  );
}
