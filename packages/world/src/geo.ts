/**
 * A small gazetteer for the places the Persona Generator writes into a home base ("a terraced house in Yorkshire",
 * "a bungalow under the flight path, Ohio"). It gives a deterministic place (city, region, country, timezone,
 * coordinates, a rough January / July mean temperature and the local accent) with no network call; the live
 * Open-Meteo geocoder only fills places the gazetteer doesn't know.
 */

export type CountryCode = 'GB' | 'US' | 'CA' | 'IE' | 'AU' | 'NZ' | 'AE' | 'EG' | 'NG' | 'KE' | 'ZA' | 'OTHER';

export interface Place {
  readonly city: string;
  readonly region: string | null;
  readonly country: string;
  readonly countryCode: CountryCode;
  readonly timezone: string;
  readonly lat: number;
  readonly lon: number;
  /** Mean temperature, °C, in January and July (climate fallback when no live weather applies). */
  readonly janC: number;
  readonly julC: number;
  readonly accent: string;
}

interface Entry extends Place {
  /** Lowercase names that identify this place in free text. */
  readonly match: readonly string[];
}

const GB = { country: 'United Kingdom', countryCode: 'GB' as const, timezone: 'Europe/London' };
const US_E = { country: 'United States', countryCode: 'US' as const, timezone: 'America/New_York' };
const US_C = { country: 'United States', countryCode: 'US' as const, timezone: 'America/Chicago' };

const ENTRIES: readonly Entry[] = [
  // United Kingdom and Ireland
  { match: ['yorkshire', 'york'], city: 'York', region: 'North Yorkshire', ...GB, lat: 53.96, lon: -1.08, janC: 4, julC: 16.5, accent: 'Yorkshire accent' },
  { match: ['leeds'], city: 'Leeds', region: 'West Yorkshire', ...GB, lat: 53.8, lon: -1.55, janC: 4, julC: 16.5, accent: 'Yorkshire accent' },
  { match: ['halifax, west yorkshire', 'halifax, yorkshire'], city: 'Halifax', region: 'West Yorkshire', ...GB, lat: 53.72, lon: -1.86, janC: 3.5, julC: 15.5, accent: 'Yorkshire accent' },
  { match: ['liverpool'], city: 'Liverpool', region: 'Merseyside', ...GB, lat: 53.41, lon: -2.99, janC: 5, julC: 16.5, accent: 'Scouse accent' },
  { match: ['manchester'], city: 'Manchester', region: 'Greater Manchester', ...GB, lat: 53.48, lon: -2.24, janC: 4.5, julC: 16.5, accent: 'Mancunian accent' },
  { match: ['stockport'], city: 'Stockport', region: 'Greater Manchester', ...GB, lat: 53.41, lon: -2.16, janC: 4.5, julC: 16.5, accent: 'Mancunian accent' },
  { match: ['glasgow'], city: 'Glasgow', region: 'Scotland', ...GB, lat: 55.86, lon: -4.25, janC: 4, julC: 15.5, accent: 'Glaswegian accent' },
  { match: ['edinburgh'], city: 'Edinburgh', region: 'Scotland', ...GB, lat: 55.95, lon: -3.19, janC: 4, julC: 15.5, accent: 'Edinburgh Scottish accent' },
  { match: ['bristol'], city: 'Bristol', region: 'South West England', ...GB, lat: 51.45, lon: -2.59, janC: 5, julC: 17.5, accent: 'West Country accent' },
  { match: ['cornish', 'cornwall'], city: 'St Ives', region: 'Cornwall', ...GB, lat: 50.21, lon: -5.48, janC: 7, julC: 16.5, accent: 'Cornish accent' },
  { match: ['northumberland'], city: 'Alnwick', region: 'Northumberland', ...GB, lat: 55.41, lon: -1.71, janC: 4, julC: 15, accent: 'Geordie-leaning Northumbrian accent' },
  { match: ['newcastle'], city: 'Newcastle upon Tyne', region: 'Tyne and Wear', ...GB, lat: 54.98, lon: -1.61, janC: 4.5, julC: 16, accent: 'Geordie accent' },
  { match: ['northamptonshire', 'northampton'], city: 'Northampton', region: 'Northamptonshire', ...GB, lat: 52.24, lon: -0.9, janC: 4, julC: 17, accent: 'East Midlands accent' },
  { match: ['surrey'], city: 'Guildford', region: 'Surrey', ...GB, lat: 51.24, lon: -0.57, janC: 5, julC: 18, accent: 'Home Counties accent' },
  { match: ['london'], city: 'London', region: 'Greater London', ...GB, lat: 51.51, lon: -0.13, janC: 5.5, julC: 19, accent: 'London accent' },
  { match: ['birmingham, uk', 'birmingham, england', 'west midlands'], city: 'Birmingham', region: 'West Midlands', ...GB, lat: 52.49, lon: -1.89, janC: 4, julC: 17, accent: 'Brummie accent' },
  { match: ['cardiff', 'wales'], city: 'Cardiff', region: 'Wales', ...GB, lat: 51.48, lon: -3.18, janC: 5, julC: 16.5, accent: 'Welsh accent' },
  { match: ['dublin'], city: 'Dublin', region: 'Leinster', country: 'Ireland', countryCode: 'IE', timezone: 'Europe/Dublin', lat: 53.35, lon: -6.26, janC: 5, julC: 15.5, accent: 'Dublin Irish accent' },
  // Canada
  { match: ['halifax', 'nova scotia'], city: 'Halifax', region: 'Nova Scotia', country: 'Canada', countryCode: 'CA', timezone: 'America/Halifax', lat: 44.65, lon: -63.58, janC: -5.5, julC: 18.5, accent: 'Nova Scotian accent' },
  { match: ['toronto'], city: 'Toronto', region: 'Ontario', country: 'Canada', countryCode: 'CA', timezone: 'America/Toronto', lat: 43.65, lon: -79.38, janC: -5.5, julC: 22, accent: 'Canadian accent' },
  // United States
  { match: ['columbus'], city: 'Columbus', region: 'Ohio', ...US_E, lat: 39.96, lon: -83.0, janC: -2, julC: 24, accent: 'Midwestern accent' },
  { match: ['ohio'], city: 'Dayton', region: 'Ohio', ...US_E, lat: 39.76, lon: -84.19, janC: -2.5, julC: 24, accent: 'Midwestern accent' },
  { match: ['maine'], city: 'Portland', region: 'Maine', ...US_E, lat: 43.66, lon: -70.26, janC: -5.5, julC: 21, accent: 'Down East Maine accent' },
  { match: ['atlantic city'], city: 'Atlantic City', region: 'New Jersey', ...US_E, lat: 39.36, lon: -74.42, janC: 1, julC: 24.5, accent: 'South Jersey accent' },
  { match: ['new orleans'], city: 'New Orleans', region: 'Louisiana', ...US_C, lat: 29.95, lon: -90.07, janC: 12, julC: 28.5, accent: 'New Orleans "Yat" accent' },
  { match: ['philadelphia', 'philly'], city: 'Philadelphia', region: 'Pennsylvania', ...US_E, lat: 39.95, lon: -75.17, janC: 1, julC: 26, accent: 'Philadelphia accent' },
  { match: ['savannah', 'georgia'], city: 'Savannah', region: 'Georgia', ...US_E, lat: 32.08, lon: -81.09, janC: 10.5, julC: 28, accent: 'soft Georgia Southern accent' },
  { match: ['atlanta'], city: 'Atlanta', region: 'Georgia', ...US_E, lat: 33.75, lon: -84.39, janC: 7, julC: 27, accent: 'Southern accent' },
  { match: ['indianapolis', 'indiana'], city: 'Indianapolis', region: 'Indiana', country: 'United States', countryCode: 'US', timezone: 'America/Indiana/Indianapolis', lat: 39.77, lon: -86.16, janC: -2, julC: 24, accent: 'Midwestern accent' },
  { match: ['chicago'], city: 'Chicago', region: 'Illinois', ...US_C, lat: 41.88, lon: -87.63, janC: -4.5, julC: 24, accent: 'Chicago accent' },
  { match: ['boston'], city: 'Boston', region: 'Massachusetts', ...US_E, lat: 42.36, lon: -71.06, janC: -1.5, julC: 23, accent: 'Boston accent' },
  { match: ['amarillo'], city: 'Amarillo', region: 'Texas', ...US_C, lat: 35.22, lon: -101.83, janC: 2.5, julC: 26, accent: 'West Texas drawl' },
  { match: ['austin'], city: 'Austin', region: 'Texas', ...US_C, lat: 30.27, lon: -97.74, janC: 11, julC: 29.5, accent: 'Texan accent' },
  { match: ['texas'], city: 'San Antonio', region: 'Texas', ...US_C, lat: 29.42, lon: -98.49, janC: 11, julC: 29.5, accent: 'Texan accent' },
  { match: ['iowa'], city: 'Ames', region: 'Iowa', ...US_C, lat: 42.03, lon: -93.62, janC: -7, julC: 23.5, accent: 'Midwestern accent' },
  { match: ['queens', 'brooklyn', 'new york'], city: 'New York', region: 'New York', ...US_E, lat: 40.73, lon: -73.86, janC: 0.5, julC: 25, accent: 'New York accent' },
  { match: ['los angeles', 'california'], city: 'Los Angeles', region: 'California', country: 'United States', countryCode: 'US', timezone: 'America/Los_Angeles', lat: 34.05, lon: -118.24, janC: 14, julC: 24, accent: 'Californian accent' },
  { match: ['seattle'], city: 'Seattle', region: 'Washington', country: 'United States', countryCode: 'US', timezone: 'America/Los_Angeles', lat: 47.61, lon: -122.33, janC: 5.5, julC: 19, accent: 'Pacific Northwest accent' },
  { match: ['denver', 'colorado'], city: 'Denver', region: 'Colorado', country: 'United States', countryCode: 'US', timezone: 'America/Denver', lat: 39.74, lon: -104.99, janC: -1, julC: 23.5, accent: 'neutral Western accent' },
  { match: ['phoenix', 'arizona'], city: 'Phoenix', region: 'Arizona', country: 'United States', countryCode: 'US', timezone: 'America/Phoenix', lat: 33.45, lon: -112.07, janC: 13, julC: 34.5, accent: 'neutral Western accent' },
  { match: ['miami', 'florida'], city: 'Miami', region: 'Florida', ...US_E, lat: 25.76, lon: -80.19, janC: 20, julC: 29, accent: 'South Florida accent' },
  // Elsewhere (English-language content only)
  { match: ['sydney'], city: 'Sydney', region: 'New South Wales', country: 'Australia', countryCode: 'AU', timezone: 'Australia/Sydney', lat: -33.87, lon: 151.21, janC: 23, julC: 13, accent: 'Australian accent' },
  { match: ['melbourne'], city: 'Melbourne', region: 'Victoria', country: 'Australia', countryCode: 'AU', timezone: 'Australia/Melbourne', lat: -37.81, lon: 144.96, janC: 21, julC: 10.5, accent: 'Australian accent' },
  { match: ['auckland'], city: 'Auckland', region: null, country: 'New Zealand', countryCode: 'NZ', timezone: 'Pacific/Auckland', lat: -36.85, lon: 174.76, janC: 20, julC: 11, accent: 'New Zealand accent' },
  { match: ['dubai'], city: 'Dubai', region: null, country: 'United Arab Emirates', countryCode: 'AE', timezone: 'Asia/Dubai', lat: 25.2, lon: 55.27, janC: 19.5, julC: 36, accent: 'international English accent' },
  { match: ['cairo'], city: 'Cairo', region: null, country: 'Egypt', countryCode: 'EG', timezone: 'Africa/Cairo', lat: 30.04, lon: 31.24, janC: 14, julC: 28.5, accent: 'Egyptian English accent' },
  { match: ['lagos'], city: 'Lagos', region: null, country: 'Nigeria', countryCode: 'NG', timezone: 'Africa/Lagos', lat: 6.52, lon: 3.38, janC: 27, julC: 25.5, accent: 'Nigerian English accent' },
  { match: ['nairobi'], city: 'Nairobi', region: null, country: 'Kenya', countryCode: 'KE', timezone: 'Africa/Nairobi', lat: -1.29, lon: 36.82, janC: 19.5, julC: 16, accent: 'Kenyan English accent' },
  { match: ['cape town'], city: 'Cape Town', region: 'Western Cape', country: 'South Africa', countryCode: 'ZA', timezone: 'Africa/Johannesburg', lat: -33.92, lon: 18.42, janC: 21.5, julC: 12.5, accent: 'South African accent' },
];

/** The place used when nothing else is known, per persona timezone. */
const BY_TIMEZONE: Readonly<Record<string, string>> = {
  'Europe/London': 'London',
  'America/New_York': 'New York',
  'America/Chicago': 'Chicago',
  'America/Denver': 'Denver',
  'America/Phoenix': 'Phoenix',
  'America/Los_Angeles': 'Los Angeles',
  'America/Toronto': 'Toronto',
  'America/Halifax': 'Halifax',
  'Europe/Dublin': 'Dublin',
  'Australia/Sydney': 'Sydney',
  'Asia/Dubai': 'Dubai',
  'Africa/Cairo': 'Cairo',
  'Africa/Lagos': 'Lagos',
  'Africa/Nairobi': 'Nairobi',
};

const strip = ({ match: _m, ...p }: Entry): Place => p;

/** The best gazetteer match for free text (longest matching name wins; later words in the text break ties). */
export function placeFromText(text: string | null | undefined): Place | null {
  if (!text) return null;
  const t = ` ${text.toLowerCase().replace(/[()]/g, ' ')} `;
  let best: { e: Entry; len: number; at: number } | null = null;
  for (const e of ENTRIES) {
    for (const m of e.match) {
      const re = new RegExp(`(?<![a-z])${m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z])`);
      const hit = re.exec(t);
      if (!hit) continue;
      if (!best || m.length > best.len || (m.length === best.len && hit.index > best.at)) best = { e, len: m.length, at: hit.index };
    }
  }
  return best ? strip(best.e) : null;
}

export function placeForTimezone(timezone: string | null | undefined): Place | null {
  const city = timezone ? BY_TIMEZONE[timezone] : undefined;
  return city ? placeFromText(city) : null;
}

export const DEFAULT_PLACE: Place = placeFromText('London')!;

/** A home base's period, e.g. "a semi-detached house in Surrey (1958)" → 1958 (period personas). */
export function eraOf(text: string | null | undefined): number | null {
  const m = text ? /\((1[89]\d\d|20[0-4]\d)\)/.exec(text) : null;
  return m ? Number(m[1]) : null;
}

/** The dwelling part of a home base: "a terraced house in Yorkshire" → "terraced house". */
export function dwellingOf(text: string | null | undefined): string {
  const t = (text ?? '').replace(/\(.*?\)/g, '').trim();
  const head = t.split(/\s+(?:in|on|near|outside|off|under|above|by)\s+|,/i)[0] ?? t;
  return head.replace(/^(?:a|an|the)\s+/i, '').trim() || 'small house';
}

export function currencyOf(cc: CountryCode): { code: string; symbol: string } {
  switch (cc) {
    case 'GB':
      return { code: 'GBP', symbol: '£' };
    case 'IE':
      return { code: 'EUR', symbol: '€' };
    case 'CA':
      return { code: 'CAD', symbol: '$' };
    case 'AU':
      return { code: 'AUD', symbol: '$' };
    case 'NZ':
      return { code: 'NZD', symbol: '$' };
    case 'AE':
      return { code: 'AED', symbol: 'AED ' };
    case 'EG':
      return { code: 'EGP', symbol: 'EGP ' };
    case 'NG':
      return { code: 'NGN', symbol: '₦' };
    case 'KE':
      return { code: 'KES', symbol: 'KSh ' };
    case 'ZA':
      return { code: 'ZAR', symbol: 'R' };
    default:
      return { code: 'USD', symbol: '$' };
  }
}

export function countryCodeOf(country: string): CountryCode {
  const c = country.toLowerCase();
  if (/united kingdom|england|scotland|wales|britain|^uk$/.test(c)) return 'GB';
  if (/united states|^usa?$|america/.test(c)) return 'US';
  if (/canada/.test(c)) return 'CA';
  if (/ireland/.test(c)) return 'IE';
  if (/australia/.test(c)) return 'AU';
  if (/new zealand/.test(c)) return 'NZ';
  if (/emirates|uae/.test(c)) return 'AE';
  if (/egypt/.test(c)) return 'EG';
  if (/nigeria/.test(c)) return 'NG';
  if (/kenya/.test(c)) return 'KE';
  if (/south africa/.test(c)) return 'ZA';
  return 'OTHER';
}
