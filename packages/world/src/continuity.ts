import type { QcCheck } from '@troupe/agents';
import { GENDER_OF, type Gender, type WorldBible } from './model';

/**
 * The fact / continuity ledger (PRD §3.14.4). Facts are what the persona states about herself and her world: names
 * and relations, ages, life events, possessions, opinions, where she lives. A deterministic extractor runs on every
 * text (and is the continuity-keeper's fake); the live continuity-keeper adds what the patterns miss. The check is
 * deterministic over structured facts, so a contradiction blocks the same way in fake and live mode.
 */

export type FactKind = 'person' | 'pet' | 'age' | 'event' | 'possession' | 'opinion' | 'place' | 'other';
export const FACT_KINDS: readonly FactKind[] = ['person', 'pet', 'age', 'event', 'possession', 'opinion', 'place', 'other'];

export interface Fact {
  readonly kind: FactKind;
  /** person: the relation ('sister'); pet: the species; age: 'self'; event: e.g. 'career years'; possession: 'car'; opinion: the thing; place: 'home'. */
  readonly subject: string;
  /** person / pet: the name; age: the number; event: the value; opinion: 'positive' | 'negative'; place: the place. */
  readonly value: string;
  /** The sentence it came from (≤ 200 chars). */
  readonly statement: string;
}

export interface LedgerFact extends Fact {
  readonly id: string;
  readonly sourceType: string;
  readonly sourceId: string | null;
  readonly statedAt: Date;
}

const PETS = new Set(['dog', 'cat', 'budgie', 'parrot', 'rabbit', 'tortoise', 'hamster', 'goldfish', 'puppy', 'kitten']);
/** Relations a persona has only one of at a time. */
const UNIQUE = new Set(['mum', 'mom', 'mother', 'dad', 'father', 'husband', 'wife', 'late husband', 'late wife', 'nan', 'grandad', 'boss', 'landlord', 'landlady']);
const SAME: Readonly<Record<string, string>> = { mom: 'mum', mother: 'mum', father: 'dad', neighbor: 'neighbour', nana: 'nan', gran: 'nan', grandma: 'nan', granny: 'nan', grandmother: 'nan', granddad: 'grandad', grandpa: 'grandad', grandfather: 'grandad', auntie: 'aunt', aunty: 'aunt', roommate: 'flatmate', colleague: 'coworker', puppy: 'dog', kitten: 'cat' };
export const normRelation = (r: string): string => SAME[r.toLowerCase()] ?? r.toLowerCase();

const RELATIONS = [...Object.keys(GENDER_OF), ...PETS].sort((a, b) => b.length - a.length).map((r) => r.replace(/[-]/g, '[- ]'));
const REL_RE = RELATIONS.join('|');
const NAME = "([A-Z][a-z]+(?:-[A-Z][a-z]+)?)";
const NOT_NAMES = new Set(['I', 'And', 'But', 'The', 'Then', 'So', 'Who', 'When', 'She', 'He', 'They', 'We', 'It', 'This', 'That', 'Yes', 'No', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December', 'Christmas', 'Easter', 'God', 'Mum', 'Mom', 'Dad', 'Nan', 'Gran', 'Grandad', 'Grandma', 'Grandpa', 'Auntie', 'Uncle', 'Sis', 'Bro']);

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const clip = (s: string) => s.slice(0, 200);

/** The deterministic fact extractor (also the continuity-keeper's fake output). */
export function extractFacts(text: string): Fact[] {
  const out: Fact[] = [];
  const push = (f: Fact) => {
    if (!out.some((x) => x.kind === f.kind && x.subject === f.subject && x.value.toLowerCase() === f.value.toLowerCase())) out.push(f);
  };
  for (const s of sentences(text)) {
    // "my sister Angie", "my late husband Ron", "my dog Biscuit"
    const relName = new RegExp(`\\bmy (?:late |little |big |older |younger |eldest |youngest |twin |old |best )?(${REL_RE})\\s*,?\\s+${NAME}`, 'gi');
    for (const m of s.matchAll(relName)) {
      const rel = normRelation(m[1]!.toLowerCase().replace(/\s+/g, ' '));
      const name = m[2]!;
      if (NOT_NAMES.has(name) || name[0] !== name[0]!.toUpperCase()) continue;
      const late = /\bmy late\b/i.test(m[0]);
      const relation = late && (rel === 'husband' || rel === 'wife') ? `late ${rel}` : rel;
      push({ kind: PETS.has(rel) ? 'pet' : 'person', subject: relation, value: name, statement: clip(s) });
    }
    // "Angie, my sister" / "a dog called Biscuit"
    for (const m of s.matchAll(new RegExp(`${NAME},\\s+my (?:late |little |big |older |younger |best )?(${REL_RE})\\b`, 'g'))) {
      if (NOT_NAMES.has(m[1]!)) continue;
      const rel = normRelation(m[2]!.toLowerCase());
      push({ kind: PETS.has(rel) ? 'pet' : 'person', subject: rel, value: m[1]!, statement: clip(s) });
    }
    for (const m of s.matchAll(new RegExp(`\\b(?:a|my|our) (${[...PETS].join('|')}) (?:called|named) ${NAME}`, 'gi'))) {
      if (m[2]![0] === m[2]![0]!.toUpperCase() && !NOT_NAMES.has(m[2]!)) push({ kind: 'pet', subject: normRelation(m[1]!.toLowerCase()), value: m[2]!, statement: clip(s) });
    }
    // "I'm 79", "I am 79 years old"
    const age = /\bI(?:'m| am) (\d{1,3})(?: years? (?:old|young))?(?=[\s,.!?;:]|$)(?!\s+(?:minutes?|hours?|days?|weeks?|months?|percent|%|times|pounds|quid|dollars|bucks|kg|kilos|miles|stone|steps|pence|p\b|cents?|mins?|seconds?|euros?|degrees?))/i.exec(s);
    if (age) {
      const n = Number(age[1]);
      if (n >= 13 && n <= 110) push({ kind: 'age', subject: 'self', value: String(n), statement: clip(s) });
    }
    // "I was a dinner lady for 41 years", "I worked at the mill for 30 years"
    const career = /\bI (?:was an? ([a-z][a-z -]{2,40}?)|worked(?: as an? ([a-z][a-z -]{2,40}?)| at [a-z][a-z -]{2,40}?)?|taught|nursed|served|cooked|drove (?:a |the )?[a-z]+) for (\d{1,2}) years\b/i.exec(s);
    if (career) push({ kind: 'event', subject: 'career years', value: career[3]!, statement: clip(s) });
    // "I live in Halifax"
    const lives = /\bI(?: live|'ve lived| have lived) in ([A-Z][\w'-]+(?:[ -][A-Z][\w'-]+)*)/.exec(s);
    if (lives) push({ kind: 'place', subject: 'home', value: lives[1]!, statement: clip(s) });
    // "I drive a Fiat Panda"
    const car = /\bI drive an? ((?:[A-Za-z]+ ){0,2}[A-Za-z]+)\b/.exec(s);
    if (car) push({ kind: 'possession', subject: 'car', value: car[1]!.toLowerCase(), statement: clip(s) });
    // "I love crosswords", "I can't stand coupons"
    for (const m of s.matchAll(/\bI (?:absolutely |really |just )?(love|adore|hate|can't stand|cannot stand|despise|loathe|detest)\s+((?:the |my )?[a-z][a-z' -]{2,30}?)(?=[,.!?;:]|\s+(?:and|but|because|so|when|if)\b|$)/gi)) {
      const subj = m[2]!.toLowerCase().replace(/^(?:the|my) /, '').trim();
      if (/^(?:it|that|this|you|them|him|her|people|when|how|being)\b/.test(subj)) continue;
      const neg = /hate|can't|cannot|despise|loathe|detest/i.test(m[1]!);
      push({ kind: 'opinion', subject: subj, value: neg ? 'negative' : 'positive', statement: clip(s) });
    }
  }
  return out;
}

/** Facts the World Bible states (seeded into the ledger at adoption). */
export function bibleFacts(bible: WorldBible): Fact[] {
  const out: Fact[] = [];
  const self = bible.self;
  if (self.age !== null) out.push({ kind: 'age', subject: 'self', value: String(self.age), statement: `World Bible: ${self.name} is ${self.age}` });
  const years = /\bfor (\d{1,2}) years\b/i.exec(self.background);
  if (years) out.push({ kind: 'event', subject: 'career years', value: years[1]!, statement: `World Bible: ${self.background.slice(0, 160)}` });
  out.push({ kind: 'place', subject: 'home', value: bible.place.city, statement: `World Bible: lives in ${bible.place.city}${bible.place.region ? `, ${bible.place.region}` : ''}` });
  for (const c of bible.cast) {
    const rel = normRelation(c.relation);
    if (rel === 'shopkeeper') continue;
    out.push({ kind: PETS.has(rel) ? 'pet' : 'person', subject: rel, value: c.name, statement: `World Bible: ${c.name}, ${c.relation}${c.age ? `, ${c.age}` : ''}` });
  }
  return out;
}

const genderOf = (rel: string): Gender => GENDER_OF[rel] ?? GENDER_OF[rel.replace(/^late /, '')] ?? 'n';

function similarName(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return true;
  let p = 0;
  while (p < Math.min(x.length, y.length) && x[p] === y[p]) p++;
  return p >= 3 && Math.abs(x.length - y.length) <= 3;
}

export interface Contradiction {
  readonly fact: Fact;
  readonly against: LedgerFact;
  readonly message: string;
}

/** New facts that contradict the ledger. `at` ages the recorded age forward (people have birthdays). */
export function contradictions(facts: readonly Fact[], ledger: readonly LedgerFact[], at: Date, place?: { city: string; region: string | null; country: string } | null): Contradiction[] {
  const out: Contradiction[] = [];
  const say = (f: LedgerFact) => `${f.statement.replace(/^World Bible: /, 'the World Bible says ')}`;
  for (const f of facts) {
    for (const l of ledger) {
      let message: string | null = null;
      if ((f.kind === 'person' || f.kind === 'pet') && (l.kind === 'person' || l.kind === 'pet')) {
        const sameName = f.value.toLowerCase() === l.value.toLowerCase();
        const close = !sameName && similarName(f.value, l.value);
        const fr = normRelation(f.subject);
        const lr = normRelation(l.subject);
        if (sameName && fr !== lr && !(f.kind === 'person' && l.kind === 'person' && (fr === 'friend' || lr === 'friend' || fr === 'neighbour' || lr === 'neighbour') && genderOf(fr) === 'n')) {
          message = `${f.value} is your ${lr}, not your ${fr} (${say(l)}).`;
        } else if (close && fr !== lr && genderOf(fr) !== 'n' && genderOf(lr) !== 'n' && genderOf(fr) !== genderOf(lr)) {
          message = `"my ${fr} ${f.value}" looks like ${l.value}, your ${lr}, changed (${say(l)}). Keep the cast consistent.`;
        } else if (UNIQUE.has(fr) && fr === lr && !sameName) {
          message = `your ${fr} is ${l.value}, not ${f.value} (${say(l)}).`;
        }
      } else if (f.kind === 'age' && l.kind === 'age' && f.subject === l.subject) {
        const years = Math.floor((at.getTime() - l.statedAt.getTime()) / (365.25 * 86_400_000));
        const expected = Number(l.value) + Math.max(0, years);
        const got = Number(f.value);
        if (got < Number(l.value) || got > expected + 1) message = `you're ${expected}${years > 0 ? ' by now' : ''}, not ${got} (${say(l)}).`;
      } else if (f.kind === 'event' && l.kind === 'event' && f.subject === l.subject && f.value !== l.value) {
        message = `${f.subject}: ${f.value} now, ${l.value} before (${say(l)}).`;
      } else if (f.kind === 'possession' && l.kind === 'possession' && f.subject === l.subject && f.value !== l.value && !/\bnew\b/i.test(f.statement)) {
        message = `you drive ${l.value}, not ${f.value} (${say(l)}); a new ${f.subject} needs its own story beat.`;
      } else if (f.kind === 'opinion' && l.kind === 'opinion' && f.subject === l.subject && f.value !== l.value && !/\b(?:used to|changed my mind|now i|these days)\b/i.test(f.statement)) {
        message = `you said you ${l.value === 'positive' ? 'love' : "can't stand"} ${l.subject} before (${say(l)}); a change of heart needs its own story.`;
      }
      if (message) {
        out.push({ fact: f, against: l, message });
        break;
      }
    }
    if (f.kind === 'place' && place) {
      const v = f.value.toLowerCase();
      const known = [place.city, place.region ?? '', place.country].map((x) => x.toLowerCase()).filter(Boolean);
      if (!known.some((k) => k.includes(v) || v.includes(k))) {
        const l = ledger.find((x) => x.kind === 'place') ?? null;
        out.push({ fact: f, against: l ?? ({ id: 'bible', kind: 'place', subject: 'home', value: place.city, statement: `World Bible: lives in ${place.city}`, sourceType: 'bible', sourceId: null, statedAt: at } as LedgerFact), message: `you live in ${place.city}, not ${f.value} (World Bible).` });
      }
    }
  }
  return out;
}

export function continuityChecks(found: readonly Contradiction[]): QcCheck[] {
  if (!found.length) return [{ check: 'continuity', pass: true, severity: 'minor', message: 'no contradictions with the fact ledger' }];
  return found.map((c) => ({ check: 'continuity', pass: false, severity: 'major', message: `Continuity: ${c.message}`, location: c.fact.statement.slice(0, 120) }));
}

/** Validates the continuity-keeper's structured output. */
export function parseFacts(v: unknown): { facts: Fact[] } {
  const arr = v && typeof v === 'object' && Array.isArray((v as { facts?: unknown }).facts) ? (v as { facts: unknown[] }).facts : null;
  if (!arr) throw new Error('expected {"facts": [...]}');
  const out: Fact[] = [];
  for (const raw of arr.slice(0, 40)) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const kind = FACT_KINDS.includes(o.kind as FactKind) ? (o.kind as FactKind) : null;
    const subject = typeof o.subject === 'string' ? o.subject.trim().toLowerCase().slice(0, 60) : '';
    const value = typeof o.value === 'string' || typeof o.value === 'number' ? String(o.value).trim().slice(0, 80) : '';
    const statement = typeof o.statement === 'string' ? o.statement.trim().slice(0, 200) : '';
    if (!kind || !subject || !value) continue;
    out.push({ kind, subject: kind === 'person' || kind === 'pet' ? normRelation(subject) : subject, value, statement: statement || `${subject}: ${value}` });
  }
  return { facts: out };
}

export const FACTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['facts'],
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'subject', 'value', 'statement'],
        properties: { kind: { type: 'string', enum: FACT_KINDS }, subject: { type: 'string' }, value: { type: 'string' }, statement: { type: 'string' } },
      },
    },
  },
} as const;

/** Union of rule facts and model facts (rules first; the model can't drop a pattern-found fact). */
export function mergeFacts(a: readonly Fact[], b: readonly Fact[]): Fact[] {
  const out = [...a];
  for (const f of b) if (!out.some((x) => x.kind === f.kind && x.subject === f.subject && x.value.toLowerCase() === f.value.toLowerCase())) out.push(f);
  return out;
}
