import type { Season, TimeOfDay } from '@troupe/agents';

/**
 * Local time, sun times and seasons. Sunrise and sunset come from the standard sunrise equation (NOAA-style, about a
 * minute of error), so grounding knows when it is dark even without a live weather call.
 */

export interface LocalParts {
  readonly date: string; // YYYY-MM-DD
  readonly time: string; // HH:MM
  readonly weekday: string; // Monday …
  readonly year: number;
  readonly month: number; // 1–12
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(timezone: string): Intl.DateTimeFormat {
  let f = fmtCache.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'long',
      hourCycle: 'h23',
    });
    fmtCache.set(timezone, f);
  }
  return f;
}

export function safeTimezone(tz: string | null | undefined): string {
  if (!tz) return 'UTC';
  try {
    fmt(tz);
    return tz;
  } catch {
    return 'UTC';
  }
}

export function localParts(at: Date, timezone: string): LocalParts {
  const parts = Object.fromEntries(fmt(safeTimezone(timezone)).formatToParts(at).map((p) => [p.type, p.value]));
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  const pad = (n: number) => String(n).padStart(2, '0');
  return { date: `${year}-${pad(month)}-${pad(day)}`, time: `${pad(hour)}:${pad(minute)}`, weekday: String(parts.weekday), year, month, day, hour, minute };
}

export const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

const RAD = Math.PI / 180;

/** Sunrise and sunset (UTC instants) for a local calendar date at a place; null on polar day / night. */
export function sunTimes(localDate: string, lat: number, lon: number): { sunrise: Date | null; sunset: Date | null } {
  const [y, mo, d] = localDate.split('-').map(Number);
  const jdNoon = Date.UTC(y!, mo! - 1, d!, 12) / 86_400_000 + 2440587.5;
  const n = Math.round(jdNoon - 2451545.0 + 0.0008);
  const jStar = n - lon / 360;
  const M = (357.5291 + 0.98560028 * jStar) % 360;
  const C = 1.9148 * Math.sin(M * RAD) + 0.02 * Math.sin(2 * M * RAD) + 0.0003 * Math.sin(3 * M * RAD);
  const lambda = (M + C + 180 + 102.9372) % 360;
  const jTransit = 2451545.0 + jStar + 0.0053 * Math.sin(M * RAD) - 0.0069 * Math.sin(2 * lambda * RAD);
  const sinDec = Math.sin(lambda * RAD) * Math.sin(23.4397 * RAD);
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosW = (Math.sin(-0.833 * RAD) - Math.sin(lat * RAD) * sinDec) / (Math.cos(lat * RAD) * cosDec);
  if (cosW > 1 || cosW < -1) return { sunrise: null, sunset: null };
  const w = Math.acos(cosW) / RAD;
  const toDate = (j: number) => new Date((j - 2440587.5) * 86_400_000);
  return { sunrise: toDate(jTransit - w / 360), sunset: toDate(jTransit + w / 360) };
}

/** Meteorological seasons by hemisphere; wet / dry in the tropics. */
export function seasonOf(month: number, lat: number): Season {
  if (Math.abs(lat) < 20) {
    const wetNorth = month >= 5 && month <= 10;
    return (lat >= 0 ? wetNorth : !wetNorth) ? 'wet' : 'dry';
  }
  const north: Season = month === 12 || month <= 2 ? 'winter' : month <= 5 ? 'spring' : month <= 8 ? 'summer' : 'autumn';
  if (lat >= 0) return north;
  return ({ winter: 'summer', summer: 'winter', spring: 'autumn', autumn: 'spring' } as const)[north as 'winter' | 'summer' | 'spring' | 'autumn'];
}

/** Coarse time of day from the local clock, with dawn tied to sunrise when it is known. */
export function timeOfDayOf(localMinutes: number, sunriseMin: number | null): TimeOfDay {
  if (sunriseMin !== null && Math.abs(localMinutes - sunriseMin) <= 45 && localMinutes < 11 * 60) return 'dawn';
  if (localMinutes < 5 * 60) return 'night';
  if (localMinutes < 7 * 60) return sunriseMin !== null && localMinutes < sunriseMin - 45 ? 'night' : 'dawn';
  if (localMinutes < 11 * 60) return 'morning';
  if (localMinutes < 14 * 60) return 'midday';
  if (localMinutes < 17 * 60) return 'afternoon';
  if (localMinutes < 21 * 60) return 'evening';
  return 'night';
}

/** Climate estimate for a month from the January / July means (cosine between them; peak mid-July / mid-January). */
export function climateTempC(month: number, day: number, janC: number, julC: number): number {
  const doy = (month - 1) * 30.4 + day;
  const phase = Math.cos(((doy - 196) / 365) * 2 * Math.PI); // 1 in mid-July, -1 in mid-January
  return Math.round(((janC + julC) / 2 + ((julC - janC) / 2) * phase) * 10) / 10;
}

/** Monday 00:00 UTC of the week containing `d`. */
export function mondayOf(d: Date): Date {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (x.getUTCDay() + 6) % 7;
  return new Date(x.getTime() - dow * 86_400_000);
}

export const isoDay = (d: Date): string => d.toISOString().slice(0, 10);
