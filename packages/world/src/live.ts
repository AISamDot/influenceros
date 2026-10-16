import type { GeoPlace, InspirationPin, PinterestBoard, PinterestProvider, WeatherNow, WeatherProvider } from '@ios/providers';

/**
 * Live adapters stream J owns: Open-Meteo (weather and geocoding, no key) and Pinterest API v5 (OAuth access token
 * for the one studio account; pending its key). Both are plain HTTPS with timeouts; neither logs or stores a key.
 */

type Fetch = typeof fetch;

const WMO: Readonly<Record<number, string>> = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'freezing fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 56: 'freezing drizzle', 57: 'freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains', 80: 'light showers', 81: 'showers', 82: 'heavy showers',
  85: 'snow showers', 86: 'heavy snow showers', 95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with hail',
};
export const wmoSummary = (code: number): string => WMO[code] ?? 'mixed weather';

export class OpenMeteoWeather implements WeatherProvider {
  readonly name = 'open-meteo';
  constructor(
    private readonly http: Fetch = fetch,
    private readonly base = { forecast: 'https://api.open-meteo.com/v1/forecast', geocode: 'https://geocoding-api.open-meteo.com/v1/search' },
  ) {}

  async current(req: { lat: number; lon: number; timezone: string }): Promise<WeatherNow> {
    const u = new URL(this.base.forecast);
    u.searchParams.set('latitude', req.lat.toFixed(4));
    u.searchParams.set('longitude', req.lon.toFixed(4));
    u.searchParams.set('current', 'temperature_2m,weather_code,precipitation,cloud_cover,is_day');
    u.searchParams.set('daily', 'sunrise,sunset');
    u.searchParams.set('timezone', req.timezone);
    u.searchParams.set('forecast_days', '1');
    const res = await this.http(u, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`open-meteo forecast: HTTP ${res.status}`);
    const body = (await res.json()) as {
      current?: { time?: string; temperature_2m?: number; weather_code?: number; precipitation?: number; cloud_cover?: number; is_day?: number };
      daily?: { sunrise?: string[]; sunset?: string[] };
    };
    const c = body.current ?? {};
    if (typeof c.temperature_2m !== 'number') throw new Error('open-meteo forecast: no current temperature');
    const code = typeof c.weather_code === 'number' ? c.weather_code : -1;
    return {
      at: new Date(),
      tempC: c.temperature_2m,
      code,
      summary: wmoSummary(code),
      precipitationMm: typeof c.precipitation === 'number' ? c.precipitation : 0,
      cloudCoverPct: typeof c.cloud_cover === 'number' ? c.cloud_cover : null,
      isDay: c.is_day === 1,
      sunrise: body.daily?.sunrise?.[0] ?? null,
      sunset: body.daily?.sunset?.[0] ?? null,
    };
  }

  async geocode(req: { name: string; country?: string }): Promise<GeoPlace[]> {
    const u = new URL(this.base.geocode);
    u.searchParams.set('name', req.name.slice(0, 100));
    u.searchParams.set('count', '5');
    u.searchParams.set('language', 'en');
    u.searchParams.set('format', 'json');
    const res = await this.http(u, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`open-meteo geocoding: HTTP ${res.status}`);
    const body = (await res.json()) as { results?: Array<{ name: string; admin1?: string; country?: string; latitude: number; longitude: number; timezone?: string }> };
    const all = (body.results ?? []).map((r) => ({ name: r.name, region: r.admin1 ?? null, country: r.country ?? '', lat: r.latitude, lon: r.longitude, timezone: r.timezone ?? 'UTC' }));
    const want = req.country?.toLowerCase();
    return want ? [...all.filter((p) => p.country.toLowerCase() === want), ...all.filter((p) => p.country.toLowerCase() !== want)] : all;
  }
}

/**
 * Pinterest API v5 (https://api.pinterest.com/v5). Boards and pins for products and carousels on the studio
 * account. General pin search isn't open to standard apps: `searchPins` tries the partner search endpoint and says
 * `supported: false` when the app has no access, so the caller falls back to the Apify scraper.
 */
export class PinterestApiV5 implements PinterestProvider {
  readonly name = 'pinterest-api-v5';
  constructor(
    private readonly token: string,
    private readonly http: Fetch = fetch,
    private readonly baseUrl = 'https://api.pinterest.com/v5',
  ) {}

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown, query?: Record<string, string>): Promise<{ status: number; data: T | null }> {
    const u = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) u.searchParams.set(k, v);
    const res = await this.http(u, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    const data = text ? (JSON.parse(text) as T) : null;
    return { status: res.status, data };
  }

  private fail(what: string, r: { status: number; data: unknown }): never {
    const msg = r.data && typeof r.data === 'object' && 'message' in r.data ? String((r.data as { message: unknown }).message).slice(0, 200) : '';
    throw new Error(`pinterest ${what}: HTTP ${r.status}${msg ? ` (${msg})` : ''}`);
  }

  async listBoards(): Promise<PinterestBoard[]> {
    const out: PinterestBoard[] = [];
    let bookmark: string | null = null;
    for (let page = 0; page < 10; page++) {
      const r: { status: number; data: { items?: Array<{ id: string; name: string; privacy?: string }>; bookmark?: string | null } | null } = await this.call(
        'GET',
        '/boards',
        undefined,
        { page_size: '100', ...(bookmark ? { bookmark } : {}) },
      );
      if (r.status !== 200 || !r.data) this.fail('list boards', r);
      for (const b of r.data!.items ?? []) out.push({ id: b.id, name: b.name, privacy: (b.privacy as PinterestBoard['privacy']) ?? 'PUBLIC' });
      bookmark = r.data!.bookmark ?? null;
      if (!bookmark) break;
    }
    return out;
  }

  async createBoard(req: { name: string; description?: string; privacy?: PinterestBoard['privacy'] }): Promise<PinterestBoard> {
    const r = await this.call<{ id: string; name: string; privacy?: string }>('POST', '/boards', { name: req.name.slice(0, 50), description: req.description?.slice(0, 500), privacy: req.privacy ?? 'PUBLIC' });
    if ((r.status !== 201 && r.status !== 200) || !r.data) this.fail('create board', r);
    return { id: r.data!.id, name: r.data!.name, privacy: (r.data!.privacy as PinterestBoard['privacy']) ?? 'PUBLIC' };
  }

  async createPin(req: { boardId: string; title: string; description: string; link?: string; mediaUrl: string; altText?: string }): Promise<{ id: string; url: string }> {
    const r = await this.call<{ id: string }>('POST', '/pins', {
      board_id: req.boardId,
      title: req.title.slice(0, 100),
      description: req.description.slice(0, 800),
      ...(req.link ? { link: req.link } : {}),
      ...(req.altText ? { alt_text: req.altText.slice(0, 500) } : {}),
      media_source: { source_type: 'image_url', url: req.mediaUrl },
    });
    if ((r.status !== 201 && r.status !== 200) || !r.data) this.fail('create pin', r);
    return { id: r.data!.id, url: `https://www.pinterest.com/pin/${r.data!.id}/` };
  }

  async searchPins(req: { query: string; limit?: number }): Promise<{ supported: boolean; pins: InspirationPin[] }> {
    const r = await this.call<{ items?: Array<Record<string, unknown>> }>('GET', '/search/partner/pins', undefined, {
      term: req.query.slice(0, 100),
      country_code: 'US',
      limit: String(Math.min(25, Math.max(1, req.limit ?? 12))),
    });
    if (r.status === 401 || r.status === 403 || r.status === 404 || r.status === 405) return { supported: false, pins: [] };
    if (r.status !== 200 || !r.data) this.fail('search pins', r);
    return { supported: true, pins: (r.data!.items ?? []).map((x) => pinFromItem(x, 'pinterest-api')).filter((p): p is InspirationPin => !!p) };
  }
}

/** Maps a Pinterest API item or an Apify scraper item to a pin (fields differ by source). */
export function pinFromItem(x: unknown, source: InspirationPin['source']): InspirationPin | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const nested = (v: unknown, ...path: string[]): unknown => path.reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), v);
  const id = s(o.id) ?? s(o.pinId) ?? s(o.pin_id) ?? (typeof o.id === 'number' ? String(o.id) : null);
  const url = s(o.url) ?? s(o.pinUrl) ?? s(o.link) ?? (id ? `https://www.pinterest.com/pin/${id}/` : null);
  if (!id || !url) return null;
  const imageUrl =
    s(o.imageUrl) ?? s(o.image) ?? s(nested(o, 'images', 'orig', 'url')) ?? s(nested(o, 'image', 'url')) ?? s(nested(o, 'media', 'images', '1200x', 'url')) ?? s(nested(o, 'media', 'images', 'originals', 'url'));
  const board = s(o.board) ?? s(nested(o, 'board', 'name')) ?? s(o.boardName);
  return {
    id,
    url,
    imageUrl,
    title: (s(o.title) ?? s(o.grid_title) ?? s(o.gridTitle) ?? '').slice(0, 200),
    description: (s(o.description) ?? s(o.alt_text) ?? s(o.altText) ?? '').slice(0, 500),
    board,
    source,
  };
}
