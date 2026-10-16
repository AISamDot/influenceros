import type { DraftRow } from '@ios/generator';

/**
 * Persona Generator panel for stream J (docs/IOS-5-CONTRACTS.md §4, §5.5): step 6: the drafted World Bible and ~12-week storyline (editable), plus the Pinterest mood board (mood and format only, never a face reference).
 * Contract stub: renders nothing until stream J fills it. Keep the name and props; catch your own errors and return
 * null. Edits go through the stream's own server actions (`app/generator/world-actions.ts`) calling
 * `setDraftExtension` from @ios/generator.
 */
export async function WorldGeneratorPanel(_props: { draft: DraftRow; studioId: string }) {
  return null;
}
