import { CAMERA_STYLES, type CameraStyle } from '@troupe/agents';
import type { PostFormat } from '@troupe/core';

/**
 * Realism camera styles (PRD §3.15.8, Owner 16 Oct): never a locked-off "studio" camera. Each persona's bible picks
 * 3–5 styles that fit its life; the compiler rotates them per slot and the choice is recorded on the slot
 * (`calendar_slot.meta.production.camera`). Every style carries its realistic imperfections.
 */
export interface CameraSpec {
  readonly label: string;
  /** How a still is shot (image prompt, camera block). */
  readonly still: string;
  /** How the camera moves (video prompt, camera-motion block). */
  readonly motion: string;
  /** Realistic imperfections, woven into the sentence (never stacked as tags). */
  readonly imperfections: readonly string[];
  /** Works for a persona talking to camera (lip-sync friendly framing). */
  readonly talking: boolean;
}

export const CAMERA_SPEC: Readonly<Record<CameraStyle, CameraSpec>> = {
  handheld: {
    label: 'Handheld, filmed by a friend',
    still: 'shot handheld on a phone by a friend standing about a metre away at chest height, 26 mm phone lens',
    motion: 'gentle handheld sway as the friend filming shifts their weight',
    imperfections: ['slight focus hunting', 'a small exposure shift as the phone moves'],
    talking: true,
  },
  selfie: {
    label: "Arm's-length selfie",
    still: "an arm's-length front-camera selfie, slight wide-angle stretch at the edges",
    motion: "arm's-length selfie with a small natural arm wobble",
    imperfections: ['a thumb just at the frame edge', 'front-camera softness'],
    talking: true,
  },
  mirror: {
    label: 'Mirror reflection',
    still: 'a mirror reflection with the phone visible in hand, framed from mid-thigh up',
    motion: 'filmed in a mirror with the phone visible, a slow drift of the hand',
    imperfections: ['faint smudges on the mirror', 'the phone partly covering the chest'],
    talking: false,
  },
  propped_phone: {
    label: 'Phone propped on a counter',
    still: 'a phone propped on a counter or shelf at waist height, slightly low angle',
    motion: 'phone propped on a counter: a small settle-wobble at the start, then steady',
    imperfections: ['a slightly off-level horizon', 'a soft corner of the counter in the foreground'],
    talking: true,
  },
  over_shoulder: {
    label: 'Over the shoulder',
    still: 'an over-the-shoulder view from just behind, the shoulder soft in the foreground',
    motion: 'over-the-shoulder view with a slow handheld drift',
    imperfections: ['the near shoulder out of focus', 'light falling off at the frame edge'],
    talking: false,
  },
  dashcam: {
    label: 'Car dashboard (parked)',
    still: 'a phone on the dashboard mount of a parked car, seat belt on, engine off, passenger-side light',
    motion: 'phone on the dashboard mount of a parked car, a faint vibration',
    imperfections: ['window glare across one corner', 'a sliver of the dashboard in frame'],
    talking: true,
  },
  walk_and_talk: {
    label: 'Walk-and-talk',
    still: 'walking towards the camera on a quiet pavement, the phone held out ahead',
    motion: 'walk-and-talk at an easy pace, phone held out ahead with a light step bounce',
    imperfections: ['a footstep bounce', 'a brief exposure shift passing through shade'],
    talking: true,
  },
  doorway_peek: {
    label: 'Doorway peek',
    still: 'seen from a doorway, partly framed by the door frame',
    motion: 'a slow peek around the doorway that settles on the subject',
    imperfections: ['the door frame soft in the foreground', 'warmer light spilling from the room'],
    talking: false,
  },
};

/** Talking-to-camera formats (lip-synced clips). */
export const TALKING_FORMATS: readonly PostFormat[] = ['talking', 'facecam_screen', 'reply_comment', 'news_greenscreen'];

const DEFAULT_ROTATION: readonly CameraStyle[] = ['handheld', 'selfie', 'propped_phone', 'mirror', 'walk_and_talk'];

const isStyle = (x: unknown): x is CameraStyle => typeof x === 'string' && (CAMERA_STYLES as readonly string[]).includes(x);

const hash = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

/**
 * The persona's 3–5 styles: the bible's `look.camera_styles` (or `production.camera_styles`) when set, else a
 * rotation picked from the persona id that always includes handheld (the default) and at least two talking styles.
 */
export function cameraStylesFor(bible: Readonly<Record<string, unknown>> | null | undefined, personaId: string): CameraStyle[] {
  const look = (bible?.look ?? {}) as Record<string, unknown>;
  const prod = (bible?.production ?? {}) as Record<string, unknown>;
  const raw = [...(Array.isArray(look.camera_styles) ? look.camera_styles : []), ...(Array.isArray(prod.camera_styles) ? prod.camera_styles : [])]
    .map((x) => (typeof x === 'string' ? x.trim().toLowerCase().replace(/[\s-]+/g, '_') : x))
    .filter(isStyle);
  const own = [...new Set(raw)];
  if (own.length >= 3) return own.slice(0, 5);
  const extra = CAMERA_STYLES.filter((s) => !DEFAULT_ROTATION.includes(s));
  const pickExtra = extra[hash(personaId) % extra.length]!;
  const base = [...new Set([...own, ...DEFAULT_ROTATION.slice(0, 3), pickExtra])];
  return base.slice(0, Math.max(3, Math.min(5, base.length)));
}

/**
 * Picks the camera for one slot: a style that suits the format (talking formats need a talking style), avoiding the
 * persona's most recent ones, deterministic per `seed` (the slot id).
 */
export function pickCamera(styles: readonly CameraStyle[], o: { format?: PostFormat | null; recent?: readonly (string | null | undefined)[]; seed: string }): CameraStyle {
  const pool = styles.length ? styles : DEFAULT_ROTATION;
  const talking = !!o.format && TALKING_FORMATS.includes(o.format);
  const fit = pool.filter((s) => !talking || CAMERA_SPEC[s].talking);
  const eligible = fit.length ? fit : talking ? (['handheld', 'selfie', 'propped_phone'] as CameraStyle[]) : [...pool];
  const recent = (o.recent ?? []).filter(isStyle).slice(0, Math.max(0, eligible.length - 1));
  const fresh = eligible.filter((s) => !recent.includes(s));
  const choice = fresh.length ? fresh : eligible;
  return choice[hash(o.seed) % choice.length]!;
}

/** The camera sentence for a still: the style, its imperfections, woven into one line. */
export function cameraLine(style: CameraStyle): string {
  const c = CAMERA_SPEC[style];
  return `Photographed as ${c.still}, with ${c.imperfections.join(' and ')}; a real phone photo with natural skin texture and no studio lighting`;
}

/** The camera-motion sentence for a clip. */
export function cameraMotionLine(style: CameraStyle): string {
  const c = CAMERA_SPEC[style];
  return `Camera: ${c.motion}, with ${c.imperfections.join(' and ')}. Never a locked-off studio camera`;
}
