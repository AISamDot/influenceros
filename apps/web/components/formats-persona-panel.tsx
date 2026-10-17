import type { Db } from '@troupe/db';
import { defaultPlan, planHistory, planInForce } from '@troupe/formats';
import { savePersonaPlan } from '@/app/generator/formats-actions';
import { FormatPlanForm, FormatPlanView } from './formats-plan-view';

/**
 * Persona page panel for stream L (docs/IOS-5-CONTRACTS.md §4): the persona's Format Plan in force (weekly counts per
 * format, optional formats on/off, Stories per day and their mix, reason and cost per line), the latest lever change,
 * and the Owner's edit form. A failure here never takes the persona page down (returns null).
 */
export async function FormatsPersonaPanel({ db, personaId, slug }: { db: Db; studioId: string; personaId: string; slug: string }) {
  try {
    const now = new Date();
    const [inForce, history] = await Promise.all([planInForce(db, personaId, now), planHistory(db, personaId, 5)]);
    const plan = inForce ?? defaultPlan();
    return (
      <section className="card p-5" aria-labelledby="formats-panel">
        <div className="flex items-center justify-between gap-3">
          <h2 id="formats-panel" className="text-[15px] font-semibold">
            Format Plan
          </h2>
          <span className="text-[12px] text-muted">{inForce ? `v${inForce.version}${inForce.leverReason ? ' + Profit Engine move' : ''}` : 'studio default (no plan yet)'}</span>
        </div>
        {inForce?.leverReason ? <p className="mt-2 rounded-md bg-accent/10 px-3 py-2 text-[12.5px]">Profit Engine: {inForce.leverReason}</p> : null}
        <div className="mt-3">
          <FormatPlanView plan={plan} />
        </div>
        <div className="mt-3">
          <FormatPlanForm plan={plan} action={savePersonaPlan} hidden={{ slug }} />
        </div>
        {history.length > 1 ? (
          <ul className="mt-3 space-y-1 text-[12px] text-muted">
            {history.slice(0, 4).map((h) => (
              <li key={h.version}>
                v{h.version} · {h.source} · from {h.effectiveFrom} · {h.createdBy}
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    );
  } catch {
    return null;
  }
}
