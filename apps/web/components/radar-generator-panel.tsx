import type { DraftRow } from '@ios/generator';

/**
 * Persona Generator panel for stream I (docs/IOS-5-CONTRACTS.md §4, §5.5): step 1 "Opportunity": the Growth Radar evidence behind the ranked niches (accelerating accounts, outliers, trends).
 * Contract stub: renders nothing until stream I fills it. Keep the name and props; catch your own errors and return
 * null. Read-only: the evidence is in `draft.state.radar` (and merged into each option's evidence with flag 'S').
 */
export async function RadarGeneratorPanel(_props: { draft: DraftRow; studioId: string }) {
  return null;
}
