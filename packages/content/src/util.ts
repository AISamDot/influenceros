import { createHash } from 'node:crypto';

/** Small text, hashing and time-zone helpers shared by the content package. Pure, no I/O. */

export const words = (s: string): string[] => s.trim().split(/\s+/).filter(Boolean);
export const wordCount = (s: string): number => words(s).length;

/** Sentences and lines, in order (a line break always ends a sentence). */
export function sentences(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=["'“(]?[A-Z0-9$])/))
    .map((s) => s.trim())
    .filter(Boolean);
}

export const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
export const clamp01 = (n: number): number => clamp(Number.isFinite(n) ? n : 0, 0, 1);

export function hashInt(s: string): number {
  return createHash('sha256').update(s).digest().readUInt32BE(0);
}

export function pick<T>(list: readonly T[], seed: string): T {
  return list[hashInt(seed) % list.length]!;
}

export function stableStringify(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === 'object' && !Array.isArray(val) && !(val instanceof Date)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : val,
  );
}

export const asString = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
export const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
export const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Lower-cases the first letter of a phrase ("A $40 week" → "a $40 week"), leaving "I", acronyms and names like "POV" alone. */
export const lowerFirst = (s: string): string => (/^(?:[A-Z][a-z]|A\s)/.test(s) && !/^I\s/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s);
export const upperFirst = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** "Zero-Based Budget Sheet" → "zero-based-budget-sheet". */
export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'item'
  );
}

const KEYWORD_STOP = new Set(['the', 'a', 'an', 'my', 'your', 'free', 'and', 'of', 'for', 'to', 'with', 'in', 'on', 'how', 'what', 'why']);
/** A comment keyword from a phrase: the first meaningful word, upper case, 3–10 letters ("Budget Sheet" → "BUDGET"). */
export function keywordFrom(phrase: string, fallback = 'GUIDE'): string {
  const w = (phrase.toLowerCase().match(/[a-z]+/g) ?? []).find((x) => x.length >= 3 && !KEYWORD_STOP.has(x));
  return (w ?? fallback).slice(0, 10).toUpperCase();
}

/** Jaccard similarity of two texts' word sets (0–1). */
export function similarity(a: string, b: string): number {
  const A = new Set(a.toLowerCase().match(/[a-z0-9']+/g) ?? []);
  const B = new Set(b.toLowerCase().match(/[a-z0-9']+/g) ?? []);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter);
}

// ─── Time zones (posting windows are in the persona's local time; slot_at is stored in UTC) ───

export function safeTimeZone(tz: string | null | undefined): string {
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

/** Offset of `timeZone` from UTC at instant `at`, in ms (positive east of UTC). */
export function tzOffsetMs(at: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(at).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** The UTC instant of a wall-clock time in `timeZone` (handles DST by re-checking the offset). */
export function zonedToUtc(y: number, month0: number, d: number, h: number, min: number, timeZone: string): Date {
  const guess = Date.UTC(y, month0, d, h, min);
  const off1 = tzOffsetMs(new Date(guess), timeZone);
  let t = guess - off1;
  const off2 = tzOffsetMs(new Date(t), timeZone);
  if (off2 !== off1) t = guess - off2;
  return new Date(t);
}

/** Monday 00:00 UTC of the week containing `d`. */
export function mondayUtc(d: Date): Date {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x;
}

export const DAY_MS = 86_400_000;
export const isoDate = (d: Date): string => d.toISOString().slice(0, 10);
