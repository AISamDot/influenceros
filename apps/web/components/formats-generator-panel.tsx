import type { DraftRow } from '@ios/generator';
import { resetDraftPlan, saveDraftPlan } from '@/app/generator/formats-actions';
import { SubmitButton } from './submit-button';
import { FormatPlanForm, FormatPlanView } from './formats-plan-view';

/**
 * Persona Generator panel for stream L (docs/IOS-5-CONTRACTS.md §4, §5.5), step 6: the Format Plan the Studio Manager
 * recommends (weekly counts per format, optional formats, Stories per day and mix, reason and cost per line). The Owner
 * edits it here (a new draft version) and approves it with the launch. Returns null on any failure.
 */
export async function FormatsGeneratorPanel({ draft }: { draft: DraftRow; studioId: string }) {
  try {
    const plan = draft.state.formatPlan;
    return (
      <section className="card space-y-3 p-5" aria-labelledby="formats-gen-panel">
        <div className="flex items-center justify-between gap-3">
          <h3 id="formats-gen-panel" className="text-[15px] font-semibold">
            Format Plan (approved with the launch)
          </h3>
          <form action={resetDraftPlan}>
            <input type="hidden" name="draft_id" value={draft.id} />
            <SubmitButton className="btn btn-sm">{plan ? 'Recommend again' : 'Recommend a plan'}</SubmitButton>
          </form>
        </div>
        {plan ? (
          <>
            <FormatPlanView plan={plan} />
            {draft.status === 'active' ? <FormatPlanForm plan={plan} action={saveDraftPlan} hidden={{ draft_id: draft.id, version: String(draft.version) }} /> : null}
          </>
        ) : (
          <p className="text-[13px] text-muted">The Studio Manager drafts the plan with this step (weekly posts by format and Stories per day). Without one, the studio default applies.</p>
        )}
      </section>
    );
  } catch {
    return null;
  }
}
