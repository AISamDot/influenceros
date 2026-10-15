/* eslint-disable @next/next/no-img-element */
import type { Db } from '@ios/db';
import { personaMedia } from '@ios/media';
import Link from 'next/link';

const SOUL: Record<string, string> = { ready: 'Soul ID ready', failed: 'Soul ID failed', none: 'Soul ID not trained yet' };

/**
 * Persona page panel for stream E (docs/IOS-34-CONTRACTS.md §4): Soul ID and face reference, voice, colour grade,
 * look pack and the latest renders with their cost. A failure here never takes the persona page down.
 */
export async function MediaPersonaPanel({ db, personaId }: { db: Db; studioId: string; personaId: string; slug: string }) {
  try {
    const m = await personaMedia(db, personaId);
    const g = m.grade;
    return (
      <section className="card p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-[family-name:var(--font-display)] text-[26px] leading-none">Media</h2>
          <span className="text-[12px] tabular-nums text-muted">
            This month: {Math.round(m.monthCredits)} Higgsfield credits · ${m.monthUsd.toFixed(2)}
          </span>
        </div>
        <div className="mt-4 flex flex-wrap items-start gap-4">
          {m.referenceUrl ? <img src={m.referenceUrl} alt="Face reference" className="h-[110px] w-[62px] rounded-lg bg-surface-3 object-cover" /> : null}
          <dl className="grid min-w-0 flex-1 grid-cols-[110px_1fr] gap-x-3 gap-y-1 text-[12.5px]">
            <dt className="text-muted">Character</dt>
            <dd className={m.soulStatus === 'ready' ? '' : 'text-warn'}>{SOUL[m.soulStatus] ?? m.soulStatus}</dd>
            <dt className="text-muted">Voice</dt>
            <dd>{m.voiceId ? `${m.voiceProvider ?? 'voice'} · designed` : <span className="text-warn">designed on the first spoken post</span>}</dd>
            <dt className="text-muted">Colour grade</dt>
            <dd className="flex items-center gap-1.5">
              {g ? (
                <>
                  <span className="inline-block size-3 rounded-full border border-line" style={{ background: g.accent }} />
                  contrast {g.contrast.toFixed(2)} · saturation {g.saturation.toFixed(2)}
                </>
              ) : (
                <span className="text-muted">from the bible palette, set on first render</span>
              )}
            </dd>
            <dt className="text-muted">AI disclosure</dt>
            <dd>Platform AI flag on every post</dd>
          </dl>
        </div>
        {m.looks.length ? (
          <div className="mt-4">
            <div className="eyebrow mb-1">Look pack</div>
            <div className="scroll-x flex gap-1.5">
              {m.looks.map((l) => (
                <img key={l.url} src={l.url} alt={l.label} title={l.label} className="h-[96px] w-[54px] shrink-0 rounded-md bg-surface-3 object-cover" />
              ))}
            </div>
          </div>
        ) : null}
        {m.renders.length ? (
          <div className="mt-4">
            <div className="eyebrow mb-1">Latest renders</div>
            <ul className="divide-y divide-line text-[12.5px]">
              {m.renders.map((r) => (
                <li key={r.slotId} className="flex items-center gap-2 py-1.5">
                  {r.coverUrl ? <img src={r.coverUrl} alt="" className="h-[40px] w-[23px] shrink-0 rounded bg-surface-3 object-cover" /> : <span className="h-[40px] w-[23px] shrink-0 rounded bg-surface-3" />}
                  <Link href={`/pipeline/${r.slotId}`} className="min-w-0 flex-1 truncate hover:underline">
                    {r.title}
                  </Link>
                  <span className="shrink-0 text-muted">{r.format.replace('_', ' ')}</span>
                  <span className={`shrink-0 ${r.step === 'blocked' ? 'text-danger' : r.step === 'done' ? 'text-ok' : 'text-muted'}`}>{r.step}</span>
                  <span className="w-14 shrink-0 text-right tabular-nums text-muted">{Math.round(r.credits)} cr</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>
    );
  } catch {
    return null;
  }
}
