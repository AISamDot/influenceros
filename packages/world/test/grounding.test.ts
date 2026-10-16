import { describe, expect, it } from 'vitest';
import { easter, holidaysNear, nthWeekday, placeFromText, seasonOf, sunTimes } from '../src';
import { clock, personaWithWorld, worldStudio } from './helpers';

const failing = (checks: Array<{ check: string; pass: boolean; severity: string; message: string }>, name: string) => checks.filter((c) => c.check === name && !c.pass);

describe('places, sun, seasons and holidays', () => {
  it('reads home bases from the generator library into real places', () => {
    expect(placeFromText('a terraced house in Yorkshire')).toMatchObject({ city: 'York', country: 'United Kingdom', timezone: 'Europe/London' });
    expect(placeFromText('a bungalow under the flight path, Ohio')).toMatchObject({ region: 'Ohio', timezone: 'America/New_York' });
    expect(placeFromText('a studio apartment in Queens, New York')).toMatchObject({ city: 'New York' });
    expect(placeFromText('a house on the harbour, Halifax')).toMatchObject({ region: 'Nova Scotia' });
    expect(placeFromText('somewhere nice')).toBeNull();
  });

  it('computes sun times, hemispheric seasons and moving holidays', () => {
    const york = sunTimes('2026-11-18', 53.96, -1.08);
    // Mid-November York: sunrise ~07:30, sunset ~16:05 (GMT).
    expect(york.sunset!.getUTCHours()).toBe(16);
    expect(york.sunrise!.getUTCHours()).toBe(7);
    expect(seasonOf(12, 40)).toBe('winter');
    expect(seasonOf(12, -33)).toBe('summer');
    expect(seasonOf(7, 6)).toBe('wet');
    expect(easter(2027)).toBe('2027-03-28');
    expect(nthWeekday(2026, 11, 4, 4)).toBe('2026-11-26'); // US Thanksgiving
    expect(holidaysNear('2026-11-02', 'GB').join(' ')).toMatch(/Bonfire Night \(Thu 5 Nov\)/);
    expect(holidaysNear('2026-11-02', 'US').join(' ')).not.toMatch(/Bonfire/);
  });
});

describe('real-time grounding', () => {
  it('grounds a Yorkshire persona from FakeWeather: season, time of day, sun, weather, holidays, block', async () => {
    const t = await worldStudio();
    const p = await personaWithWorld(t, { homeBase: 'a terraced house in Yorkshire' });
    clock.now = new Date('2026-11-04T18:00:00Z');
    t.providers.weather.fixed = { tempC: 6.2, summary: 'light rain', precipitationMm: 0.8, code: 61 };
    const g = await t.services.world.grounding(p.id, clock.now);
    expect(g).toMatchObject({ localDate: '2026-11-04', localTime: '18:00', weekday: 'Wednesday', season: 'autumn', timeOfDay: 'evening', timezone: 'Europe/London' });
    expect(g!.place.city).toBe('York');
    expect(g!.weather).toMatchObject({ summary: 'light rain', tempC: 6.2, precipitation: true, isDay: false, source: 'fake' });
    expect(g!.sunset).toMatch(/^16:/);
    expect(g!.holidays.join()).toMatch(/Bonfire Night \(tomorrow\)/);
    expect(g!.block).toMatch(/Local moment for Dot Pickering: Wednesday 2026-11-04, 18:00 in York/);
    expect(g!.block).toMatch(/dark outside/);
    expect(g!.block).toMatch(/light rain, 6°C/);
    expect(t.providers.weather.callsTo('current')).toHaveLength(1);
    // Cached for 30 minutes.
    await t.services.world.grounding(p.id, clock.now);
    expect(t.providers.weather.callsTo('current')).toHaveLength(1);
    // Days ahead: the climate estimate, never a stale "live" reading.
    const later = await t.services.world.grounding(p.id, new Date('2026-12-20T12:00:00Z'));
    expect(later!.weather!.source).toBe('climate');
    expect(later!.season).toBe('winter');
    expect(await t.services.world.grounding('00000000-0000-4000-8000-0000000000aa', clock.now)).toBeNull();
    t.providers.weather.fixed = null;
    await t.db.close();
  });

  it('flags a summer dress in a December Ohio post and daylight at 6 pm in a Yorkshire November', async () => {
    const t = await worldStudio();
    const ohio = await personaWithWorld(t, { homeBase: 'a bungalow under the flight path, Ohio', name: 'Bev Kowalski', timezone: 'America/New_York' });
    const yorks = await personaWithWorld(t, { homeBase: 'a terraced house in Yorkshire', name: 'Dot Pickering' });
    const base = { studioId: t.studioId, subject: { type: 'script' as const, id: null } };

    clock.now = new Date('2026-12-10T17:00:00Z'); // noon in Ohio
    const dress = await t.services.world.checkContent({ ...base, personaId: ohio.id, text: 'Hook: my winter savings trick.', at: clock.now, visualBrief: 'Bev twirls in a floral summer dress on the porch.' });
    const w = failing(dress, 'world_wardrobe');
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ severity: 'major' });
    expect(w[0]!.message).toMatch(/summer dress.*winter/i);

    clock.now = new Date('2026-11-18T18:00:00Z'); // 6 pm in York
    const light = await t.services.world.checkContent({ ...base, personaId: yorks.id, text: 'Here is the canteen rule for today.', at: clock.now, visualBrief: 'Dot at the kitchen table, afternoon sun streaming through the window.' });
    const l = failing(light, 'world_light');
    expect(l).toHaveLength(1);
    expect(l[0]!.message).toMatch(/dark in York at 18:00/);

    // The same scene in lamp light, dressed for November, passes the grounding checks.
    const ok = await t.services.world.checkContent({ ...base, personaId: yorks.id, text: 'Here is the canteen rule for tonight.', at: clock.now, visualBrief: 'Dot at the kitchen table in a cardigan, lamp on, dark window behind her.' });
    expect(ok.filter((c) => c.check.startsWith('world_') && !c.pass)).toEqual([]);
    expect(ok.find((c) => c.check === 'world_grounding')).toMatchObject({ pass: true });

    // Topical references: not local (Thanksgiving in Yorkshire), or not near (Christmas in July).
    const tg = await t.services.world.checkContent({ ...base, personaId: yorks.id, text: 'My Thanksgiving budget, sorted.', at: clock.now });
    expect(failing(tg, 'world_holiday')[0]!.message).toMatch(/isn't a local holiday in United Kingdom/);
    const july = await t.services.world.checkContent({ ...base, personaId: yorks.id, text: 'Start your Christmas list now.', at: new Date('2026-07-10T12:00:00Z') });
    expect(failing(july, 'world_holiday')).toHaveLength(1);
    const dec = await t.services.world.checkContent({ ...base, personaId: yorks.id, text: 'Start your Christmas list now.', at: new Date('2026-12-01T12:00:00Z') });
    expect(failing(dec, 'world_holiday')).toHaveLength(0);
    // Season claims.
    const season = await t.services.world.checkContent({ ...base, personaId: yorks.id, text: 'What a gorgeous summer evening for a walk.', at: clock.now });
    expect(failing(season, 'world_season')).toHaveLength(1);
    await t.db.close();
  });
});
