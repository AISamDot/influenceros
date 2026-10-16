import type { DraftRow } from '@ios/generator';

/**
 * Persona Generator panel for stream L (docs/IOS-5-CONTRACTS.md §4, §5.5): step 6: the Format Plan the Studio Manager recommends (weekly counts per format, optional formats, Stories per day and mix, reason and cost per line; editable).
 * Contract stub: renders nothing until stream L fills it. Keep the name and props; catch your own errors and return
 * null. Edits go through the stream's own server actions (`app/generator/formats-actions.ts`) calling
 * `setDraftExtension` from @ios/generator.
 */
export async function FormatsGeneratorPanel(_props: { draft: DraftRow; studioId: string }) {
  return null;
}
