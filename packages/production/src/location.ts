/**
 * Location lock prompts (PRD §3.15.3). Each recurring place is picked by running one prompt across 5 setting
 * variations, then locked as anchor frames (the pick plus a second angle). From then on every still at that place
 * references the anchors, and each new still also references the nearest approved frame (the consistency chain).
 * Anchor frames have no people in them: identity comes from the persona's own identity stack, never from a place frame.
 */

export const LOCATION_CANDIDATES = 5;

const VARIATIONS = [
  'soft morning light through the window',
  'bright overcast daylight',
  'warm late-afternoon light',
  'evening, warm lamps on',
  'clear midday light, tidy',
];

const NO_PEOPLE = 'No people in frame. No readable text, logos or watermarks. Photoreal phone photo, natural texture, real depth, lived-in and specific (never a showroom).';

/** The 5 candidates for one place: one prompt, five light/time variations. */
export function locationCandidatePrompts(place: string, description: string, stylisation?: string | null): Array<{ label: string; prompt: string }> {
  const base = `${place}: ${description}. Eye-level wide shot from the doorway, 24 mm phone lens.`;
  return VARIATIONS.slice(0, LOCATION_CANDIDATES).map((v, i) => ({
    label: `${place} · ${i + 1}/${LOCATION_CANDIDATES}`,
    prompt: `${base} ${v[0]!.toUpperCase()}${v.slice(1)}. ${stylisation ? `${stylisation}. ` : ''}${NO_PEOPLE}`,
  }));
}

/** The second anchor angle, generated with the pick as its reference. */
export function locationAnchorPrompt(place: string, description: string): string {
  return `The same ${place} as the reference image (${description}), exactly the same layout, furniture, window and light direction, seen from the opposite corner at eye level, 26 mm phone lens. ${NO_PEOPLE}`;
}
