/**
 * The production character sheet, the identity stack, the core references and the BOPA look pack (PRD §3.12 step 4
 * notes and §3.15.2). Pure prompt builders: @troupe/media runs the generations (Higgsfield, governor) and stores the
 * results in `production_identity`; the prompt compiler then puts the identity stack into every persona generation.
 *
 * Character prompt order (Dan Kieft method, PRD §3.12): camera angle → character (age, hair, 2–3 distinctive
 * features) → pose and background → outfit → skin detail → "no equipment or clutter in frame" → realism and texture.
 * Every prompt describes an invented character: never a real person, a pin or a scraped creator.
 */

export interface CharacterBrief {
  readonly name: string;
  readonly age?: number | string | null;
  /** Hair and 2–3 distinctive features (the look anchors). */
  readonly anchors: readonly string[];
  readonly wardrobe: readonly string[];
  readonly settings: readonly string[];
  readonly palette?: readonly string[];
  readonly stylisation?: string | null;
  /** Mood descriptors (text only) from the inspiration board; never an identity reference. */
  readonly mood?: readonly string[];
}

/** The five views of the production sheet (PRD §3.15.2). */
export const SHEET_VIEWS = ['front', 'side', 'back', 'front close-up', 'top-down'] as const;
/** The detail strip: 8–9 close-ups. */
export const DETAIL_STRIP = ['hair', 'skin', 'garments', 'shoes', 'jewellery', 'accessories', 'palette swatches', 'hands', 'fabric texture'] as const;
/** The four core reference images, in varied settings. */
export const CORE_REF_COUNT = 4;

const NO_CLUTTER = 'No equipment or clutter in frame.';
const SAFE = 'One person only, fully clothed, an invented AI character with no resemblance to any real person; no text, no logos, no watermarks.';
const REALISM = 'Photoreal, natural skin texture with visible pores and fine lines, true-to-life colour, slight film grain.';

const ageOf = (c: CharacterBrief) => (c.age === null || c.age === undefined || c.age === '' ? '' : typeof c.age === 'number' ? `${c.age}-year-old ` : `${c.age} `);
const anchorsOf = (c: CharacterBrief) => c.anchors.filter(Boolean).slice(0, 4).join(', ') || 'natural hair, a warm, open face';
const moodOf = (c: CharacterBrief) => (c.mood?.length ? ` Mood and styling: ${c.mood.slice(0, 6).join(', ')}.` : '');
const outfitOf = (c: CharacterBrief, i = 0) => c.wardrobe[i % Math.max(1, c.wardrobe.length)] ?? 'simple everyday clothes';
const settingOf = (c: CharacterBrief, i = 0) => c.settings[i % Math.max(1, c.settings.length)] ?? 'a bright, lived-in room';

/** One character prompt in the method's order. */
export function characterPrompt(c: CharacterBrief, o: { angle: string; pose: string; background: string; outfit?: string; skin?: string }): string {
  return [
    `${o.angle}.`,
    `${c.name}, a ${ageOf(c)}fictional AI character: ${anchorsOf(c)}.`,
    `${o.pose}, ${o.background}.`,
    `Wearing ${o.outfit ?? outfitOf(c)}.`,
    `${o.skin ?? 'Skin detail: natural texture, no smoothing or airbrushing'}.`,
    NO_CLUTTER,
    `${c.stylisation ? `${c.stylisation}. ` : ''}${REALISM}${moodOf(c)}`,
    SAFE,
  ].join(' ');
}

/** The 5-view production sheet on a neutral grey background: the identity reference. */
export function characterSheetPrompt(c: CharacterBrief): string {
  return [
    'Production character reference sheet, five full-body panels in one row on a seamless neutral grey background, even soft studio light, eye-level camera.',
    `The same person in every panel, in this order: ${SHEET_VIEWS.join(', ')} view.`,
    `${c.name}, a ${ageOf(c)}fictional AI character: ${anchorsOf(c)}.`,
    'Standing relaxed, arms loose at the sides.',
    `Wearing ${outfitOf(c)}.`,
    'Skin detail: natural texture, no smoothing.',
    NO_CLUTTER,
    `${REALISM}${moodOf(c)}`,
    SAFE,
  ].join(' ');
}

/** The detail strip: 8–9 close-ups of the details that must never drift. */
export function detailStripPrompt(c: CharacterBrief): string {
  const palette = c.palette?.length ? ` (palette: ${c.palette.slice(0, 5).join(', ')})` : '';
  return [
    `A horizontal strip of ${DETAIL_STRIP.length} square close-up photos on a neutral grey background, the same character in every one:`,
    `${DETAIL_STRIP.join(', ')}${palette}.`,
    `${c.name}, a ${ageOf(c)}fictional AI character: ${anchorsOf(c)}, wearing ${outfitOf(c)}.`,
    'Macro detail, even soft light.',
    NO_CLUTTER,
    REALISM,
    'No text, no logos, no labels.',
  ].join(' ');
}

/**
 * The identity stack that goes into every persona generation (PRD §3.15.2): a face close-up and two full-body shots
 * on neutral backgrounds.
 */
export function identityStackPrompts(c: CharacterBrief): Array<{ kind: 'face' | 'full_body'; label: string; prompt: string }> {
  const grey = 'on a seamless neutral grey background';
  return [
    { kind: 'face', label: 'face close-up', prompt: characterPrompt(c, { angle: 'Eye-level head-and-shoulders close-up, 85 mm lens, facing the camera', pose: 'Relaxed, natural expression', background: grey }) },
    { kind: 'full_body', label: 'full body front', prompt: characterPrompt(c, { angle: 'Eye-level full-body shot, 35 mm lens, facing the camera', pose: 'Standing relaxed', background: grey }) },
    {
      kind: 'full_body',
      label: 'full body three-quarter',
      prompt: characterPrompt(c, { angle: 'Full-body shot with the camera 45° to the left, eye level, 35 mm lens', pose: 'Standing with weight on one leg, a small smile', background: grey }),
    },
  ];
}

/** The 4 core reference images, each in a different setting from the persona's world. */
export function coreRefPrompts(c: CharacterBrief): Array<{ label: string; prompt: string }> {
  const shots = [
    { angle: 'Eye-level medium shot, 35 mm phone lens', pose: 'Sitting at ease, looking just past the camera' },
    { angle: 'Slightly high angle, arm’s-length selfie framing', pose: 'Mid-laugh, one hand near the face' },
    { angle: 'Low three-quarter angle, 26 mm phone lens', pose: 'Leaning on a counter, relaxed' },
    { angle: 'Full-body shot, camera 30° to the right, eye level', pose: 'Walking slowly, glancing at the camera' },
  ];
  return shots.slice(0, CORE_REF_COUNT).map((s, i) => {
    const background = `in ${settingOf(c, i)}, real depth behind (never a flat backdrop)`;
    return { label: `core ${i + 1}: ${settingOf(c, i)}`.slice(0, 120), prompt: characterPrompt(c, { ...s, background, outfit: outfitOf(c, i) }) };
  });
}

// ───────────────────────────── BOPA look pack ─────────────────────────────

export type GridSize = 2 | 3;

/** A cell of an n×n grid image, as fractions of the image (for the crop and the upscale prompt). */
export function gridCell(index: number, n: GridSize): { row: number; col: number; left: number; top: number; width: number; height: number } {
  const i = Math.max(0, Math.min(n * n - 1, Math.floor(index)));
  const row = Math.floor(i / n);
  const col = i % n;
  return { row: row + 1, col: col + 1, left: col / n, top: row / n, width: 1 / n, height: 1 / n };
}

/** Nine background variations: each of the persona's settings at different times of day, plus quiet variants. */
export function backgroundCells(c: CharacterBrief): string[] {
  const settings = c.settings.length ? c.settings : ['a bright, lived-in room', 'a quiet street', 'a small kitchen'];
  const light = ['soft morning window light', 'bright midday light', 'warm late-afternoon light'];
  return Array.from({ length: 9 }, (_, i) => `${settings[i % settings.length]} in ${light[Math.floor(i / settings.length) % light.length] ?? light[i % 3]}`);
}

const POSES = [
  'leaning on a counter, laughing at something off camera',
  'sitting cross-legged on a sofa with a mug',
  'walking past a window, glancing back at the camera',
  'standing with arms folded, a knowing half-smile',
];

/** Angles stated in degrees (PRD §3.12): never a flat background. */
export const BOPA_ANGLES: ReadonlyArray<{ degrees: number; direction: 'left' | 'right' | 'above'; label: string }> = [
  { degrees: 45, direction: 'left', label: '45° left' },
  { degrees: 30, direction: 'right', label: '30° right' },
  { degrees: 20, direction: 'above', label: '20° high angle' },
];

export interface BopaPlan {
  readonly backgrounds: { readonly gridPrompt: string; readonly cells: readonly string[] };
  readonly outfits: ReadonlyArray<{ readonly label: string; readonly prompt: string }>;
  readonly poses: { readonly gridPrompt: string; readonly cells: readonly string[] };
  readonly angles: ReadonlyArray<{ readonly label: string; readonly degrees: number; readonly prompt: string }>;
}

/** The angle sentence: "camera 45° to the left of the subject, eye level". */
export function anglePrompt(degrees: number, direction: 'left' | 'right' | 'above'): string {
  const d = Math.round(Math.max(0, Math.min(180, degrees)));
  return direction === 'above' ? `Camera ${d}° above eye level, looking down at the subject` : `Camera ${d}° to the ${direction} of the subject, eye level`;
}

/**
 * BOPA (PRD §3.12): Backgrounds as one 3×3 grid of 9 using the character reference, then the pick is upscaled;
 * Outfits as a keep-identity edit; Poses as a 2×2 grid; Angles in degrees. Cheap face options first.
 */
export function bopaPlan(c: CharacterBrief): BopaPlan {
  const cells = backgroundCells(c);
  const who = `${c.name}, the same person as the reference images (${anchorsOf(c)})`;
  return {
    backgrounds: {
      gridPrompt: `A 3×3 grid of nine photos in one image, the same person in every cell: ${who}, wearing ${outfitOf(c)}, medium shot. Cell backgrounds, left to right and top to bottom: ${cells.map((x, i) => `${i + 1}) ${x}`).join('; ')}. Real depth behind every cell. ${NO_CLUTTER} ${REALISM} ${SAFE}`,
      cells,
    },
    outfits: (c.wardrobe.length ? c.wardrobe : ['simple everyday clothes']).slice(0, 3).map((o) => ({
      label: o.slice(0, 80),
      prompt: `Keep the exact same person, face, skin, hair, pose, framing, background and light as the reference image; change the outfit only, to ${o}. ${REALISM} ${SAFE}`,
    })),
    poses: {
      gridPrompt: `A 2×2 grid of four photos in one image, the same person, outfit and room in every cell: ${who}, in ${settingOf(c)}. Poses, left to right and top to bottom: ${POSES.map((p, i) => `${i + 1}) ${p}`).join('; ')}. ${NO_CLUTTER} ${REALISM} ${SAFE}`,
      cells: POSES,
    },
    angles: BOPA_ANGLES.map((a) => ({
      label: a.label,
      degrees: a.degrees,
      prompt: characterPrompt(c, { angle: anglePrompt(a.degrees, a.direction), pose: 'Natural, mid-movement', background: `in ${settingOf(c, 1)}, real depth behind (never a flat backdrop)` }),
    })),
  };
}

/** The upscale prompt for a picked grid cell: one full frame from that cell, identity kept. */
export function upscaleCellPrompt(cell: string, index: number, n: GridSize, what: 'background' | 'pose'): string {
  const g = gridCell(index, n);
  return `Upscale cell ${index + 1} (row ${g.row}, column ${g.col}) of the ${n}×${n} reference grid into one full-resolution 9:16 frame: the same person, face, hair and outfit, ${what === 'background' ? `in ${cell}` : cell}. Keep every detail of the cell; add natural detail only. ${REALISM} ${SAFE}`;
}

/** Deterministic default pick for a grid (fully automated; the Owner can re-pick with `look.pick`). */
export function defaultPick(seed: string, n: GridSize): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % (n * n);
}
