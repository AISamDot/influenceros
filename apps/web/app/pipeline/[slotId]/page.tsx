/* eslint-disable @next/next/no-img-element */
import { slotDetail } from '@ios/content';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { GateChecks, QcChecks } from '@/components/content-checks';
import { FormatIcon } from '@/components/icons';
import { localTime, PURPOSE_STYLE, VERDICT_STYLE } from '@/components/pipeline-card';
import { SubmitButton } from '@/components/submit-button';
import { FORMAT_LABEL } from '@/lib/format';
import { UUID_RE } from '@/lib/http';
import { studioContext } from '@/lib/server';
import { requireOwnerPage } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Pipeline · post' };

const STAGE_LABEL: Record<string, string> = {
  idea: 'Idea',
  script: 'Script',
  q1: 'QC · Q1',
  gate: 'Gate',
  media_queued: 'Queued for media',
  voice: 'Voice',
  q2: 'QC · Q2',
  render: 'Render',
  q3: 'QC · Q3',
  q4: 'QC · Q4',
  final_gate: 'Final Gate',
  scheduled: 'Scheduled',
  live: 'Live',
  blocked: 'Blocked',
};

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="card p-4 sm:p-5">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="eyebrow">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export default async function SlotPage({ params }: { params: Promise<{ slotId: string }> }) {
  await requireOwnerPage();
  const { slotId } = await params;
  if (!UUID_RE.test(slotId)) notFound();
  const { db, studio } = await studioContext();
  const d = await slotDetail(db, studio.id, slotId);
  if (!d) notFound();
  const { slot, script } = d;
  const purpose = PURPOSE_STYLE[slot.purpose];
  const lastGate = d.gate.at(-1);
  const q1 = d.qc.filter((q) => q.stage === 'Q1');
  const q2 = d.qc.filter((q) => q.stage === 'Q2');

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <img src={slot.thumbnailUrl ?? ''} alt="" className="h-[160px] w-[90px] shrink-0 rounded-xl bg-surface-3 object-cover" />
        <div className="min-w-0 flex-1">
          <Link href={`/pipeline?persona=${slot.personaSlug}`} className="text-[12.5px] text-muted hover:text-fg">
            ← Pipeline · {slot.personaName}
          </Link>
          <h1 className="mt-1 font-[family-name:var(--font-display)] text-[34px] leading-[1.05] tracking-tight">{slot.hook ?? slot.title}</h1>
          {slot.hook ? <p className="mt-1 text-[13px] text-muted">Idea: {slot.title}</p> : null}
          <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[12px]">
            <span className={`pill ${slot.stage === 'blocked' ? 'bg-danger-soft text-danger' : 'bg-accent-soft text-accent'}`}>{STAGE_LABEL[slot.stage ?? ''] ?? slot.status}</span>
            <span className="pill flex items-center gap-1 bg-surface-2 text-muted">
              <FormatIcon format={slot.format} size={12} /> {FORMAT_LABEL[slot.format]}
            </span>
            {purpose ? <span className={`pill ${purpose.cls}`}>{purpose.label}</span> : null}
            {slot.pillar ? <span className="pill bg-surface-2 text-muted">{slot.pillar}</span> : null}
            {slot.ctaKeyword ? <span className="pill bg-surface-2 font-mono text-muted">Comment {slot.ctaKeyword}</span> : null}
            {slot.productName ? <span className="pill bg-warn-soft text-warn">{slot.productName}</span> : null}
            <span className="text-muted">
              {localTime(slot.slotAt, slot.personaTimezone, { date: true })} ({slot.personaTimezone}){slot.window ? ` · ${slot.window}` : ''}
            </span>
          </div>
          {slot.blockReason && slot.stage === 'blocked' ? (
            <p role="alert" className="mt-3 rounded-xl border border-danger/40 bg-danger-soft px-3 py-2 text-[13px] text-danger">
              {slot.blockReason}
            </p>
          ) : null}
          {slot.waiting ? <p className="mt-3 rounded-xl border border-warn/40 bg-warn-soft px-3 py-2 text-[13px] text-warn">{slot.waiting}</p> : null}
          {['idea', 'script', 'q1', 'gate'].includes(slot.stage ?? '') ? (
            <form action="/api/pipeline" method="post" className="mt-3">
              <input type="hidden" name="action" value="run_slot" />
              <input type="hidden" name="slot_id" value={slot.slotId} />
              <SubmitButton className="btn btn-sm">{slot.queued ? 'Queued' : 'Run the pipeline now'}</SubmitButton>
            </form>
          ) : null}
        </div>
      </div>

      {!script ? (
        <p className="rounded-xl border border-dashed border-line-strong p-4 text-center text-[13px] text-muted">No script yet: the Scriptwriter picks this slot up automatically.</p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="min-w-0 space-y-6">
            <Section title={`Script v${script.version} · ${script.status}`} aside={<span className="text-[12px] text-muted">{script.wordCount ?? '–'} words · ~{script.estSeconds ?? '–'} s · {script.fixLoops} fix loop{script.fixLoops === 1 ? '' : 's'}</span>}>
              <p className="whitespace-pre-wrap text-[14px] leading-relaxed">{script.body}</p>
              {script.voiceover && script.voiceover !== script.body ? (
                <div className="mt-3 rounded-lg bg-surface-2 px-3 py-2">
                  <div className="eyebrow">Voice text (TTS-safe)</div>
                  <p className="mt-1 text-[13px] text-muted">{script.voiceover}</p>
                </div>
              ) : null}
            </Section>
            {script.carousel ? (
              <Section title={`Carousel · ${script.carousel.length} slides`}>
                <ol className="grid gap-2 sm:grid-cols-2">
                  {script.carousel.map((c, i) => (
                    <li key={i} className="rounded-lg border border-line px-3 py-2">
                      <div className="text-[11px] text-muted">Slide {i + 1}</div>
                      <div className="text-[13px] font-semibold">{c.title}</div>
                      <p className="text-[12.5px] text-muted">{c.body}</p>
                    </li>
                  ))}
                </ol>
              </Section>
            ) : script.onScreenText.length ? (
              <Section title="On-screen text">
                <ol className="list-decimal space-y-1 pl-5 text-[13px]">
                  {script.onScreenText.map((l, i) => (
                    <li key={i}>{l}</li>
                  ))}
                </ol>
              </Section>
            ) : null}
            <Section title="Caption">
              <p className="whitespace-pre-wrap text-[13.5px]">{script.caption}</p>
              <p className="mt-2 text-[12.5px] text-accent">{script.hashtags.join(' ')}</p>
            </Section>
            <Section title="Visual brief">
              <p className="text-[13px] text-muted">{script.visualBrief}</p>
            </Section>
            <Section title="Claims and evidence">
              {script.claims.length ? (
                <ul className="space-y-1 text-[13px]">
                  {script.claims.map((c, i) => (
                    <li key={i}>
                      “{c.text}” <span className="font-mono text-[11px] text-muted">{c.evidence_id ?? 'uncited'}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[13px] text-muted">No factual claims: opinion and general education.</p>
              )}
            </Section>
          </div>

          <div className="min-w-0 space-y-6">
            <Section title="Hook-lab · 10 hooks, scored">
              <ol className="divide-y divide-line text-[12.5px]">
                {script.lab.map((h, i) => {
                  const shipped = script.shipped?.text === h.text;
                  const variant = script.variants.some((v) => v.text === h.text);
                  return (
                    <li key={i} className={`flex items-start gap-2 py-1.5 ${h.excluded ? 'opacity-60' : ''}`}>
                      <span className="w-8 shrink-0 text-right font-semibold tabular-nums">{h.score}</span>
                      <span className="min-w-0 flex-1">
                        {h.text}
                        <span className="block text-[11px] text-muted">
                          {h.type.replace(/_/g, ' ')}
                          {h.excluded ? ` · excluded: ${h.excluded}` : h.reasons.length ? ` · ${h.reasons.slice(0, 3).join(', ')}` : ''}
                        </span>
                      </span>
                      {shipped ? <span className="pill shrink-0 bg-ink text-on-ink">Shipped</span> : variant ? <span className="pill shrink-0 bg-accent-soft text-accent">A/B</span> : null}
                    </li>
                  );
                })}
              </ol>
            </Section>
            {q1.map((q, i) => (
              <Section
                key={q.id}
                title={`QC · Q1${q1.length > 1 ? ` · pass ${i + 1}` : ''}`}
                aside={<span className={`pill ${q.pass ? 'bg-ok-soft text-ok' : 'bg-danger-soft text-danger'}`}>{q.pass ? 'Pass' : 'Fail'} · {q.score ?? '–'}</span>}
              >
                <QcChecks checks={q.checks} />
              </Section>
            ))}
            {q2.map((q) => (
              <Section key={q.id} title="QC · Q2 voice" aside={<span className={`pill ${q.pass ? 'bg-ok-soft text-ok' : 'bg-danger-soft text-danger'}`}>{q.pass ? 'Pass' : 'Fail'} · {q.score ?? '–'}</span>}>
                <QcChecks checks={q.checks} />
              </Section>
            ))}
            {lastGate ? (
              <Section title="Compliance Gate · pre-render" aside={<span className={`pill ${VERDICT_STYLE[lastGate.verdict]}`}>{lastGate.verdict}</span>}>
                <GateChecks checks={lastGate.checks} />
              </Section>
            ) : null}
            {d.media ? (
              <Section title="Queued for media" aside={<span className="pill bg-surface-2 text-muted">{d.media.status}</span>}>
                <p className="text-[12.5px] text-muted">
                  A <span className="font-mono">media.render</span> job carries the TTS-safe voice text, on-screen text, caption, keyword, hashtags, visual brief and evidence to the
                  video producer (IOS-3).
                </p>
              </Section>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
