import { fillTemplate, HOOK_TEMPLATES } from '@troupe/content';

/**
 * The niche filter for the Persona Generator (PRD §3.15.7): "could a real creator build a personal brand by talking
 * to camera about this?" Five questions, plus niche vs format (transformations, makeovers and mashups are formats,
 * not niches). Deterministic and explainable: each "no" names what tripped it. The generator folds it into the
 * producibility score; the Studio Manager calls it as `production.niche_filter`.
 */

export const NICHE_QUESTIONS = [
  { id: 'ideas', question: '50–100 ideas?' },
  { id: 'host', question: 'Is the returning host what people come back for?' },
  { id: 'character', question: 'A recognisable character?' },
  { id: 'hooks', question: 'Strong hooks without expensive scenes?' },
  { id: 'return', question: 'A reason to come back?' },
] as const;
export type NicheQuestionId = (typeof NICHE_QUESTIONS)[number]['id'];

/** Formats people mistake for niches. */
const FORMAT_WORDS = /\b(transformations?|makeovers?|mash-?ups?|before[- ]and[- ]after|glow[- ]?ups?|reaction videos?|compilations?|challenges?|unboxings?|duets?|asmr|day in the life|vlogs?|tier lists?)\b/i;
/** Content that works without a host (scenery, satisfying loops, gameplay): nobody comes back for the person. */
const HOSTLESS = /\b(satisfying|scenery|landscapes?|drone|time-?lapse|wallpapers?|slime|gameplay|speedruns?|aesthetic edits?|nature footage|stock footage|lyrics?)\b/i;
/** Scenes that are expensive or unreliable to generate. */
const EXPENSIVE = /\b(stunts?|explosions?|car chases?|crowds?|stadiums?|concerts?|skydiv\w*|underwater|scuba|surf(?:ing)?|parkour|dance routines?|choreograph\w*|fight scenes?|sports? matches?|travel(?:ling)? (?:to|around) (?:the world|\d+ countries)|road trips?|multiple locations|animals? performing)\b/i;
const ONE_OFF = /\b(?:wedding day|one[- ]off|single event|launch day|this year's|2026 only)\b/i;
const RECURRING = /\b(?:day \d+|series|every (?:day|week|morning|night|friday|sunday)|weekly|daily|part \d+|episodes?|ongoing|storyline|running|returns?|recurring|ritual|diary|journal|countdown|challenge|check-?in|hatch|club|shift|routine)\b/i;

export interface NicheFilterInput {
  readonly niche: string;
  readonly premise?: string | null;
  readonly mechanic?: string | null;
  readonly archetype?: string | null;
  readonly hooks?: readonly string[];
  readonly pillars?: readonly string[];
}

export interface NicheAnswer {
  readonly id: NicheQuestionId;
  readonly question: string;
  readonly yes: boolean;
  readonly why: string;
}

export interface NicheFilterResult {
  readonly pass: boolean;
  /** Yes answers, 0–5. */
  readonly score: number;
  readonly answers: readonly NicheAnswer[];
  /** The format word when the "niche" is really a format (transformations, makeovers, mashups…), else null. */
  readonly formatNotNiche: string | null;
  /** The hook templates the niche can feed, filled with its topic (inspiration for the sample hook bank). */
  readonly templates: ReadonlyArray<{ readonly id: string; readonly name: string; readonly example: string }>;
  readonly summary: string;
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);

export function nicheFilter(i: NicheFilterInput): NicheFilterResult {
  const niche = i.niche.trim();
  const concept = [i.premise, i.mechanic, i.archetype].filter(Boolean).join(' ');
  const all = `${niche} ${concept}`;
  const hooks = (i.hooks ?? []).filter((h) => h.trim());
  const fmt = FORMAT_WORDS.exec(niche)?.[1] ?? null;
  const expensive = EXPENSIVE.exec(`${concept} ${hooks.join(' ')}`)?.[0] ?? null;
  const hostless = HOSTLESS.exec(all)?.[0] ?? null;
  const answers: NicheAnswer[] = [];
  const add = (id: NicheQuestionId, yes: boolean, why: string) => answers.push({ id, question: NICHE_QUESTIONS.find((q) => q.id === id)!.question, yes, why });

  const narrow = !niche || ONE_OFF.test(niche);
  add('ideas', !fmt && !narrow, fmt ? `"${fmt}" is a format, so the ideas run out with it` : narrow ? 'A one-off or empty topic: not 50–100 ideas' : `${niche} supports a long idea list (${(i.pillars?.length ?? 0) || 3}+ pillars)`);
  add('host', !hostless, hostless ? `"${hostless}" content works without a host: nobody comes back for the person` : 'A talking host is the draw');
  const character = !!(i.archetype?.trim() || i.premise?.trim());
  add('character', character, character ? 'A one-line character with a contrast' : 'No character yet: who is the returning host?');
  const shortHooks = hooks.length === 0 || hooks.filter((h) => words(h).length <= 12).length >= Math.ceil(hooks.length / 2);
  add('hooks', !expensive && shortHooks, expensive ? `Needs expensive scenes ("${expensive}")` : shortHooks ? 'Hooks land in a talking head or a cheap B-roll' : 'Hooks run long: tighten to ≤ 12 words');
  const returns = !!i.mechanic?.trim() || RECURRING.test(all);
  add('return', returns, returns ? 'A recurring mechanic or series gives a reason to come back' : 'No recurring mechanic: add a series, a ritual or a running storyline');

  const score = answers.filter((a) => a.yes).length;
  const topic = niche || 'this';
  const templates = HOOK_TEMPLATES.slice(0, 9).map((t) => ({ id: t.id, name: t.name, example: fillTemplate(t, topic) }));
  const pass = score >= 4 && !fmt && !hostless;
  const no = answers.filter((a) => !a.yes);
  return {
    pass,
    score,
    answers,
    formatNotNiche: fmt,
    templates,
    summary: pass
      ? `Niche filter ${score}/5: a host can build a personal brand talking to camera about ${topic}${no.length ? ` (watch: ${no.map((a) => a.why).join('; ')})` : ''}.`
      : `Niche filter ${score}/5: ${no.map((a) => a.why).join('; ')}.`,
  };
}
