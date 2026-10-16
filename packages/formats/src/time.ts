/** Small time-zone helpers (persona-local days and times) for the Stories engine. */

export const DAY_MS = 86_400_000;
export const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

/** Monday 00:00 UTC of the week containing `d`. */
export function mondayOf(d: Date): Date {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x;
}

export function safeTimeZone(tz: string | null | undefined): string {
  try {
    if (tz) {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return tz;
    }
  } catch {
    /* fall through */
  }
  return 'UTC';
}

/** Offset of `timeZone` from UTC at `at`, in ms (local = utc + offset). */
export function tzOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: safeTimeZone(timeZone),
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** The persona-local calendar date (YYYY-MM-DD) at `at`. */
export const localDate = (at: Date, timeZone: string): string => isoDate(new Date(at.getTime() + tzOffsetMs(at, timeZone)));

/** Local HH:MM at `at`. */
export function localTime(at: Date, timeZone: string): string {
  const d = new Date(at.getTime() + tzOffsetMs(at, timeZone));
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** The UTC instant of local `date` (YYYY-MM-DD) at `h:m` in `timeZone`. */
export function zonedAt(date: string, h: number, m: number, timeZone: string): Date {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, mo - 1, d, h, m);
  const first = guess - tzOffsetMs(new Date(guess), timeZone);
  return new Date(guess - tzOffsetMs(new Date(first), timeZone));
}

/** [start, end) of a persona-local day, in UTC. */
export function localDayRange(date: string, timeZone: string): { from: Date; to: Date } {
  const next = isoDate(new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS));
  return { from: zonedAt(date, 0, 0, timeZone), to: zonedAt(next, 0, 0, timeZone) };
}

/** 0 = Monday … 6 = Sunday, for a YYYY-MM-DD date. */
export const weekdayOf = (date: string): number => (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
