import type { CountryCode } from './geo';

/**
 * Local holidays and events per country (PRD §3.14.1: "Thanksgiving vs Bonfire Night"). Each holiday has a rule
 * that gives its date in a year, the countries that keep it, how long before it people talk about it (`leadDays`),
 * and the words that refer to it in a script. Generic: no brands.
 */

export interface HolidayDef {
  readonly key: string;
  readonly name: string;
  readonly countries: readonly CountryCode[] | 'all';
  /** Days before the date when talking about it is natural (Christmas runs long). */
  readonly leadDays: number;
  /** Days after it when it can still be mentioned as "this week's". */
  readonly afterDays: number;
  readonly words: RegExp;
  date(year: number, cc: CountryCode): string | null;
}

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const fixed = (m: number, d: number) => (y: number) => ymd(y, m, d);

/** The nth weekday (0 = Sunday) of a month; n = -1 is the last. */
export function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  if (n > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    const day = 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
    return ymd(year, month, day);
  }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lastDow = new Date(Date.UTC(year, month - 1, lastDay)).getUTCDay();
  return ymd(year, month, lastDay - ((lastDow - weekday + 7) % 7));
}

/** Western Easter Sunday (anonymous Gregorian algorithm). */
export function easter(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return ymd(year, month, day);
}

export const addDays = (iso: string, n: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

const ANGLO: readonly CountryCode[] = ['GB', 'US', 'CA', 'IE', 'AU', 'NZ'];

export const HOLIDAYS: readonly HolidayDef[] = [
  { key: 'new_year', name: "New Year's Day", countries: 'all', leadDays: 10, afterDays: 10, words: /(?<!in the )\bnew year(?:'s)?(?! eve)(?!'s eve)\b/i, date: fixed(1, 1) },
  { key: 'burns_night', name: 'Burns Night', countries: ['GB'], leadDays: 10, afterDays: 1, words: /\bburns night\b/i, date: fixed(1, 25) },
  { key: 'mlk_day', name: 'Martin Luther King Jr. Day', countries: ['US'], leadDays: 5, afterDays: 1, words: /\bmlk day\b|\bmartin luther king (?:jr\.? )?day\b/i, date: (y) => nthWeekday(y, 1, 1, 3) },
  { key: 'australia_day', name: 'Australia Day', countries: ['AU'], leadDays: 7, afterDays: 1, words: /\baustralia day\b/i, date: fixed(1, 26) },
  { key: 'valentines', name: "Valentine's Day", countries: 'all', leadDays: 18, afterDays: 2, words: /\bvalentine'?s?\b/i, date: fixed(2, 14) },
  { key: 'presidents_day', name: "Presidents' Day", countries: ['US'], leadDays: 5, afterDays: 1, words: /\bpresidents'? day\b/i, date: (y) => nthWeekday(y, 2, 1, 3) },
  { key: 'pancake_day', name: 'Pancake Day', countries: ['GB', 'IE', 'CA', 'AU', 'NZ'], leadDays: 10, afterDays: 1, words: /\bpancake day\b|\bshrove tuesday\b/i, date: (y) => addDays(easter(y), -47) },
  { key: 'st_patricks', name: "St Patrick's Day", countries: ANGLO, leadDays: 14, afterDays: 1, words: /\bst\.? patrick'?s(?: day)?\b|\bpaddy'?s day\b/i, date: fixed(3, 17) },
  {
    key: 'mothers_day',
    name: "Mother's Day",
    countries: 'all',
    leadDays: 21,
    afterDays: 2,
    words: /\bmother'?s day\b|\bmothering sunday\b/i,
    date: (y, cc) => (cc === 'GB' || cc === 'IE' ? addDays(easter(y), -21) : nthWeekday(y, 5, 0, 2)),
  },
  { key: 'easter', name: 'Easter', countries: 'all', leadDays: 25, afterDays: 3, words: /\beaster\b|\bgood friday\b|\bhot cross buns?\b/i, date: (y) => easter(y) },
  { key: 'anzac_day', name: 'Anzac Day', countries: ['AU', 'NZ'], leadDays: 7, afterDays: 1, words: /\banzac day\b/i, date: fixed(4, 25) },
  { key: 'may_day', name: 'Early May bank holiday', countries: ['GB', 'IE'], leadDays: 7, afterDays: 1, words: /\bmay day\b|\bmay bank holiday\b/i, date: (y) => nthWeekday(y, 5, 1, 1) },
  { key: 'victoria_day', name: 'Victoria Day', countries: ['CA'], leadDays: 7, afterDays: 1, words: /\bvictoria day\b|\bmay two-four\b/i, date: (y) => addDays(ymd(y, 5, 24), -((new Date(Date.UTC(y, 4, 24)).getUTCDay() + 6) % 7)) },
  { key: 'memorial_day', name: 'Memorial Day', countries: ['US'], leadDays: 10, afterDays: 1, words: /\bmemorial day\b/i, date: (y) => nthWeekday(y, 5, 1, -1) },
  { key: 'spring_bank', name: 'Spring bank holiday', countries: ['GB'], leadDays: 7, afterDays: 1, words: /\bspring bank holiday\b|\bwhitsun\b/i, date: (y) => nthWeekday(y, 5, 1, -1) },
  { key: 'fathers_day', name: "Father's Day", countries: 'all', leadDays: 18, afterDays: 2, words: /\bfather'?s day\b/i, date: (y, cc) => (cc === 'AU' || cc === 'NZ' ? nthWeekday(y, 9, 0, 1) : nthWeekday(y, 6, 0, 3)) },
  { key: 'juneteenth', name: 'Juneteenth', countries: ['US'], leadDays: 7, afterDays: 1, words: /\bjuneteenth\b/i, date: fixed(6, 19) },
  { key: 'canada_day', name: 'Canada Day', countries: ['CA'], leadDays: 10, afterDays: 1, words: /\bcanada day\b/i, date: fixed(7, 1) },
  { key: 'july_4', name: 'Independence Day (Fourth of July)', countries: ['US'], leadDays: 18, afterDays: 2, words: /\bfourth of july\b|\b4th of july\b|\bjuly 4(?:th)?\b|\bindependence day\b/i, date: fixed(7, 4) },
  { key: 'summer_bank', name: 'Summer bank holiday', countries: ['GB'], leadDays: 7, afterDays: 1, words: /\baugust bank holiday\b|\bsummer bank holiday\b/i, date: (y) => nthWeekday(y, 8, 1, -1) },
  { key: 'labor_day', name: 'Labor Day', countries: ['US', 'CA'], leadDays: 10, afterDays: 1, words: /\blabou?r day\b/i, date: (y) => nthWeekday(y, 9, 1, 1) },
  { key: 'thanksgiving', name: 'Thanksgiving', countries: ['US', 'CA'], leadDays: 28, afterDays: 3, words: /\bthanksgiving\b/i, date: (y, cc) => (cc === 'CA' ? nthWeekday(y, 10, 1, 2) : nthWeekday(y, 11, 4, 4)) },
  { key: 'halloween', name: 'Halloween', countries: ANGLO, leadDays: 28, afterDays: 1, words: /\bhalloween\b|\btrick[- ]or[- ]treat(?:ing|ers)?\b/i, date: fixed(10, 31) },
  { key: 'bonfire_night', name: 'Bonfire Night', countries: ['GB'], leadDays: 18, afterDays: 2, words: /\bbonfire night\b|\bguy fawkes(?: night)?\b/i, date: fixed(11, 5) },
  { key: 'veterans_day', name: 'Veterans Day', countries: ['US'], leadDays: 5, afterDays: 1, words: /\bveterans'? day\b/i, date: fixed(11, 11) },
  { key: 'remembrance', name: 'Remembrance Sunday', countries: ['GB', 'CA', 'AU', 'NZ', 'IE'], leadDays: 14, afterDays: 1, words: /\bremembrance (?:sunday|day)\b|\bpoppy appeal\b/i, date: (y, cc) => (cc === 'GB' || cc === 'IE' ? nthWeekday(y, 11, 0, 2) : `${y}-11-11`) },
  { key: 'black_friday', name: 'Black Friday', countries: ['US', 'GB', 'CA', 'AU', 'IE'], leadDays: 14, afterDays: 4, words: /\bblack friday\b|\bcyber monday\b/i, date: (y) => addDays(nthWeekday(y, 11, 4, 4), 1) },
  { key: 'christmas', name: 'Christmas Day', countries: 'all', leadDays: 50, afterDays: 6, words: /\bchristmas\b|\bxmas\b|\bfestive season\b/i, date: fixed(12, 25) },
  { key: 'boxing_day', name: 'Boxing Day', countries: ['GB', 'IE', 'CA', 'AU', 'NZ'], leadDays: 20, afterDays: 3, words: /\bboxing day\b/i, date: fixed(12, 26) },
  { key: 'new_years_eve', name: "New Year's Eve", countries: 'all', leadDays: 14, afterDays: 1, words: /\bnew year'?s eve\b|\bnye\b|\bhogmanay\b/i, date: fixed(12, 31) },
];

export const observes = (h: HolidayDef, cc: CountryCode): boolean => h.countries === 'all' || h.countries.includes(cc);

/** The holiday's nearest occurrence around `localDate`: days until the next one and days since the last one. */
export function occurrence(h: HolidayDef, localDate: string, cc: CountryCode): { next: string; until: number; since: number } | null {
  const y = Number(localDate.slice(0, 4));
  const dates = [y - 1, y, y + 1].map((yy) => h.date(yy, cc)).filter((d): d is string => !!d);
  if (!dates.length) return null;
  const next = dates.find((d) => daysBetween(localDate, d) >= 0) ?? dates[dates.length - 1]!;
  const prev = [...dates].reverse().find((d) => daysBetween(d, localDate) >= 0) ?? dates[0]!;
  return { next, until: daysBetween(localDate, next), since: daysBetween(prev, localDate) };
}

export interface LocalEvent {
  readonly name: string;
  readonly month: number;
  readonly day: number;
}

/** Holidays (and the World Bible's own local events) within `ahead` days of the local date, or `behind` days before it. */
export function holidaysNear(localDate: string, cc: CountryCode, opts: { ahead?: number; behind?: number; local?: readonly LocalEvent[] } = {}): string[] {
  const ahead = opts.ahead ?? 10;
  const behind = opts.behind ?? 1;
  const out: Array<{ label: string; d: number }> = [];
  const label = (name: string, date: string, d: number) => {
    const dow = new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
    const when = d === 0 ? 'today' : d === 1 ? 'tomorrow' : d === -1 ? 'yesterday' : d < 0 ? `${-d} days ago` : `${dow} ${Number(date.slice(8))} ${new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' })}`;
    return `${name} (${when})`;
  };
  for (const h of HOLIDAYS) {
    if (!observes(h, cc)) continue;
    const o = occurrence(h, localDate, cc);
    if (!o) continue;
    if (o.until <= ahead) out.push({ label: label(h.name, o.next, o.until), d: o.until });
    else if (o.since > 0 && o.since <= behind) out.push({ label: label(h.name, addDays(localDate, -o.since), -o.since), d: -o.since });
  }
  const y = Number(localDate.slice(0, 4));
  for (const e of opts.local ?? []) {
    for (const yy of [y, y + 1]) {
      const date = ymd(yy, e.month, e.day);
      const d = daysBetween(localDate, date);
      if (d >= -behind && d <= ahead) out.push({ label: label(e.name, date, d), d });
    }
  }
  return out.sort((a, b) => a.d - b.d).map((x) => x.label);
}

/** The holiday names a country keeps (World Bible "local holidays"). */
export function holidayCalendar(cc: CountryCode, year: number): Array<{ name: string; date: string }> {
  return HOLIDAYS.filter((h) => observes(h, cc))
    .map((h) => ({ name: h.name, date: h.date(year, cc) ?? '' }))
    .filter((x) => x.date)
    .sort((a, b) => a.date.localeCompare(b.date));
}
