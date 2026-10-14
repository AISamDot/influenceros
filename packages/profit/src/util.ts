/** Small, dependency-free helpers shared by the Profit Engine modules. */

export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;
/** Average weeks per month (52 / 12), used to turn weekly deltas into monthly impact. */
export const WEEKS_PER_MONTH = 52 / 12;

/** Monday 00:00 UTC of the week containing `d`. */
export function mondayOf(d: Date): Date {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x;
}

export const addDays = (d: Date, n: number): Date => new Date(d.getTime() + n * DAY_MS);
export const isoDate = (d: Date): string => d.toISOString().slice(0, 10);
/** YYYY-MM (UTC). */
export const monthKey = (d: Date): string => d.toISOString().slice(0, 7);
export const startOfMonth = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
export const startOfNextMonth = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
export const startOfDay = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export const round = (n: number): number => Math.round(Number.isFinite(n) ? n : 0);
export const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
export const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
export const mean = (xs: readonly number[]): number => (xs.length ? sum(xs) / xs.length : 0);

/** Linear-interpolated quantile of an already sorted array. */
export function quantileSorted(sorted: readonly number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * clamp(q, 0, 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** Deterministic PRNG (mulberry32) so forecasts are reproducible for a given seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** FNV-1a hash of a string, for seeding. */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Standard normal draw (Box–Muller) from a uniform source. */
export function normal(rand: () => number): number {
  let u = 0;
  while (u <= 1e-12) u = rand();
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Splits `total` into integer parts proportional to `weights` (largest remainder), so the parts always sum to
 * `total`. `min` / `max` per key are respected when they are feasible.
 */
export function apportion<K extends string>(
  total: number,
  weights: Readonly<Record<K, number>>,
  bounds: { min?: Partial<Record<K, number>>; max?: Partial<Record<K, number>> } = {},
): Record<K, number> {
  const keys = Object.keys(weights) as K[];
  const wsum = sum(keys.map((k) => Math.max(0, weights[k])));
  const raw = keys.map((k) => (wsum > 0 ? (Math.max(0, weights[k]) / wsum) * total : total / keys.length));
  const out = Object.fromEntries(keys.map((k, i) => [k, Math.floor(raw[i]!)])) as Record<K, number>;
  let left = total - sum(keys.map((k) => out[k]));
  const order = keys.map((k, i) => ({ k, r: raw[i]! - Math.floor(raw[i]!) })).sort((a, b) => b.r - a.r);
  for (let i = 0; left > 0; i = (i + 1) % order.length, left--) out[order[i]!.k] += 1;
  // Enforce bounds by moving units from keys above their floor to keys below it (and back for maxima).
  const min = (k: K) => bounds.min?.[k] ?? 0;
  const max = (k: K) => bounds.max?.[k] ?? Infinity;
  for (let guard = 0; guard < total * 4 + 8; guard++) {
    const low = keys.find((k) => out[k] < min(k));
    const high = keys.find((k) => out[k] > max(k));
    if (!low && !high) break;
    if (low) {
      const donor = [...keys].sort((a, b) => out[b] - min(b) - (out[a] - min(a))).find((k) => k !== low && out[k] > min(k));
      if (!donor) break;
      out[donor] -= 1;
      out[low] += 1;
    } else if (high) {
      const taker = [...keys].sort((a, b) => out[a] - out[b]).find((k) => k !== high && out[k] < max(k));
      if (!taker) break;
      out[high] -= 1;
      out[taker] += 1;
    }
  }
  return out;
}
