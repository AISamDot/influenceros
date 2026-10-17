import type { WorldDraft, WorldDraftRequest } from '@troupe/agents';
import { type CountryCode, currencyOf, DEFAULT_PLACE, dwellingOf, eraOf, type Place, placeForTimezone, placeFromText } from './geo';
import { addDays, holidayCalendar } from './holidays';
import { ARC_WEEKS, type CastMember, type Gender, hashInt, pickFrom, type RecurringPlace, type StoryBeat, type StoryChapter, type Storyline, type WorldBible } from './model';
import { localParts, sunTimes } from './time';

/**
 * The deterministic World Bible + ~12-week storyline (fake mode, and the base the Studio Manager's live draft is
 * merged over). Everything is fictional and generic: invented neighbours and family, generic shops (no brands).
 */

const NAMES: Readonly<Record<'GB' | 'US' | 'OTHER', Record<'old_f' | 'old_m' | 'mid_f' | 'mid_m' | 'young_f' | 'young_m', readonly string[]>>> = {
  GB: {
    old_f: ['Angie', 'Maureen', 'Brenda', 'Sheila', 'Jean', 'Pat', 'Valerie', 'Joyce'],
    old_m: ['Derek', 'Ken', 'Ron', 'Alan', 'Clive', 'Brian', 'Terry', 'Malcolm'],
    mid_f: ['Karen', 'Julie', 'Tracey', 'Nicola', 'Donna', 'Lisa'],
    mid_m: ['Gary', 'Darren', 'Paul', 'Steve', 'Neil', 'Mark'],
    young_f: ['Chloe', 'Ellie', 'Amber', 'Megan', 'Freya', 'Jess'],
    young_m: ['Josh', 'Liam', 'Callum', 'Ryan', 'Kieran', 'Alfie'],
  },
  US: {
    old_f: ['Linda', 'Barb', 'Carol', 'Donna', 'Judy', 'Peggy', 'Shirley', 'Lorraine'],
    old_m: ['Earl', 'Hank', 'Walt', 'Dale', 'Gene', 'Roy', 'Frank', 'Lyle'],
    mid_f: ['Kim', 'Tammy', 'Michelle', 'Stacy', 'Dawn', 'Renee'],
    mid_m: ['Rick', 'Todd', 'Scott', 'Kevin', 'Brian', 'Doug'],
    young_f: ['Madison', 'Kayla', 'Brianna', 'Ashley', 'Taylor', 'Hailey'],
    young_m: ['Tyler', 'Dylan', 'Austin', 'Cody', 'Brandon', 'Logan'],
  },
  OTHER: {
    old_f: ['Grace', 'Ruth', 'Esther', 'Mary', 'Helen', 'Agnes'],
    old_m: ['Samuel', 'Joseph', 'Peter', 'Henry', 'Albert', 'Charles'],
    mid_f: ['Sarah', 'Ruth', 'Joy', 'Faith', 'Anne', 'Rose'],
    mid_m: ['David', 'Michael', 'Daniel', 'James', 'John', 'Paul'],
    young_f: ['Zara', 'Mia', 'Leah', 'Nia', 'Ada', 'Lola'],
    young_m: ['Noah', 'Eli', 'Leo', 'Sam', 'Ben', 'Max'],
  },
};
const nameSet = (cc: CountryCode) => (cc === 'GB' || cc === 'IE' ? NAMES.GB : cc === 'US' || cc === 'CA' ? NAMES.US : NAMES.OTHER);

const band = (age: number | null) => (age === null ? 'mid' : age >= 55 ? 'old' : age >= 32 ? 'mid' : 'young');

/** "79, school dinner lady for 41 years" → 79. */
export function ageFromArchetype(archetype: string): number | null {
  const m = /^\s*(\d{2,3})\b/.exec(archetype) ?? /\b(\d{2,3})[- ]year[- ]old\b/i.exec(archetype);
  const n = m ? Number(m[1]) : NaN;
  return n >= 16 && n <= 105 ? n : null;
}

export interface DraftInput {
  readonly draftId: string;
  readonly name: string;
  readonly archetype: string;
  readonly premise: string;
  readonly mechanic: string;
  readonly niche: string;
  readonly homeBase: string | null;
  readonly lore: string | null;
  readonly timezone: string | null;
}

export function inputOf(q: WorldDraftRequest): DraftInput {
  return {
    draftId: q.draftId,
    name: q.concept.name,
    archetype: q.concept.archetype,
    premise: q.concept.premise,
    mechanic: q.concept.mechanic,
    niche: q.niche,
    homeBase: q.character?.homeBase ?? null,
    lore: q.character?.lore ?? null,
    timezone: q.timezone ?? null,
  };
}

/** The place for a home base: the gazetteer first, then the persona's timezone, then London. */
export function resolvePlace(homeBase: string | null, timezone: string | null): Place {
  return placeFromText(homeBase) ?? placeForTimezone(timezone) ?? DEFAULT_PLACE;
}

function solsticeLight(place: Pick<Place, 'lat' | 'lon' | 'timezone'>, year: number): { dec: string; jun: string } {
  const fmt = (iso: string) => {
    const s = sunTimes(iso, place.lat, place.lon);
    const t = (d: Date | null) => (d ? localParts(d, place.timezone).time : '—');
    return `sunrise ${t(s.sunrise)}, sunset ${t(s.sunset)}`;
  };
  return { dec: fmt(`${year}-12-21`), jun: fmt(`${year}-06-21`) };
}

function castFor(inp: DraftInput, place: Place, age: number | null): CastMember[] {
  const names = nameSet(place.countryCode);
  const seed = `${inp.draftId}:${inp.name}`;
  const own = band(age);
  const peerF = names[`${own}_f` as const];
  const peerM = names[`${own}_m` as const];
  const young = (g: Gender) => (g === 'f' ? names.young_f : names.young_m);
  const used = new Set<string>([inp.name.split(' ')[0]!]);
  const take = (list: readonly string[], k: string) => {
    let i = hashInt(`${seed}:${k}`) % list.length;
    for (let n = 0; n < list.length && used.has(list[i]!); n++) i = (i + 1) % list.length;
    used.add(list[i]!);
    return list[i]!;
  };
  const off = (d: number) => (age === null ? null : Math.max(8, age + d));
  const UK = place.countryCode === 'GB' || place.countryCode === 'IE';
  const cast: CastMember[] = [
    { name: take(peerF, 'sister'), relation: 'sister', gender: 'f', age: off(-4), traits: 'blunt, loving, keeps score', role: 'the sceptic on the phone; disagrees, then quietly copies the tip' },
    { name: take(peerM, 'neighbour'), relation: 'neighbour', gender: 'm', age: off(3), traits: 'nosy, kind, terrible at gadgets', role: `leans over the ${UK ? 'garden wall' : 'fence'} with opinions; a running gag` },
    { name: take(peerF, 'friend'), relation: 'friend', gender: 'f', age: off(-1), traits: 'warm, chatty, always late', role: `meets ${inp.name.split(' ')[0]} for the weekly ${UK ? 'cuppa' : 'coffee'}; asks the audience's questions` },
  ];
  if (age !== null && age >= 55) {
    const g: Gender = hashInt(`${seed}:gk`) % 2 ? 'f' : 'm';
    cast.push({ name: take(young(g), 'grandchild'), relation: g === 'f' ? 'granddaughter' : 'grandson', gender: g, age: 19 + (hashInt(`${seed}:gka`) % 6), traits: 'phone-glued, secretly proud', role: 'films some of the videos; the source of tech mix-ups' });
  } else {
    const g: Gender = hashInt(`${seed}:fm`) % 2 ? 'f' : 'm';
    cast.push({ name: take(young(g), 'flatmate'), relation: UK ? 'flatmate' : 'roommate', gender: g, age: off(-2), traits: 'messy, funny, broke', role: 'the before-picture for every tip' });
  }
  cast.push({ name: take(names.mid_m, 'shop'), relation: 'shopkeeper', gender: 'm', age: null, traits: 'dry, knows everyone', role: `runs ${UK ? 'the corner shop' : 'the corner store'}; local gossip and prices` });
  return cast;
}

function placesFor(place: Place, niche: string): RecurringPlace[] {
  const UK = place.countryCode === 'GB' || place.countryCode === 'IE';
  return UK
    ? [
        { name: 'the kitchen table', kind: 'home', description: `where the ${niche} notebook lives, by the window onto the yard` },
        { name: 'the front room', kind: 'home', description: 'armchair, lamp, the good cushions nobody may sit on' },
        { name: 'the corner shop', kind: 'shop', description: 'two minutes up the road; prices on handwritten tickets' },
        { name: 'the bus stop on the main road', kind: 'transport', description: 'the number 7 into town, every twenty minutes' },
        { name: 'the community café', kind: 'social', description: 'Thursday cuppa with the friends; steamed-up windows in winter' },
        { name: 'the park by the library', kind: 'outdoors', description: 'a loop past the duck pond and the bandstand' },
      ]
    : [
        { name: 'the kitchen table', kind: 'home', description: `where the ${niche} notebook lives, next to the window over the yard` },
        { name: 'the porch', kind: 'home', description: 'two chairs, a cooler, a view of the street' },
        { name: 'the grocery store', kind: 'shop', description: 'a ten-minute drive; weekly shop with coupons' },
        { name: 'the diner on Main Street', kind: 'social', description: 'Saturday breakfast with friends, same booth every week' },
        { name: 'the church hall', kind: 'social', description: 'potlucks, bake sales and the community notice board' },
        { name: 'the walking trail by the creek', kind: 'outdoors', description: 'an easy loop; leaves in fall, mud in spring' },
      ];
}

export function buildBible(inp: DraftInput, now: Date): WorldBible {
  const place = resolvePlace(inp.homeBase, inp.timezone);
  const age = ageFromArchetype(inp.archetype);
  const cc = place.countryCode;
  const UK = cc === 'GB' || cc === 'IE';
  const cur = currencyOf(cc);
  const year = now.getUTCFullYear();
  const light = solsticeLight(place, year);
  const first = inp.name.split(' ')[0]!;
  const temp = (c: number) => `around ${Math.round(c)}°C`;
  const mid = (place.janC + place.julC) / 2;
  const southern = place.lat < 0;
  const coldC = southern ? place.julC : place.janC;
  const warmC = southern ? place.janC : place.julC;
  return {
    self: { name: inp.name, age, accent: place.accent, era: eraOf(inp.homeBase), background: [inp.archetype, inp.lore].filter(Boolean).join('. ').slice(0, 600) },
    place: {
      city: place.city,
      region: place.region,
      country: place.country,
      countryCode: cc,
      timezone: place.timezone,
      lat: place.lat,
      lon: place.lon,
      neighbourhood: UK ? `a quiet street of ${dwellingOf(inp.homeBase).includes('terrace') ? 'terraces' : 'semis'} ten minutes from the town centre` : 'a residential street a short drive from downtown',
      janC: place.janC,
      julC: place.julC,
    },
    home: {
      dwelling: dwellingOf(inp.homeBase),
      layout: UK
        ? 'front room with a bay window onto the street, kitchen at the back over a small yard, two bedrooms up a steep staircase, a cupboard under the stairs for everything'
        : 'front porch into a living room, kitchen with a window over the back yard, two bedrooms down the hall, a garage full of "useful" things',
      details: ['a wall calendar by the kettle', 'a biscuit tin of receipts and notes', 'a radiator that knocks in winter', 'a windowsill of plants that are mostly alive'],
    },
    recurringPlaces: placesFor(place, inp.niche),
    cast: castFor(inp, place, age),
    routine: {
      daily: [
        `up at 7, tea and the radio`,
        `morning walk or errands`,
        `the ${inp.niche} notebook at the kitchen table after lunch`,
        `phone call with the sister around 6`,
        'lamp on, telly or a book in the evening',
      ],
      weekly: [UK ? 'Monday: wash day' : 'Monday: laundry', UK ? 'Thursday: cuppa at the community café' : 'Saturday: breakfast at the diner', 'Friday: the weekly shop', `Sunday: planning the week for ${first}'s posts`],
    },
    seasons: {
      winter: `${temp(coldC)}; short days (${southern ? light.jun : light.dec} at midwinter); dark by late afternoon, heating on, coats and scarves`,
      spring: `${temp(mid)}; lighter evenings, showers, first garden jobs`,
      summer: `${temp(warmC)}; long light evenings (${southern ? light.dec : light.jun} at midsummer); windows open, lighter clothes`,
      autumn: `${temp(mid - 1)}; leaves down, wet and windy spells, the clocks go back`,
    },
    holidays: holidayCalendar(cc, year).map((h) => h.name),
    localEvents: [],
    localLife: {
      currency: cur.code,
      typicalPrices: UK
        ? [`loaf of bread ${cur.symbol}1.40`, `bus fare into town ${cur.symbol}2`, `cup of tea at the café ${cur.symbol}1.80`, `pint of milk ${cur.symbol}0.95`]
        : [`loaf of bread ${cur.symbol}3.50`, `gallon of gas ${cur.symbol}3.30`, `diner coffee ${cur.symbol}2.50`, `gallon of milk ${cur.symbol}4`],
      shops: UK ? ['the corner shop', 'a discount supermarket', 'the charity shop', 'the chemist', 'the bakery on the high street'] : ['the grocery store', 'a dollar store', 'the thrift store', 'the pharmacy', 'the hardware store'],
      commute: UK ? 'no car; the bus into town or a walk' : 'an old sedan; everything is a short drive',
    },
  };
}

/** The 12-week arc: four chapters of three weeks, two beats a week (setup, gags, callbacks, cliffhangers, payoffs). */
export function buildStoryline(inp: DraftInput, bible: WorldBible, startsOn: Date, season = 1, extra: { callbacks?: readonly string[]; reactions?: readonly string[] } = {}): Storyline {
  const first = inp.name.split(' ')[0]!;
  const by = (rel: RegExp) => bible.cast.find((c) => rel.test(c.relation));
  const sister = by(/sister|brother|friend/) ?? bible.cast[0];
  const neighbour = by(/neighbou?r/) ?? bible.cast[1] ?? sister;
  const young = by(/grand|flatmate|roommate|niece|nephew/) ?? bible.cast[2] ?? neighbour;
  const shop = by(/shop/) ?? neighbour;
  const n = (c: CastMember | undefined) => c?.name ?? 'a neighbour';
  const niche = inp.niche;
  const startIso = startsOn.toISOString().slice(0, 10);
  // Holidays inside the arc become chapter-3 pressure points (local ones only).
  const inArc = [startsOn.getUTCFullYear(), startsOn.getUTCFullYear() + 1]
    .flatMap((y) => holidayCalendar(bible.place.countryCode, y))
    .filter((h) => h.date >= addDays(startIso, 42) && h.date <= addDays(startIso, ARC_WEEKS * 7));
  const event = inArc[0]?.name ?? (season % 2 ? 'the change of season' : 'the end of the month');
  const kitchen = bible.recurringPlaces.find((p) => p.kind === 'home')?.name ?? 'the kitchen table';
  const social = bible.recurringPlaces.find((p) => p.kind === 'social')?.name ?? 'the café';
  const s2 = season > 1 ? ` (season ${season})` : '';
  const callbacks = extra.callbacks?.length ? extra.callbacks : [`${first}'s first notebook page`, `${n(neighbour)}'s "I'll never need that" line`];
  const ch = (i: number, title: string, tension: string, payoff: string, subplots: string[], beats: Array<[number, StoryBeat['kind'], string]>): StoryChapter => ({
    id: `s${season}c${i}`,
    title,
    weeks: [(i - 1) * 3 + 1, i * 3],
    tension,
    payoff,
    subplots,
    beats: beats.map(([w, kind, text], j) => ({ id: `s${season}c${i}b${j + 1}`, week: (i - 1) * 3 + w, kind, text })),
  });
  const chapters: StoryChapter[] = [
    ch(1, `${first} starts the notebook${s2}`, `${n(sister)} thinks the whole ${niche} thing is a phase`, `the first small win, shown at ${kitchen}`, [`${n(neighbour)} keeps "popping round" at the worst moment`], [
      [1, 'setup', `${first} explains why ${niche} matters now, at ${kitchen}, with the notebook open`],
      [1, 'gag', `${n(neighbour)} leans over the wall mid-explanation with an unasked-for opinion`],
      [2, 'development', `the first real try goes slightly wrong; ${first} laughs it off and adjusts`],
      [2, 'callback', `${n(sister)} on the phone: "told you" — ${first} replies with one calm number`],
      [3, 'development', `a tip learned the hard way, told as a story from ${first}'s past`],
      [3, 'payoff', `first small win of the season: ${first} shows the notebook page that worked`],
    ]),
    ch(2, `${n(neighbour)} wants in`, `${n(neighbour)} copies the idea badly and blames the method`, `${n(neighbour)} asks properly for help, on camera`, [`a feud with ${n(shop)} over prices`], [
      [4, 'setup', `${n(neighbour)} announces he's "doing ${niche} now" after watching one video`],
      [4, 'gag', `${n(shop)} raises an eyebrow at ${n(neighbour)}'s new "system"`],
      [5, 'development', `${first} spots ${n(neighbour)}'s mistake and explains the fix without saying "I told you"`],
      [5, 'callback', `the first notebook page comes back out to settle an argument`],
      [6, 'cliffhanger', `${n(neighbour)} makes a big decision without asking anyone; ${first} hears about it at ${social}`],
      [6, 'payoff', `${n(neighbour)} knocks on the door and asks for help, properly this time`],
    ]),
    ch(3, `The ${event} test`, `${event} puts pressure on every good habit`, `${first} gets through ${event} on plan and shares exactly how`, [`${n(young)} needs help but won't admit it`], [
      [7, 'setup', `${event} is coming; ${first} lays out the plan at ${kitchen}`],
      [7, 'development', `${n(friend(bible))} at ${social} admits she always overdoes ${event}`],
      [8, 'gag', `${n(young)} tries to "help" with ${event} preparations and makes it worse`],
      [8, 'callback', `${first} remembers how ${event} went years ago and what changed`],
      [9, 'cliffhanger', `an unexpected cost lands the week before ${event}`],
      [9, 'payoff', `${event} done on plan; ${first} shows the receipt pile and the notebook`],
    ]),
    ch(4, `${n(young)}'s big ask`, `${n(young)} asks for help with something bigger than a tip`, `season milestone: ${first} hands over a written plan and a promise`, [`${n(sister)} quietly starts using the method`], [
      [10, 'setup', `${n(young)} turns up with a problem and a box of biscuits`],
      [10, 'development', `${first} breaks the problem into three steps, the way the season taught`],
      [11, 'callback', `${n(sister)} admits she's been using the notebook trick for weeks`],
      [11, 'gag', `${n(neighbour)} claims he invented the method`],
      [12, 'milestone', `twelve weeks of the notebook: ${first} reads back the first page and the latest one`],
      [12, 'cliffhanger', `a letter arrives that sets up next season; ${first} won't say what it is yet`],
    ]),
  ];
  return {
    season,
    title: season > 1 ? `${first}: season ${season}` : `${first}'s first season`,
    premise: `${inp.premise} Over twelve weeks ${first} turns a private notebook into a habit the whole street ends up copying${extra.reactions?.length ? `; the audience loved ${extra.reactions.slice(0, 2).join(' and ')}, so those come back` : ''}.`,
    weeks: ARC_WEEKS,
    chapters,
    runningGags: [`${n(neighbour)} appears over the wall at the worst moment`, `the radiator that knocks whenever ${first} makes a serious point`],
    callbacks: [...callbacks],
    milestones: ['week 3: first win', 'week 6: the neighbour asks for help', `week 9: through ${event} on plan`, 'week 12: season finale'],
  };
}

const friend = (b: WorldBible): CastMember | undefined => b.cast.find((c) => c.relation === 'friend');

export function draftSummary(bible: WorldBible, storyline: Storyline): string {
  const p = bible.place;
  const cast = bible.cast.slice(0, 4).map((c) => `${c.name} (${c.relation})`).join(', ');
  return `${bible.self.name} lives in a ${bible.home.dwelling} in ${p.city}${p.region ? `, ${p.region}` : ''} (${p.country}; ${p.timezone})${bible.self.era ? `, in ${bible.self.era}` : ''}. Recurring cast: ${cast}. Season 1, "${storyline.title}": ${storyline.chapters.map((c) => c.title).join(' → ')}.`;
}

export function fakeWorldDraft(q: WorldDraftRequest, now: Date): WorldDraft {
  const inp = inputOf(q);
  const bible = buildBible(inp, now);
  const storyline = buildStoryline(inp, bible, now);
  return { summary: draftSummary(bible, storyline), place: { city: bible.place.city, region: bible.place.region, country: bible.place.country, timezone: bible.place.timezone }, bible: bible as unknown as Record<string, unknown>, storyline: storyline as unknown as Record<string, unknown> };
}

export { pickFrom };
