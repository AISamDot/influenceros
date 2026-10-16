/* eslint-disable @next/next/no-img-element */
import {
  CHARACTER_FIELDS,
  type CharacterField,
  CONCEPT_PARTS,
  type ConceptOption,
  type DraftRow,
  draftVersions,
  getDraft,
  listDraftMessages,
  type OpportunityOption,
  type Scorecard,
  SCORECARD_WEIGHTS,
  isRestoredDraft,
  STEPS,
  type StepState,
} from '@ios/generator';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { ChatPanel } from '@/components/chat-panel';
import { Flash } from '@/components/flash';
import { FormatsGeneratorPanel } from '@/components/formats-generator-panel';
import { IconCheck, IconFlag } from '@/components/icons';
import { RadarGeneratorPanel } from '@/components/radar-generator-panel';
import { SubmitButton } from '@/components/submit-button';
import { WorldGeneratorPanel } from '@/components/world-generator-panel';
import { requireOwnerPage } from '@/lib/auth';
import { relative, usd } from '@/lib/format';
import { getServices } from '@/lib/services';
import { studioContext, toChatMsg } from '@/lib/server';
import { addIdea, approveLaunch, archiveDraftAction, editStep, keepAsIs, mix, pickOption, regenerate, restoreDraftAction, restoreVersionAction, setLaunch, swapAlternative } from '../actions';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ draftId: string }>; searchParams: Promise<{ step?: string; error?: string; ok?: string }> };

export async function generateMetadata({ params }: Props) {
  const { draftId } = await params;
  const { db } = await studioContext();
  const d = await getDraft(db, draftId);
  return { title: d ? `${d.title} · Generator` : 'Generator' };
}

const DIM_LABEL: Record<keyof typeof SCORECARD_WEIGHTS, string> = {
  captivation: 'Captivation',
  demand: 'Demand and intent',
  ladder: 'Ladder fit',
  gap: 'Gap',
  producibility: 'Producibility',
  lineSafety: 'Line safety',
};

function Hidden({ d, step }: { d: DraftRow; step: number }) {
  return (
    <>
      <input type="hidden" name="draft_id" value={d.id} />
      <input type="hidden" name="step" value={step} />
      <input type="hidden" name="version" value={d.version} />
    </>
  );
}

/** Whether the Owner can change this draft here (an active draft that wasn't restored exactly from the archive). */
const editable = (d: DraftRow) => d.status === 'active' && !isRestoredDraft(d);

function PickButton({ d, step, option, label, primary = true }: { d: DraftRow; step: number; option: string; label: string; primary?: boolean }) {
  if (!editable(d)) return null;
  return (
    <form action={pickOption}>
      <Hidden d={d} step={step} />
      <input type="hidden" name="option" value={option} />
      <SubmitButton className={`btn btn-sm ${primary ? 'btn-ink' : ''}`}>{label}</SubmitButton>
    </form>
  );
}

const STEER_HINT: Record<number, string> = {
  1: 'e.g. a younger audience, less crowded',
  2: 'e.g. younger, funnier, a man',
  3: 'e.g. warmer, a sharper lore',
  4: 'e.g. make her wardrobe all red',
  5: 'e.g. a deeper, gravelly voice',
  6: 'e.g. more myth-busting hooks',
};

function Regenerate({ d, step, label = 'New options' }: { d: DraftRow; step: number; label?: string }) {
  // The review is computed, not drafted: it has nothing to steer, and a restored draft only recomputes it.
  if (step === 7 ? d.status !== 'active' : !editable(d)) return null;
  return (
    <form action={regenerate} className="flex flex-wrap items-center gap-2">
      <Hidden d={d} step={step} />
      {step !== 7 ? (
        <input name="instruction" maxLength={300} className="input h-9 min-w-0 flex-1 sm:w-72 sm:flex-none" placeholder={`Steer it (optional): ${STEER_HINT[step] ?? ''}`} aria-label="Steer the new options" />
      ) : null}
      <SubmitButton className="btn btn-sm">{label}</SubmitButton>
    </form>
  );
}

function Bar({ value, max, tone = 'bg-ink' }: { value: number; max: number; tone?: string }) {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.max(0, Math.min(100, (value / max) * 100))}%` }} />
    </div>
  );
}

function ScoreGrid({ s, compact = false }: { s: Scorecard; compact?: boolean }) {
  return (
    <div className={`grid gap-x-4 gap-y-2 ${compact ? 'grid-cols-2' : 'sm:grid-cols-2'}`}>
      {(Object.keys(SCORECARD_WEIGHTS) as Array<keyof typeof SCORECARD_WEIGHTS>).map((k) => (
        <div key={k}>
          <div className="flex justify-between text-[12px]">
            <span className="text-muted">{DIM_LABEL[k]}</span>
            <span className="font-medium tabular-nums">
              {s[k]}/{SCORECARD_WEIGHTS[k]}
            </span>
          </div>
          <Bar value={s[k]} max={SCORECARD_WEIGHTS[k]} tone={s[k] / SCORECARD_WEIGHTS[k] < 0.5 ? 'bg-warn' : 'bg-ink'} />
          {!compact && s.notes[k] ? <p className="mt-0.5 text-[11.5px] leading-snug text-muted">{s.notes[k]}</p> : null}
        </div>
      ))}
    </div>
  );
}

function Advice({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <div className="flex gap-2.5 rounded-xl border border-accent/30 bg-accent-soft px-4 py-3 text-[13.5px]">
      <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-accent text-[11px] font-bold text-on-accent">S</span>
      <p>
        <b>Studio Manager:</b> {text}
      </p>
    </div>
  );
}

function Stale({ d, s, step }: { d: DraftRow; s: StepState<unknown, unknown>; step: number }) {
  if (s.status !== 'stale') return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-warn/40 bg-warn-soft px-4 py-2.5 text-[13px] text-warn">
      <p>An earlier step changed after this was drafted. The launch waits until you keep it or draft new options.</p>
      {editable(d) && s.chosen && step >= 3 ? (
        <form action={keepAsIs}>
          <Hidden d={d} step={step} />
          <SubmitButton className="btn btn-sm">Keep as is</SubmitButton>
        </form>
      ) : null}
    </div>
  );
}

const FLAG_LABEL = { V: 'several reputable sources', L: 'credible secondary source', U: 'single or vendor source', S: 'studio data' } as const;

// ───────────────────────────── Steps ─────────────────────────────

function OpportunityStep({ d }: { d: DraftRow }) {
  const s = d.state.opportunity;
  return (
    <div className="space-y-4">
      <Advice text={s.advice ?? null} />
      <div className="grid gap-3">
        {s.options.map((o: OpportunityOption) => {
          const chosen = s.chosen?.id === o.id;
          return (
            <article key={o.id} className={`card p-4 ${chosen ? 'ring-2 ring-accent' : ''}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="grid size-7 place-items-center rounded-full bg-ink text-[13px] font-bold text-on-ink">{o.id}</span>
                    <span className="text-[17px] font-semibold capitalize">{o.niche}</span>
                    <span className="text-[13px] text-muted">{o.subNiche}</span>
                    {o.ownerIdea ? <span className="pill bg-warn-soft text-warn">your idea</span> : null}
                  </div>
                  <p className="mt-1.5 text-[13.5px]">{o.angle}</p>
                  <p className="mt-1 text-[12.5px] text-muted">{o.audience}</p>
                </div>
                <div className="text-right">
                  <div className="text-[26px] font-semibold tabular-nums leading-none">{o.scores.total}</div>
                  <div className="text-[11px] text-muted">of 100</div>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-5">
                {(['demand', 'intent', 'competition', 'seasonality', 'gap'] as const).map((k) => (
                  <div key={k}>
                    <div className="flex justify-between gap-1 text-[11px] text-muted">
                      <span>{k === 'competition' ? 'room' : k === 'seasonality' ? 'season' : k}</span>
                      <span className="tabular-nums">{o.scores[k]}</span>
                    </div>
                    <Bar value={o.scores[k]} max={10} />
                  </div>
                ))}
              </div>
              <ul className="mt-3 space-y-1 text-[12.5px]">
                {o.evidence.map((e, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="pill shrink-0 bg-surface-2 text-[10.5px] text-muted" title={FLAG_LABEL[e.flag]}>
                      {e.signal} · {e.flag}
                    </span>
                    <span>
                      {e.detail}
                      {e.source ? <span className="text-muted"> ({e.source})</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3 text-[12px] text-muted">
                <span>Buying moments: {o.buyingMoments.join(' · ')}</span>
                {chosen ? <span className="pill bg-ok-soft text-ok">picked</span> : <PickButton d={d} step={1} option={o.id} label={`Pick ${o.id}`} />}
              </div>
              {editable(d) ? (
                <details className="mt-2">
                  <summary className="cursor-pointer text-[12.5px] font-semibold">Edit {chosen ? 'the picked angle' : `${o.id}'s angle and pick it`}</summary>
                  <form action={editStep} className="mt-2 grid gap-2 sm:grid-cols-2">
                    <Hidden d={d} step={1} />
                    <input type="hidden" name="f_id" value={o.id} />
                    <Field label="Angle" name="angle" value={(chosen ? s.chosen! : o).angle} wide area />
                    <Field label="Audience" name="audience" value={(chosen ? s.chosen! : o).audience} wide />
                    <Field label="Sub-niche" name="subNiche" value={(chosen ? s.chosen! : o).subNiche} wide />
                    <div className="sm:col-span-2">
                      <SubmitButton className="btn btn-sm btn-ink">Save{chosen ? '' : ` and pick ${o.id}`}</SubmitButton>
                    </div>
                  </form>
                </details>
              ) : null}
            </article>
          );
        })}
      </div>
      {s.chosen && s.chosenFrom === 'owner' ? <PickButton d={d} step={1} option="current" label="Continue to concepts →" /> : null}
      {editable(d) ? (
        <form action={addIdea} className="card flex flex-wrap items-center gap-2 p-4">
          <Hidden d={d} step={1} />
          <label className="min-w-0 flex-1 text-[12.5px] text-muted">
            Add my own idea as an option
            <input name="idea" maxLength={600} required minLength={4} className="input mt-1 text-fg" placeholder="e.g. a retired ferry captain who teaches calm budgeting" />
          </label>
          <SubmitButton className="btn btn-sm self-end">Add my idea</SubmitButton>
        </form>
      ) : null}
      <Regenerate d={d} step={1} />
    </div>
  );
}

function ConceptCard({ d, c, chosen, pickable = true }: { d: DraftRow; c: ConceptOption; chosen: boolean; pickable?: boolean }) {
  return (
    <article className={`card flex flex-col p-4 ${chosen ? 'ring-2 ring-accent' : ''}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="grid size-7 shrink-0 place-items-center rounded-full bg-ink text-[13px] font-bold text-on-ink">{c.id}</span>
            <h3 className="truncate font-[family-name:var(--font-display)] text-[26px] leading-tight">{c.name}</h3>
          </div>
          <p className="mt-0.5 text-[12.5px] font-medium text-muted">{c.archetype}</p>
        </div>
        {c.scorecard ? (
          <div className="text-right">
            <div className="text-[24px] font-semibold tabular-nums leading-none">{c.scorecard.total}</div>
            <div className="text-[10.5px] text-muted">win score</div>
          </div>
        ) : null}
      </div>
      <dl className="mt-3 space-y-2 text-[13px]">
        <div>
          <dt className="eyebrow">Premise</dt>
          <dd>{c.premise}</dd>
        </div>
        <div>
          <dt className="eyebrow">Contrast</dt>
          <dd className="text-muted">{c.contrast}</dd>
        </div>
        <div>
          <dt className="eyebrow">Signature mechanic</dt>
          <dd>{c.mechanic}</dd>
        </div>
        <div>
          <dt className="eyebrow">Hooks</dt>
          <dd>
            <ol className="list-decimal space-y-0.5 pl-5">
              {c.hooks.map((h, i) => (
                <li key={i}>{h}</li>
              ))}
            </ol>
          </dd>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <dt className="eyebrow">First product</dt>
            <dd>
              {c.firstProduct.name} · {usd(c.firstProduct.priceCents)}
            </dd>
          </div>
          <div>
            <dt className="eyebrow">Sign-off</dt>
            <dd>{c.signOff ? <>&ldquo;{c.signOff}&rdquo;</> : <span className="text-muted">none yet</span>}</dd>
          </div>
          <div>
            <dt className="eyebrow">Look</dt>
            <dd className="text-muted">{c.lookLine}</dd>
          </div>
          <div>
            <dt className="eyebrow">Voice</dt>
            <dd className="text-muted">{c.voiceLine}</dd>
          </div>
        </div>
      </dl>
      {c.scorecard ? (
        <div className="mt-3 border-t border-line pt-3">
          <ScoreGrid s={c.scorecard} compact />
        </div>
      ) : null}
      <div className="flex-1" />
      {pickable ? <div className="mt-3 flex justify-end">{chosen ? <span className="pill bg-ok-soft text-ok">picked</span> : <PickButton d={d} step={2} option={c.id} label={`Pick ${c.id}`} />}</div> : null}
    </article>
  );
}

function ConceptStep({ d }: { d: DraftRow }) {
  const s = d.state.concept;
  const chosen = s.chosen;
  const custom = chosen && (s.chosenFrom === 'M' || s.chosenFrom === 'owner');
  const ids = s.options.map((o) => o.id);
  return (
    <div className="space-y-4">
      <Advice text={s.advice ?? null} />
      <Stale d={d} s={s} step={2} />
      <div className="grid gap-3 lg:grid-cols-3">
        {s.options.map((c) => (
          <ConceptCard key={c.id} d={d} c={c} chosen={!custom && s.chosenFrom === c.id} />
        ))}
      </div>
      {custom && chosen ? (
        <div className="space-y-2">
          <div className="eyebrow">Your {s.chosenFrom === 'M' ? 'mix' : 'edit'}</div>
          <ConceptCard d={d} c={chosen} chosen pickable={false} />
        </div>
      ) : null}
      {editable(d) && ids.length ? (
        <details className="card p-4">
          <summary className="cursor-pointer text-[14px] font-semibold">Mix concepts</summary>
          <form action={mix} className="mt-3 space-y-3">
            <Hidden d={d} step={2} />
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {CONCEPT_PARTS.map((p) => (
                <label key={p} className="text-[12.5px] text-muted">
                  {p === 'signOff' ? 'sign-off' : p}
                  <select name={`part_${p}`} className="input mt-1 h-9" defaultValue="">
                    <option value="">keep</option>
                    {ids.map((id) => (
                      <option key={id} value={id}>
                        from {id}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <SubmitButton className="btn btn-sm btn-ink">Mix</SubmitButton>
          </form>
        </details>
      ) : null}
      {chosen && editable(d) ? (
        <details className="card p-4">
          <summary className="cursor-pointer text-[14px] font-semibold">Edit the picked concept</summary>
          <form action={editStep} className="mt-3 grid gap-2 sm:grid-cols-2">
            <Hidden d={d} step={2} />
            <Field label="Name" name="name" value={chosen.name} />
            <Field label="Age" name="age" value={String(chosen.age)} />
            <Field label="Archetype" name="archetype" value={chosen.archetype} wide />
            <Field label="Premise" name="premise" value={chosen.premise} wide area />
            <Field label="Contrast" name="contrast" value={chosen.contrast} wide area />
            <Field label="Signature mechanic" name="mechanic" value={chosen.mechanic} wide area />
            <Field label="Hooks (one per line)" name="hooks" value={chosen.hooks.join('\n')} wide area />
            <Field label="Look line" name="lookLine" value={chosen.lookLine} />
            <Field label="Voice line" name="voiceLine" value={chosen.voiceLine} />
            <Field label="Sign-off" name="signOff" value={chosen.signOff} />
            <Field label="First product" name="firstProductName" value={chosen.firstProduct.name} />
            <Field label="First product price ($)" name="firstProductPrice" value={String(chosen.firstProduct.priceCents / 100)} />
            <Field label="First product format" name="firstProductFormat" value={chosen.firstProduct.format} />
            <div className="sm:col-span-2">
              <SubmitButton className="btn btn-sm btn-ink">Save edits</SubmitButton>
            </div>
          </form>
        </details>
      ) : null}
      {chosen && (custom || d.state.character.status === 'empty' || d.state.character.status === 'stale') ? <PickButton d={d} step={2} option="current" label="Continue to character →" /> : null}
      <Regenerate d={d} step={2} label="Three new concepts" />
    </div>
  );
}

function Field({ label, name, value, wide = false, area = false }: { label: string; name: string; value: string; wide?: boolean; area?: boolean }) {
  return (
    <label className={`block text-[12.5px] text-muted ${wide ? 'sm:col-span-2' : ''}`}>
      {label}
      {area ? (
        <textarea name={`f_${name}`} defaultValue={value} rows={3} className="input mt-1 h-auto py-2 text-fg" />
      ) : (
        <input name={`f_${name}`} defaultValue={value} className="input mt-1 text-fg" />
      )}
    </label>
  );
}

const show = (v: unknown): ReactNode => {
  if (Array.isArray(v)) {
    return (
      <ul className="space-y-0.5">
        {v.map((x, i) => (
          <li key={i}>{typeof x === 'object' && x ? `${(x as { debate?: string }).debate}: ${(x as { stance?: string }).stance}` : String(x)}</li>
        ))}
      </ul>
    );
  }
  return String(v ?? '');
};

const FIELD_LABEL: Record<CharacterField, string> = {
  name: 'Name',
  homeBase: 'Home base',
  identity: 'Identity',
  personality: 'Personality',
  worldview: 'Worldview',
  lore: 'Lore',
  positions: 'Positions on debates',
  catchphrases: 'Catchphrases',
};

function CharacterStepView({ d }: { d: DraftRow }) {
  const s = d.state.character;
  const p = s.chosen;
  const alts = s.options[0]?.alternatives ?? {};
  if (!p) return <Regenerate d={d} step={3} label="Draft the character" />;
  return (
    <div className="space-y-4">
      <Advice text={s.advice ?? null} />
      <Stale d={d} s={s} step={3} />
      <div className="card divide-y divide-line">
        <div className="flex flex-wrap items-baseline gap-x-3 px-4 py-3">
          <h3 className="font-[family-name:var(--font-display)] text-[30px] leading-tight">{p.name}</h3>
          <span className="text-[13px] text-muted">
            {p.age} · shown as {p.ageRange} · @{p.handle} · {p.homeBase}
          </span>
        </div>
        {CHARACTER_FIELDS.filter((f) => f !== 'name' && f !== 'homeBase').map((f) => (
          <div key={f} className="grid gap-2 px-4 py-3 sm:grid-cols-[150px_minmax(0,1fr)]">
            <div className="eyebrow pt-0.5">{FIELD_LABEL[f]}</div>
            <div className="min-w-0 space-y-2 text-[13.5px]">
              <div>{show(p[f])}</div>
              {(alts[f] ?? []).length && editable(d) ? (
                <div className="space-y-1.5">
                  {(alts[f] ?? []).map((alt, i) => (
                    <form key={i} action={swapAlternative} className="flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2 text-[12.5px] text-muted">
                      <Hidden d={d} step={3} />
                      <input type="hidden" name="field" value={f} />
                      <input type="hidden" name="index" value={i} />
                      <div className="min-w-0 flex-1">{show(alt)}</div>
                      <SubmitButton className="btn btn-sm shrink-0">Use</SubmitButton>
                    </form>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        ))}
        {(alts.name ?? []).length && editable(d) ? (
          <div className="flex flex-wrap items-center gap-2 px-4 py-3 text-[12.5px]">
            <span className="eyebrow">Other names</span>
            {(alts.name ?? []).map((n, i) => (
              <form key={i} action={swapAlternative}>
                <Hidden d={d} step={3} />
                <input type="hidden" name="field" value="name" />
                <input type="hidden" name="index" value={i} />
                <SubmitButton className="btn btn-sm">{String(n)}</SubmitButton>
              </form>
            ))}
          </div>
        ) : null}
      </div>
      {editable(d) ? (
        <details className="card p-4">
          <summary className="cursor-pointer text-[14px] font-semibold">Edit the character</summary>
          <form action={editStep} className="mt-3 grid gap-2 sm:grid-cols-2">
            <Hidden d={d} step={3} />
            <Field label="Name" name="name" value={p.name} />
            <Field label="Age" name="age" value={String(p.age)} />
            <Field label="Handle" name="handle" value={p.handle} />
            <Field label="Home base" name="homeBase" value={p.homeBase} />
            <Field label="Identity" name="identity" value={p.identity} wide area />
            <Field label="Lore" name="lore" value={p.lore} wide area />
            <Field label="Personality (one trait per line)" name="personality" value={p.personality.join('\n')} area />
            <Field label="Worldview (one principle per line)" name="worldview" value={p.worldview.join('\n')} area />
            <Field label="Positions (one per line: debate: stance)" name="positions" value={p.positions.map((x) => `${x.debate}: ${x.stance}`).join('\n')} wide area />
            <Field label="Catchphrases (one per line)" name="catchphrases" value={p.catchphrases.join('\n')} wide area />
            <div className="sm:col-span-2">
              <SubmitButton className="btn btn-sm btn-ink">Save edits</SubmitButton>
            </div>
          </form>
        </details>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PickButton d={d} step={3} option="A" label="Use this character →" />
        <Regenerate d={d} step={3} label="Redraft" />
      </div>
    </div>
  );
}

function LookStepView({ d }: { d: DraftRow }) {
  const s = d.state.look;
  const look = s.chosen;
  if (!look) return <Regenerate d={d} step={4} label="Draft the look" />;
  return (
    <div className="space-y-4">
      <Advice text={s.advice ?? null} />
      <Stale d={d} s={s} step={4} />
      <div className="card grid gap-4 p-4 sm:grid-cols-2">
        <div className="space-y-3 text-[13px]">
          <div>
            <div className="eyebrow">Anchors</div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {look.profile.anchors.map((a) => (
                <span key={a} className="pill bg-surface-2">
                  {a}
                </span>
              ))}
            </div>
          </div>
          <div>
            <div className="eyebrow">Wardrobe</div>
            <ul className="mt-1 space-y-0.5">{look.profile.wardrobe.map((w) => <li key={w}>{w}</li>)}</ul>
          </div>
          <div>
            <div className="eyebrow">Settings (four or fewer)</div>
            <ul className="mt-1 space-y-0.5">{look.profile.settings.map((w) => <li key={w}>{w}</li>)}</ul>
          </div>
        </div>
        <div className="space-y-3 text-[13px]">
          <div>
            <div className="eyebrow">Palette</div>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {look.profile.palette.map((p) => (
                <span key={p.hex} className="flex items-center gap-1.5 text-[12px]">
                  <span className="size-5 rounded-md border border-line" style={{ background: p.hex }} />
                  {p.name} <span className="text-muted">{p.hex}</span>
                </span>
              ))}
            </div>
          </div>
          <div>
            <div className="eyebrow">Stylisation and framing</div>
            <p className="mt-1 text-muted">{look.profile.stylisation}. {look.profile.framing}.</p>
          </div>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {look.variants.map((v) => {
          const picked = look.chosenVariant === v.id;
          return (
            <figure key={v.id} className={`card overflow-hidden ${picked ? 'ring-2 ring-accent' : ''}`}>
              <img src={v.url} alt={v.label} className="aspect-[4/5] w-full object-cover" />
              <figcaption className="space-y-2 p-3 text-[12.5px]">
                <div className="font-medium">{v.label}</div>
                <div className="text-muted">{v.provider === 'higgsfield' ? 'Higgsfield character sheet' : 'Placeholder (no Higgsfield key)'}</div>
                {picked ? <span className="pill bg-ok-soft text-ok">picked</span> : <PickButton d={d} step={4} option={v.id} label={`Pick sheet ${v.id}`} />}
              </figcaption>
            </figure>
          );
        })}
      </div>
      {look.check ? (
        <div className="card grid gap-3 p-4 text-[13px] sm:grid-cols-2">
          <div>
            <div className="eyebrow">Face drift</div>
            <p className="mt-1">
              <b>{look.check.drift.verdict.replace('_', ' ')}</b>
              {look.check.drift.similarity !== null ? ` (${look.check.drift.similarity.toFixed(2)})` : ''}. {look.check.drift.note}
            </p>
          </div>
          <div>
            <div className="eyebrow">Distinct from the studio</div>
            <p className="mt-1">
              <b>{look.check.distinct.score}/100</b>. {look.check.distinct.note}
            </p>
          </div>
        </div>
      ) : null}
      {editable(d) ? (
        <details className="card p-4">
          <summary className="cursor-pointer text-[14px] font-semibold">Edit the look</summary>
          <form action={editStep} className="mt-3 grid gap-2 sm:grid-cols-2">
            <Hidden d={d} step={4} />
            <Field label="Anchors (one per line)" name="anchors" value={look.profile.anchors.join('\n')} area />
            <Field label="Wardrobe (one per line)" name="wardrobe" value={look.profile.wardrobe.join('\n')} area />
            <Field label="Palette (one per line: Name #RRGGBB)" name="palette" value={look.profile.palette.map((x) => `${x.name} ${x.hex}`).join('\n')} area />
            <Field label="Settings (one per line, four or fewer)" name="settings" value={look.profile.settings.join('\n')} area />
            <div className="sm:col-span-2">
              <SubmitButton className="btn btn-sm btn-ink">Save the look</SubmitButton>
            </div>
          </form>
        </details>
      ) : null}
      <Regenerate d={d} step={4} label="New sheets" />
    </div>
  );
}

function VoiceStepView({ d }: { d: DraftRow }) {
  const s = d.state.voice;
  if (!s.options.length) return <Regenerate d={d} step={5} label="Design three voices" />;
  return (
    <div className="space-y-4">
      <Advice text={s.advice ?? null} />
      <Stale d={d} s={s} step={5} />
      <div className="grid gap-3 md:grid-cols-3">
        {s.options.map((v) => {
          const picked = s.chosen?.id === v.id;
          return (
            <article key={v.id} className={`card flex flex-col gap-2 p-4 ${picked ? 'ring-2 ring-accent' : ''}`}>
              <div className="flex items-center gap-2">
                <span className="grid size-7 place-items-center rounded-full bg-ink text-[13px] font-bold text-on-ink">{v.id}</span>
                <span className="font-semibold">{v.label}</span>
              </div>
              <p className="text-[12.5px] text-muted">{v.description}</p>
              <p className="rounded-lg bg-surface-2 px-3 py-2 text-[12.5px] italic">&ldquo;{v.sampleText}&rdquo;</p>
              {v.fake || !/^https:\/\//.test(v.url) ? (
                <p className="text-[12px] text-warn">Fake preview ({v.provider}): the real voice is designed once ElevenLabs is connected.</p>
              ) : (
                <audio controls preload="none" src={v.url} className="w-full" />
              )}
              <div className="flex-1" />
              {picked ? <span className="pill self-start bg-ok-soft text-ok">picked</span> : <PickButton d={d} step={5} option={v.id} label={`Pick ${v.id}`} />}
            </article>
          );
        })}
      </div>
      <Regenerate d={d} step={5} label="Three more voices" />
    </div>
  );
}

function ContentStepView({ d }: { d: DraftRow }) {
  const s = d.state.content;
  const c = s.chosen;
  if (!c) return <Regenerate d={d} step={6} label="Draft content and money" />;
  return (
    <div className="space-y-4">
      <Advice text={s.advice ?? null} />
      <Stale d={d} s={s} step={6} />
      <div className="grid gap-3 md:grid-cols-2">
        <div className="card p-4 text-[13px]">
          <div className="eyebrow">Pillars</div>
          <ul className="mt-1.5 space-y-1">
            {c.pillars.map((p) => (
              <li key={p.name}>
                <b>{p.name}</b> <span className="text-muted">{p.why}</span>
              </li>
            ))}
          </ul>
          <div className="eyebrow mt-4">Series</div>
          <ul className="mt-1.5 space-y-1">
            {c.series.map((x) => (
              <li key={x.name}>
                <b>{x.name}</b> <span className="text-muted">· {x.format.replace('_', ' + ')} · {x.cadence}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="card p-4 text-[13px]">
          <div className="eyebrow">Product ladder</div>
          <table className="mt-1.5 w-full">
            <tbody>
              {c.ladder.map((r) => (
                <tr key={r.rung} className="border-b border-line last:border-0">
                  <td className="py-1 pr-2 text-muted">{r.rung.replace('_', ' ')}</td>
                  <td className="py-1 pr-2">{r.name}</td>
                  <td className="py-1 text-right tabular-nums">{r.priceCents ? usd(r.priceCents) : 'free'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card p-4 text-[13px]">
        <div className="eyebrow">First product brief</div>
        <h3 className="mt-1 text-[16px] font-semibold">
          {c.firstProductBrief.name} · {usd(c.firstProductBrief.priceCents)} · keyword {c.firstProductBrief.keyword}
        </h3>
        <p className="mt-1 text-muted">
          {c.firstProductBrief.promise} {c.firstProductBrief.format}.
        </p>
        <ol className="mt-2 list-decimal space-y-0.5 pl-5">{c.firstProductBrief.sections.map((x) => <li key={x}>{x}</li>)}</ol>
      </div>
      <div className="card p-4 text-[13px]">
        <div className="eyebrow">Hook bank · {c.hookBank.length}</div>
        <ol className="mt-1.5 list-decimal columns-1 gap-6 space-y-0.5 pl-5 sm:columns-2">{c.hookBank.map((h) => <li key={h}>{h}</li>)}</ol>
        {editable(d) ? (
          <details className="mt-3">
            <summary className="cursor-pointer text-[13px] font-semibold">Edit hooks</summary>
            <form action={editStep} className="mt-2 space-y-2">
              <Hidden d={d} step={6} />
              <textarea name="f_hookBank" defaultValue={c.hookBank.join('\n')} rows={8} className="input h-auto py-2" aria-label="Hooks, one per line" />
              <SubmitButton className="btn btn-sm btn-ink">Save hooks</SubmitButton>
            </form>
          </details>
        ) : null}
      </div>
      {editable(d) ? (
        <details className="card p-4">
          <summary className="cursor-pointer text-[14px] font-semibold">Edit pillars, series, ladder and the first product</summary>
          <form action={editStep} className="mt-3 grid gap-2 sm:grid-cols-2">
            <Hidden d={d} step={6} />
            <Field label="Pillars (one per line: name: why)" name="pillars" value={c.pillars.map((x) => `${x.name}: ${x.why}`).join('\n')} wide area />
            <Field label="Series (one per line: name | format | cadence | pillar)" name="series" value={c.series.map((x) => [x.name, x.format, x.cadence, x.pillar].join(' | ')).join('\n')} wide area />
            {c.ladder.map((r) => (
              <div key={r.rung} className="grid grid-cols-[minmax(0,1fr)_96px] gap-2 sm:col-span-2">
                <Field label={`${r.rung.replace('_', ' ')}: name`} name={`ladder_${r.rung}_name`} value={r.name} />
                <Field label="Price ($)" name={`ladder_${r.rung}_price`} value={String(r.priceCents / 100)} />
              </div>
            ))}
            <Field label="First product: name" name="briefName" value={c.firstProductBrief.name} />
            <Field label="First product: price ($)" name="briefPrice" value={String(c.firstProductBrief.priceCents / 100)} />
            <Field label="First product: promise" name="briefPromise" value={c.firstProductBrief.promise} wide area />
            <Field label="First product: format" name="briefFormat" value={c.firstProductBrief.format} />
            <Field label="First product: CTA keyword" name="briefKeyword" value={c.firstProductBrief.keyword} />
            <Field label="First product: sections (one per line)" name="briefSections" value={c.firstProductBrief.sections.join('\n')} wide area />
            <div className="sm:col-span-2">
              <SubmitButton className="btn btn-sm btn-ink">Save the plan</SubmitButton>
            </div>
          </form>
        </details>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PickButton d={d} step={6} option="A" label="Use this plan and review →" />
        <Regenerate d={d} step={6} label="Redraft" />
      </div>
    </div>
  );
}

function ReviewStepView({ d }: { d: DraftRow }) {
  const r = d.state.review.chosen;
  if (!r) return <Regenerate d={d} step={7} label="Compute the review" />;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_260px]">
        <div className="card p-4">
          <div className="flex items-baseline justify-between">
            <div className="eyebrow">Win scorecard</div>
            <div className="text-[30px] font-semibold tabular-nums leading-none">
              {r.scorecard.total}
              <span className="text-[14px] text-muted">/100</span>
            </div>
          </div>
          <div className="mt-3">
            <ScoreGrid s={r.scorecard} />
          </div>
        </div>
        <div className="card p-4 text-[13px]">
          <div className="eyebrow">Distinctness</div>
          <div className="mt-1 text-[30px] font-semibold tabular-nums leading-none">
            {r.distinctness.score}
            <span className="text-[14px] text-muted">/100</span>
          </div>
          <span className={`pill mt-2 ${r.distinctness.verdict === 'distinct' ? 'bg-ok-soft text-ok' : r.distinctness.verdict === 'close' ? 'bg-warn-soft text-warn' : 'bg-danger-soft text-danger'}`}>{r.distinctness.verdict}</span>
          <ul className="mt-3 space-y-1.5">
            {r.distinctness.nearest.map((n) => (
              <li key={`${n.source}-${n.slug}`}>
                <span className="font-medium">{n.name}</span> <span className="text-muted">({n.source}) {Math.round(n.similarity * 100)}%</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="card p-4 text-[13px]">
        <div className="eyebrow flex items-center gap-1.5">
          <IconFlag size={12} /> Risks
        </div>
        <ul className="mt-2 space-y-1">
          {r.risks.map((x, i) => (
            <li key={i} className={x.startsWith('Line:') || x.startsWith('Too close') ? 'font-medium text-danger' : ''}>
              {x}
            </li>
          ))}
        </ul>
        {r.missing.length ? <p className="mt-2 font-medium text-warn">Still to settle: {r.missing.join(', ')}.</p> : null}
        <p className="mt-3 text-muted">
          First posts from {r.launchDate} ({r.timezone}) · 10 a week for the first fortnight · the Field Brain build is queued at launch.
        </p>
        {editable(d) ? (
          <form action={setLaunch} className="mt-3 flex flex-wrap items-end gap-2">
            <Hidden d={d} step={7} />
            <label className="text-[12.5px] text-muted">
              First posts on
              <input type="date" name="launch_date" defaultValue={r.launchDate} required className="input mt-1 h-9 text-fg" />
            </label>
            <label className="min-w-0 flex-1 text-[12.5px] text-muted sm:flex-none">
              Timezone
              <input name="timezone" defaultValue={r.timezone} required className="input mt-1 h-9 text-fg sm:w-56" placeholder="America/New_York" />
            </label>
            <SubmitButton className="btn btn-sm">Save launch plan</SubmitButton>
          </form>
        ) : null}
      </div>
      {d.status === 'launched' ? (
        <p className="rounded-xl border border-ok/40 bg-ok-soft px-4 py-3 text-[13.5px] text-ok">
          Launched {d.launched_at ? relative(new Date(d.launched_at)) : ''} by {d.launched_by}.
        </p>
      ) : d.status === 'active' ? (
        <form action={approveLaunch} className={`card space-y-3 p-5 ${r.ready ? 'border-ink' : 'opacity-80'}`}>
          <Hidden d={d} step={7} />
          <h3 className="text-[18px] font-semibold tracking-tight">Approve the launch</h3>
          <p className="text-[13px] text-muted">
            Creates {d.state.character.chosen?.name ?? 'the persona'} {d.persona_id ? '(already imported from the archive)' : ''} in setup with the deep profile, the launch calendar, the product
            ladder and the Field Brain seed. Only you can approve this; nothing auto-approves.
          </p>
          <label className="flex items-start gap-2 text-[13.5px]">
            <input type="checkbox" name="confirm" required className="mt-1" disabled={!r.ready} aria-label={`I have reviewed version ${d.version} and approve this launch`} />
            <span>I have reviewed version {d.version} and approve this launch.</span>
          </label>
          <SubmitButton className="btn btn-ink">
            <IconCheck size={14} /> Approve launch
          </SubmitButton>
          {!r.ready ? <p className="text-[12.5px] text-danger">Not ready yet: fix what is marked above first.</p> : null}
        </form>
      ) : null}
    </div>
  );
}

// ───────────────────────────── Page ─────────────────────────────

const STATUS_DOT: Record<string, string> = { done: 'bg-ok', ready: 'bg-accent', stale: 'bg-warn', empty: 'bg-surface-3' };

export default async function DraftPage({ params, searchParams }: Props) {
  await requireOwnerPage();
  const [{ draftId }, sp] = await Promise.all([params, searchParams]);
  const { db, studio } = await studioContext();
  const d = await getDraft(db, draftId);
  if (!d || d.studio_id !== studio.id) notFound();
  const requested = Number(sp.step);
  const step = Number.isInteger(requested) && requested >= 1 && requested <= 7 ? requested : d.current_step;
  const [messages, versions, mode] = await Promise.all([
    listDraftMessages(db, d.id, 80),
    draftVersions(db, d.id),
    getServices()
      .then((s) => s.runtime.mode)
      .catch(() => 'fake' as const),
  ]);
  const meta = STEPS[step - 1]!;
  const view: Record<number, ReactNode> = {
    1: <OpportunityStep d={d} />,
    2: <ConceptStep d={d} />,
    3: <CharacterStepView d={d} />,
    4: <LookStepView d={d} />,
    5: <VoiceStepView d={d} />,
    6: <ContentStepView d={d} />,
    7: <ReviewStepView d={d} />,
  };
  const stepState = (n: number) => d.state[STEPS[n - 1]!.key] as StepState<unknown, unknown>;

  return (
    <div className="space-y-5">
      <Link href="/generator" className="text-[13px] text-muted hover:text-fg">
        ← Generator
      </Link>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="eyebrow">
            {d.source === 'archive' ? `Restored from the archive${d.archive_ref ? ` (${d.archive_ref.label})` : ''}` : d.source === 'owner_idea' ? 'From your idea' : 'Recommended by the Studio Manager'} · v{d.version} ·{' '}
            {d.status}
          </div>
          <h1 className="truncate font-[family-name:var(--font-display)] text-[40px] leading-none tracking-tight sm:text-[48px]">{d.title}</h1>
        </div>
        <div className="flex items-center gap-2">
          {d.scores.total ? (
            <span className="pill border border-line bg-surface text-[13px] font-semibold tabular-nums">
              {d.scores.total}/100{d.scores.distinctness !== undefined ? ` · distinct ${d.scores.distinctness}` : ''}
            </span>
          ) : null}
          {d.status === 'active' ? (
            <form action={archiveDraftAction}>
              <input type="hidden" name="draft_id" value={d.id} />
              <SubmitButton className="btn btn-sm">Archive draft</SubmitButton>
            </form>
          ) : d.status === 'archived' ? (
            <form action={restoreDraftAction}>
              <input type="hidden" name="draft_id" value={d.id} />
              <SubmitButton className="btn btn-sm btn-ink">Restore draft</SubmitButton>
            </form>
          ) : d.persona_id ? (
            <Link href="/" className="btn btn-sm">
              Studio wall
            </Link>
          ) : null}
        </div>
      </div>
      <Flash error={sp.error} ok={sp.ok} />
      {isRestoredDraft(d) && d.status === 'active' ? (
        <p className="rounded-xl border border-line bg-surface-2 px-4 py-3 text-[13px] text-muted">
          <b className="text-fg">Restored exactly from the archive.</b> This draft mirrors {d.title}&rsquo;s documents, so it is read-only here: review it and approve the launch, then edit
          the bible from the persona&rsquo;s page after launch.
        </p>
      ) : null}

      <nav aria-label="Steps" className="no-scrollbar -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
        {STEPS.map((s) => {
          const st = stepState(s.n);
          const here = s.n === step;
          return (
            <Link
              key={s.n}
              href={`/generator/${d.id}?step=${s.n}`}
              aria-current={here ? 'step' : undefined}
              className={`flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-[12.5px] font-medium transition ${here ? 'border-ink bg-ink text-on-ink' : 'border-line bg-surface hover:bg-surface-2'}`}
            >
              <span className={`size-2 rounded-full ${STATUS_DOT[st.status] ?? 'bg-surface-3'}`} title={st.status} />
              {s.n}. {s.title}
            </Link>
          );
        })}
      </nav>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <section className="min-w-0 space-y-3" aria-label={meta.title}>
          <div>
            <h2 className="text-[22px] font-semibold tracking-tight">
              {meta.n}. {meta.title}
            </h2>
            <p className="text-[13px] text-muted">{meta.blurb}</p>
          </div>
          {stepState(step).status === 'empty' && step !== 7 && !(step === 5 && d.state.voice.options.length) ? (
            <div className="card space-y-3 p-5 text-[13.5px]">
              <p className="text-muted">{step === 1 ? 'No options yet.' : `Not drafted yet: pick on step ${step - 1} first, or draft it now from what is chosen so far.`}</p>
              <Regenerate d={d} step={step} label="Draft this step" />
            </div>
          ) : (
            view[step]
          )}
          {/* IOS-5 panels: each stream fills only its own component (docs/IOS-5-CONTRACTS.md §4). */}
          {step === 1 ? <RadarGeneratorPanel draft={d} studioId={d.studio_id} /> : null}
          {step === 6 ? <FormatsGeneratorPanel draft={d} studioId={d.studio_id} /> : null}
          {step === 6 ? <WorldGeneratorPanel draft={d} studioId={d.studio_id} /> : null}
        </section>
        {/* On a phone the chat sits below the step: a sticky shortcut jumps to it. */}
        <a
          href="#studio-chat"
          className="btn btn-ink fixed bottom-4 right-4 z-30 shadow-lift xl:hidden"
          aria-label="Ask the Studio Manager (jump to the chat)"
        >
          Ask the Studio Manager
        </a>
        <div id="studio-chat" className="min-w-0 scroll-mt-20">
          <ChatPanel
            threadId={d.id}
            endpoint={`/api/generator/${d.id}/chat?step=${step}`}
            refreshOnReply
            title="Studio Manager"
            subtitle={`On ${meta.title.toLowerCase()} · suggestions, or tell me what to change`}
            initial={messages.map((m) => toChatMsg(m))}
            mode={mode}
            placeholder={step === 2 ? "e.g. combine A's look with B's mechanic" : step === 3 ? 'e.g. make her older and drier' : 'Ask, or tell me what to change'}
            className="h-[460px] xl:sticky xl:top-20 xl:h-[calc(100dvh-7rem)]"
          />
          <details className="mt-3 text-[12.5px]">
            <summary className="cursor-pointer text-muted">Version history · {versions.length}</summary>
            <ol className="mt-2 space-y-1">
              {versions.slice(0, 30).map((v) => (
                <li key={v.version} className="flex items-center gap-2">
                  <span className="w-8 shrink-0 tabular-nums text-muted">v{v.version}</span>
                  <span className="min-w-0 flex-1">{v.change}</span>
                  <span className="shrink-0 text-muted">{relative(new Date(v.created_at))}</span>
                  {editable(d) && v.version < d.version && v.step > 0 ? (
                    <form action={restoreVersionAction}>
                      <Hidden d={d} step={step} />
                      <input type="hidden" name="restore_version" value={v.version} />
                      <input type="hidden" name="back_step" value={step} />
                      <SubmitButton className="btn btn-sm h-7 px-2 text-[11.5px]" title={`Make v${v.version} current again (saved as a new version)`}>
                        Restore
                      </SubmitButton>
                    </form>
                  ) : null}
                </li>
              ))}
            </ol>
          </details>
        </div>
      </div>
    </div>
  );
}
