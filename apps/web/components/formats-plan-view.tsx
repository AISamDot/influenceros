import type { FormatPlan } from '@troupe/agents';
import { FORMAT_LABEL, monthlyCostUsd, STORY_KIND_LABEL, usd } from '@troupe/formats';
import { SubmitButton } from './submit-button';

/**
 * Stream L: a Format Plan as a table (weekly feed posts per format with reason and cost, Stories per day and mix) and
 * the Owner's edit form. Shared by the persona page and Persona Generator step 6.
 */
export function FormatPlanView({ plan }: { plan: FormatPlan }) {
  const on = plan.lines.filter((l) => l.enabled);
  const off = plan.lines.filter((l) => !l.enabled);
  const stills = on.filter((l) => ['static', 'carousel', 'photo_dump', 'text_note', 'meme'].includes(l.format)).reduce((a, l) => a + l.perWeek, 0);
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[13px] sm:grid-cols-4">
        <div>
          <dt className="eyebrow">Feed posts / week</dt>
          <dd className="font-semibold tabular-nums">{plan.postsPerWeek}</dd>
          <dd className="text-[11.5px] text-muted">{stills} stills or written</dd>
        </div>
        <div>
          <dt className="eyebrow">Stories / day</dt>
          <dd className="font-semibold tabular-nums">{plan.stories.perDay}</dd>
          <dd className="text-[11.5px] text-muted">+1 sell frame on sell days</dd>
        </div>
        <div>
          <dt className="eyebrow">Cost / week</dt>
          <dd className="font-semibold tabular-nums">{usd(plan.costPerWeekUsd)}</dd>
          <dd className="text-[11.5px] text-muted">~{usd(monthlyCostUsd(plan))} a month</dd>
        </div>
        <div>
          <dt className="eyebrow">Source</dt>
          <dd className="font-semibold capitalize">{plan.source}</dd>
          <dd className="text-[11.5px] text-muted">{plan.benchmark ? `Radar benchmark (${plan.benchmark.confidence})` : 'studio default weights'}</dd>
        </div>
      </dl>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-left text-[12.5px]">
          <thead className="text-muted">
            <tr>
              <th className="py-1 pr-3 font-medium">Format</th>
              <th className="py-1 pr-3 text-right font-medium">/ week</th>
              <th className="py-1 pr-3 text-right font-medium">Cost / wk</th>
              <th className="py-1 font-medium">Why</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {on.map((l) => (
              <tr key={l.format}>
                <td className="py-1.5 pr-3 font-medium">{FORMAT_LABEL[l.format]}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{l.perWeek}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{usd(l.costPerWeekUsd)}</td>
                <td className="py-1.5 text-muted">{l.reason}</td>
              </tr>
            ))}
            {plan.stories.mix
              .filter((m) => m.perDay > 0)
              .map((m) => (
                <tr key={m.kind}>
                  <td className="py-1.5 pr-3 font-medium">Story: {STORY_KIND_LABEL[m.kind]}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{m.kind === 'sell' ? 'sell days' : `${m.perDay * 7}`}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{m.kind === 'sell' ? usd(0.05) : usd(m.perDay * 7 * 0.05)}</td>
                  <td className="py-1.5 text-muted">{m.reason}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {off.length ? <p className="text-[12px] text-muted">Off: {off.map((l) => FORMAT_LABEL[l.format]).join(', ')}.</p> : null}
      <p className="text-[12.5px] text-muted">{plan.reason}</p>
    </div>
  );
}

/** The Owner's edit form: counts per format, optional formats on/off, Stories per day. */
export function FormatPlanForm({ plan, action, hidden, label = 'Save plan' }: { plan: FormatPlan; action: (form: FormData) => Promise<void>; hidden: Record<string, string>; label?: string }) {
  return (
    <details className="rounded-lg border border-line p-3">
      <summary className="cursor-pointer text-[13px] font-medium">Edit the plan</summary>
      <form action={action} className="mt-3 space-y-3">
        {Object.entries(hidden).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {plan.lines.map((l) => {
            const optional = !['talking', 'activity_text', 'voiceover', 'static', 'carousel'].includes(l.format);
            return (
              <label key={l.format} className="flex items-center justify-between gap-2 text-[12.5px]">
                <span className="flex items-center gap-2">
                  {optional ? (
                    <>
                      <input type="hidden" name={`has_on_${l.format}`} value="1" />
                      <input type="checkbox" name={`on_${l.format}`} defaultChecked={l.enabled} aria-label={`${FORMAT_LABEL[l.format]} on`} />
                    </>
                  ) : (
                    <span className="inline-block w-[13px]" aria-hidden />
                  )}
                  {FORMAT_LABEL[l.format]}
                </span>
                <input type="number" name={`count_${l.format}`} min={optional ? 0 : 1} max={21} defaultValue={l.enabled ? l.perWeek : 0} className="input w-16 text-right" aria-label={`${FORMAT_LABEL[l.format]} per week`} />
              </label>
            );
          })}
        </div>
        <label className="flex items-center gap-2 text-[12.5px]">
          Stories a day
          <input type="number" name="stories_per_day" min={3} max={5} defaultValue={plan.stories.perDay} className="input w-16 text-right" />
        </label>
        <input type="text" name="note" placeholder="Why (optional)" maxLength={200} className="input w-full text-[12.5px]" />
        <p className="text-[11.5px] text-muted">Core formats keep at least 1; 7–21 feed posts a week; Stories 3–5 a day.</p>
        <SubmitButton className="btn btn-sm btn-ink">{label}</SubmitButton>
      </form>
    </details>
  );
}
