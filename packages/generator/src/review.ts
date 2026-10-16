import type { StudioServices } from '@ios/agents';
import { nicheByKey, nicheForText } from './library';
import { archiveSignatures, distinctness, draftSignature, lineFlags, scoreConcept, studioSignatures, textOf } from './score';
import { type DraftRow, type DraftState, type ReviewState, STEPS, type StepState } from './types';

/**
 * Step 7: the full scorecard, distinctness against the studio and the archive, the risks, and whether the draft can
 * launch. Recomputed after every change, so the Owner always sees the current numbers.
 */

const DAY = 86_400_000;

/** The Monday at least 10 days out (time to create the accounts), as YYYY-MM-DD. */
export function defaultLaunchDate(now: Date): string {
  const d = new Date(now.getTime() + 10 * DAY);
  const dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + ((8 - dow) % 7));
  return d.toISOString().slice(0, 10);
}

export async function computeReview(services: StudioServices, d: Pick<DraftRow, 'studio_id' | 'persona_id' | 'archive_ref' | 'title'>, state: DraftState): Promise<ReviewState> {
  const concept = state.concept.chosen;
  const opp = state.opportunity.chosen;
  const niche = (opp && nicheByKey(opp.niche)) ?? nicheForText(`${opp?.niche ?? ''} ${state.seed.idea ?? ''}`);
  const others = [...(await studioSignatures(services.db, d.studio_id, d.persona_id)), ...archiveSignatures(d.archive_ref)];
  const dist = distinctness(draftSignature(state, d.title), others);
  const scorecard = concept
    ? scoreConcept({
        concept,
        opportunity: opp,
        ladder: state.content.chosen?.ladder,
        settings: state.look.chosen?.profile.settings,
        catchphrases: state.character.chosen?.catchphrases,
        distinct: dist.score,
      })
    : { captivation: 0, demand: 0, ladder: 0, gap: 0, producibility: 0, lineSafety: 0, total: 0, notes: {} };

  // What blocks the launch: a step with nothing chosen, or one drafted before an earlier step changed (stale) and not
  // yet regenerated or kept as is. Launching a stale look or voice would ship the old concept's character.
  const missing: string[] = [];
  for (const s of STEPS.slice(0, 6)) {
    const st = state[s.key] as StepState<unknown, unknown>;
    if (!st.chosen) missing.push(s.title);
    else if (st.status === 'stale') missing.push(`${s.title} (out of date: regenerate it or keep it as is)`);
  }
  const risks: string[] = [];
  const flags = lineFlags(
    [textOf(concept), textOf(state.character.chosen), textOf(state.content.chosen?.hookBank), textOf(state.content.chosen?.firstProductBrief)].join(' \n '),
  );
  for (const f of new Set(flags)) risks.push(`Line: ${f} in the draft text. Rewrite it before launch.`);
  if (dist.verdict === 'clone') risks.push(`Too close to ${dist.nearest[0]?.name} (${dist.nearest[0]?.source}): change the name, premise or look.`);
  else if (dist.verdict === 'close') risks.push(`Close to ${dist.nearest[0]?.name} (${dist.nearest[0]?.source}, similarity ${dist.nearest[0]?.similarity}): keep the audiences apart.`);
  for (const k of ['character', 'look', 'voice', 'content'] as const) {
    if ((state[k] as StepState<unknown, unknown>).status === 'stale') risks.push(`${STEPS.find((s) => s.key === k)!.title} was drafted before an earlier step changed: regenerate it or keep it as is before launch.`);
  }
  const check = state.look.chosen?.check;
  if (check?.drift.verdict === 'drifting') risks.push(`Look: ${check.drift.note}`);
  if (check && check.distinct.score < 35) risks.push(`Look: ${check.distinct.note}`);
  if (check?.mode === 'placeholder' || state.look.chosen?.variants.every((v) => v.provider === 'placeholder')) risks.push('Look: placeholder sheets only; the Soul ID and face checks run once Higgsfield is connected.');
  if (state.voice.chosen?.fake) risks.push('Voice: a fake preview; the real voice is designed once ElevenLabs is connected.');
  for (const r of niche.risks) risks.push(`Niche: ${r}`);
  if (scorecard.total && scorecard.total < 60) risks.push(`Scorecard ${scorecard.total}/100 is under 60: strengthen the weakest dimension before launch.`);

  const ready = missing.length === 0 && flags.length === 0 && dist.verdict !== 'clone';
  return {
    scorecard,
    distinctness: dist,
    risks,
    missing,
    launchDate:
      state.review.chosen?.launchDate ??
      (state.seed.launchDate && state.seed.launchDate > services.now().toISOString().slice(0, 10) ? state.seed.launchDate : defaultLaunchDate(services.now())),
    timezone: state.review.chosen?.timezone ?? state.seed.timezone ?? niche.timezone,
    ready,
  };
}
