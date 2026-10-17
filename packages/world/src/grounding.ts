import type { Grounding, QcCheck } from '@troupe/agents';
import type { WeatherNow } from '@troupe/providers';
import { HOLIDAYS, holidaysNear, observes, occurrence } from './holidays';
import type { WorldBible } from './model';
import { climateTempC, localParts, minutesOf, seasonOf, sunTimes, timeOfDayOf } from './time';

/**
 * Real-time grounding (PRD §3.14.2): the persona's local date, season, time of day, sun times, weather and nearby
 * holidays, as data and as the `block` every script and visual prompt carries. And the QC checks that hold wardrobe,
 * light and topical references to it ("no summer dresses in a December Ohio post, no daylight at 6 pm in a
 * Yorkshire November").
 */

/** Live weather is used when the moment is within this window of now; further out, the climate estimate. */
export const LIVE_WINDOW_MS = 3 * 3_600_000;

export type LiveWeather = WeatherNow & { readonly source: 'open-meteo' | 'fake' };

export function computeGrounding(personaId: string, bible: WorldBible, at: Date, live: LiveWeather | null): Grounding {
  const p = bible.place;
  const tz = p.timezone;
  const lp = localParts(at, tz);
  const lat = p.lat ?? 51.5;
  const lon = p.lon ?? 0;
  const sun = p.lat !== null && p.lon !== null ? sunTimes(lp.date, lat, lon) : { sunrise: null, sunset: null };
  const sunrise = sun.sunrise ? localParts(sun.sunrise, tz).time : null;
  const sunset = sun.sunset ? localParts(sun.sunset, tz).time : null;
  const season = seasonOf(lp.month, lat);
  const nowMin = lp.hour * 60 + lp.minute;
  const isDay = sun.sunrise && sun.sunset ? at.getTime() >= sun.sunrise.getTime() && at.getTime() < sun.sunset.getTime() : lp.hour >= 7 && lp.hour < 18;
  const timeOfDay = timeOfDayOf(nowMin, sunrise ? minutesOf(sunrise) : null);
  const weather: Grounding['weather'] = live
    ? { summary: live.summary, tempC: Math.round(live.tempC * 10) / 10, precipitation: live.precipitationMm > 0, isDay, source: live.source }
    : { summary: `typical ${monthName(lp.month)} weather`, tempC: climateTempC(lp.month, lp.day, p.janC, p.julC), precipitation: false, isDay, source: 'climate' };
  const holidays = holidaysNear(lp.date, p.countryCode, { ahead: 10, behind: 1, local: bible.localEvents });
  const light = isDay
    ? sunset && minutesOf(sunset) - nowMin <= 60 && minutesOf(sunset) - nowMin >= 0
      ? `daylight fading (sunset ${sunset})`
      : `daylight${sunset ? ` (sunset ${sunset})` : ''}`
    : `dark outside${sunrise && nowMin < minutesOf(sunrise) ? ` (sunrise ${sunrise})` : sunset ? ` (sunset was ${sunset})` : ''}; lamps on, window light is night`;
  const place = `${p.city}${p.region ? `, ${p.region}` : ''}, ${p.country}`;
  const block = [
    `Local moment for ${bible.self.name}: ${lp.weekday} ${lp.date}, ${lp.time} in ${place} (${tz}).`,
    `${cap(season)}, ${timeOfDay}; ${light}.`,
    weather ? `Weather: ${weather.summary}, ${Math.round(weather.tempC)}°C${weather.source === 'climate' ? ' (seasonal norm)' : ''}.` : '',
    holidays.length ? `Nearby: ${holidays.join(', ')}.` : '',
    bible.self.era ? `Period setting: ${bible.self.era}; no modern objects or references.` : '',
    'Wardrobe, light at the window and topical references must match this.',
  ]
    .filter(Boolean)
    .join(' ');
  return {
    personaId,
    timezone: tz,
    localDate: lp.date,
    localTime: lp.time,
    weekday: lp.weekday,
    season,
    timeOfDay,
    place: { city: p.city, region: p.region, country: p.country, lat: p.lat, lon: p.lon },
    weather,
    sunrise,
    sunset,
    holidays,
    block,
  };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const monthName = (m: number) => new Date(Date.UTC(2026, m - 1, 15)).toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' });

// ─── The grounding checks ───

const WARM_CLOTHES = /\b(?:summer dress(?:es)?|sundress(?:es)?|sun dress|bikini|swimsuit|swimming costume|swimwear|flip[- ]?flops|crop top|tank top|strappy top|sleeveless (?:dress|top|blouse)|linen shorts|(?<!youtube )shorts|sandals|sun ?hat)\b/i;
const COLD_CLOTHES = /\b(?:heavy coat|winter coat|parka|puffer(?: jacket| coat)?|down jacket|woolly hat|wooly hat|bobble hat|beanie|thick scarf|scarf and gloves|gloves|mittens|snow boots|thermals?|chunky knit|fleece-lined)\b/i;
const DAYLIGHT = /\b(?:sunlight|sunlit|sun-drenched|sunshine|sunny|daylight|broad daylight|midday sun|afternoon sun|morning sun|sun streaming|sun pours?|blue skies?|bright sun)\b/i;
const DARKNESS = /\b(?:moonlight|moonlit|night sky|starry|stars out|streetlights?|after dark|pitch dark|pitch black|dark outside|lamplit night)\b/i;
const GOLDEN = /\bgolden hour\b/i;
const SNOW = /\b(?:snow|snowy|snowing|snowfall|snowman|frost(?:y)?|icy roads?)\b/i;
const RAIN = /\b(?:raining|pouring|rainy|drizzle|downpour|umbrella weather)\b/i;
const SEASON_CLAIM =
  /\b(?:(?:this|today'?s|it'?s|what a|lovely|gorgeous|glorious|hot|cold|freezing|crisp|long|dark)\s+(summer|winter|spring|autumn|fall)\b|(?<!(?:last|next|every|that|one|a)\s)\b(summer|winter|spring|autumn|fall)\s+(?:day|morning|evening|afternoon|night|sunshine|heatwave|heat|chill|weather))\b/i;
const GREETING_MORNING = /\bgood morning\b/i;
const GREETING_EVENING = /\b(?:good evening|good night|night,? all)\b/i;
const PAST_OR_FUTURE = /\b(?:last|next|every|each|one|that|remember|years? ago|when i was|back in|used to)\b[^.!?]{0,40}$/i;

/** A season word in a claim, normalised (fall → autumn). */
const normSeason = (s: string) => (s.toLowerCase() === 'fall' ? 'autumn' : s.toLowerCase());

function find(re: RegExp, text: string): { word: string; before: string } | null {
  const m = re.exec(text);
  if (!m) return null;
  return { word: m[0], before: text.slice(Math.max(0, m.index - 60), m.index) };
}

/**
 * Wardrobe, light, weather, season and holiday checks against the grounding. Failing checks are 'major' (they block
 * like a Q1 defect and go to the maker's fix loop); small mismatches are 'minor'. Always returns one passing
 * `world_grounding` check when nothing failed, so the QC report shows the check ran.
 */
export function groundingChecks(g: Grounding, bible: WorldBible, text: string, visualBrief: string | null | undefined): QcCheck[] {
  const all = `${text}\n${visualBrief ?? ''}`;
  const visual = visualBrief ?? '';
  const out: QcCheck[] = [];
  const temp = g.weather?.tempC ?? null;
  const at = `${g.localDate} ${g.localTime} ${g.place.city}`;
  const fail = (check: string, severity: QcCheck['severity'], message: string) => out.push({ check, pass: false, severity, message, location: at });

  // Wardrobe vs season and temperature.
  const warm = find(WARM_CLOTHES, all);
  if (warm && (g.season === 'winter' || (temp !== null && temp < 12))) {
    fail('world_wardrobe', 'major', `"${warm.word}" doesn't fit ${g.season} in ${g.place.city} (${temp !== null ? `${Math.round(temp)}°C` : 'cold'}): dress for the real weather (${g.weather?.summary ?? g.season}).`);
  }
  const cold = find(COLD_CLOTHES, all);
  if (cold && (g.season === 'summer' || (temp !== null && temp > 22))) {
    fail('world_wardrobe', 'major', `"${cold.word}" doesn't fit ${g.season} in ${g.place.city} (${temp !== null ? `${Math.round(temp)}°C` : 'warm'}): dress for the real weather.`);
  }

  // Light at the window vs the sun.
  const dayWord = find(DAYLIGHT, all);
  const dark = g.weather ? !g.weather.isDay : g.timeOfDay === 'night' || g.timeOfDay === 'evening';
  if (dayWord && dark && !PAST_OR_FUTURE.test(dayWord.before)) {
    fail('world_light', 'major', `"${dayWord.word}" but it's dark in ${g.place.city} at ${g.localTime} (${g.sunset ? `sunset ${g.sunset}` : 'after sunset'}): use lamp light and night at the window.`);
  }
  const darkWord = find(DARKNESS, visual || all);
  if (darkWord && g.weather?.isDay && g.timeOfDay !== 'evening' && g.timeOfDay !== 'dawn') {
    fail('world_light', 'major', `"${darkWord.word}" but it's broad daylight in ${g.place.city} at ${g.localTime}: match the daylight.`);
  }
  const golden = find(GOLDEN, all);
  if (golden && g.sunrise && g.sunset) {
    const now = minutesOf(g.localTime);
    const near = Math.min(Math.abs(now - minutesOf(g.sunrise)), Math.abs(now - minutesOf(g.sunset)));
    if (near > 90) fail('world_light', 'minor', `"golden hour" at ${g.localTime} is not near sunrise (${g.sunrise}) or sunset (${g.sunset}).`);
  }

  // Weather words vs the weather.
  const snow = find(SNOW, all);
  if (snow && temp !== null && temp >= 6 && !/snow|frost|sleet|ice/i.test(g.weather?.summary ?? '') && !PAST_OR_FUTURE.test(snow.before)) {
    fail('world_weather', 'major', `"${snow.word}" at ${Math.round(temp)}°C in ${g.place.city}: no snow or frost in this weather.`);
  }
  if (g.weather && g.weather.source !== 'climate') {
    const rain = find(RAIN, all);
    if (rain && !g.weather.precipitation && !PAST_OR_FUTURE.test(rain.before)) fail('world_weather', 'minor', `"${rain.word}" but it's dry in ${g.place.city} (${g.weather.summary}).`);
    if (dayWord && g.weather.precipitation && !dark && /sunny|sunshine|blue sk/i.test(dayWord.word)) fail('world_weather', 'minor', `"${dayWord.word}" but it's ${g.weather.summary} in ${g.place.city}.`);
  }

  // Season claims ("this summer heat", "a crisp autumn morning").
  const sc = SEASON_CLAIM.exec(all);
  if (sc) {
    const s = normSeason(sc[1] ?? sc[2] ?? '');
    if (s && (g.season === 'wet' || g.season === 'dry' ? false : s !== g.season)) fail('world_season', 'major', `"${sc[0]}" but it's ${g.season} in ${g.place.city} (${g.localDate}).`);
  }

  // Greetings vs the clock.
  const nowMin = minutesOf(g.localTime);
  if (GREETING_MORNING.test(text) && nowMin >= 12 * 60) fail('world_time', 'minor', `"good morning" in a post that goes out at ${g.localTime} local.`);
  if (GREETING_EVENING.test(text) && nowMin < 15 * 60 && nowMin >= 5 * 60) fail('world_time', 'minor', `an evening greeting in a post that goes out at ${g.localTime} local.`);

  // Topical references: holidays that aren't local, or aren't near.
  const cc = bible.place.countryCode;
  for (const h of HOLIDAYS) {
    const m = h.words.exec(all);
    if (!m) continue;
    const before = all.slice(Math.max(0, m.index - 60), m.index);
    if (PAST_OR_FUTURE.test(before)) continue;
    if (!observes(h, cc)) {
      fail('world_holiday', 'major', `"${m[0]}" isn't a local holiday in ${bible.place.country}: use what ${g.place.city} actually celebrates.`);
      continue;
    }
    const o = occurrence(h, g.localDate, cc);
    if (o && o.until > h.leadDays && o.since > h.afterDays) {
      fail('world_holiday', 'major', `"${m[0]}" is ${o.until} days away (${o.next}) on ${g.localDate}: too early to be topical.`);
    }
  }

  if (!out.length) out.push({ check: 'world_grounding', pass: true, severity: 'minor', message: `matches ${g.season}, ${g.timeOfDay} in ${g.place.city}${g.weather ? ` (${g.weather.summary}, ${Math.round(g.weather.tempC)}°C)` : ''}` });
  return out;
}
