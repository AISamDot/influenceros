/**
 * TTS pronunciation safety (QC Q1): numbers, money, percentages, times, symbols, abbreviations and acronyms are
 * rewritten into words before the text reaches the voice, so ElevenLabs never has to guess. Pure and deterministic.
 */

const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen',
  'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES: Array<[number, string]> = [
  [1e12, 'trillion'],
  [1e9, 'billion'],
  [1e6, 'million'],
  [1e3, 'thousand'],
];

function under1000(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const parts: string[] = [];
  if (h) parts.push(`${ONES[h]} hundred`);
  if (r) parts.push(r < 20 ? ONES[r]! : TENS[Math.floor(r / 10)]! + (r % 10 ? `-${ONES[r % 10]}` : ''));
  return parts.join(' ') || 'zero';
}

/** 1234 → "one thousand two hundred thirty-four"; 3.5 → "three point five". */
export function numberToWords(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (n < 0) return `minus ${numberToWords(-n)}`;
  const [intPart, frac] = String(n).split('.');
  let i = Number(intPart);
  const out: string[] = [];
  if (i === 0) out.push('zero');
  for (const [v, name] of SCALES) {
    if (i >= v) {
      out.push(`${under1000(Math.floor(i / v))} ${name}`);
      i %= v;
    }
  }
  if (i > 0) out.push(under1000(i));
  let s = out.join(' ');
  if (frac) s += ` point ${[...frac].map((d) => ONES[Number(d)]).join(' ')}`;
  return s;
}

/** 2027 → "twenty twenty-seven"; 2005 → "two thousand five"; 1999 → "nineteen ninety-nine". */
export function yearToWords(y: number): string {
  if (y >= 2000 && y < 2010) return numberToWords(y);
  const hi = Math.floor(y / 100);
  const lo = y % 100;
  return `${numberToWords(hi)} ${lo === 0 ? 'hundred' : lo < 10 ? `oh ${ONES[lo]}` : numberToWords(lo)}`;
}

export function ordinalToWords(n: number): string {
  const w = numberToWords(n);
  const special: Record<string, string> = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' };
  const m = w.match(/([a-z]+)$/)!;
  const last = m[1]!;
  const repl = special[last] ?? (last.endsWith('y') ? `${last.slice(0, -1)}ieth` : `${last}th`);
  return w.slice(0, w.length - last.length) + repl;
}

const parseNum = (s: string) => Number(s.replace(/,/g, ''));
const MULT: Record<string, number> = { k: 1e3, K: 1e3, m: 1e6, M: 1e6, b: 1e9, B: 1e9 };
const CURRENCY: Record<string, [string, string]> = { $: ['dollar', 'dollars'], '£': ['pound', 'pounds'], '€': ['euro', 'euros'] };

/** Acronyms that read badly letter-merged; spoken forms. Unknown short all-caps tokens are spelled out letter by letter. */
const ACRONYMS: Record<string, string> = {
  AI: 'A-I',
  BNPL: 'buy now, pay later',
  ETF: 'E-T-F',
  ETFS: 'E-T-Fs',
  APR: 'A-P-R',
  APY: 'A-P-Y',
  IRA: 'I-R-A',
  ROI: 'R-O-I',
  FAQ: 'F-A-Q',
  DIY: 'D-I-Y',
  ADHD: 'A-D-H-D',
  POV: 'P-O-V',
  DM: 'D-M',
  DMS: 'D-Ms',
  PDF: 'P-D-F',
  CEO: 'C-E-O',
  USA: 'U-S-A',
  UK: 'U-K',
  US: 'U-S',
  TV: 'T-V',
  OK: 'okay',
};
const ABBREV: Array<[RegExp, string]> = [
  [/\be\.g\.,?/gi, 'for example,'],
  [/\bi\.e\.,?/gi, 'that is,'],
  [/\betc\./gi, 'and so on'],
  [/\bvs\.?(?=\s)/gi, 'versus'],
  [/\bapprox\.?(?=\s)/gi, 'about'],
  [/\bw\/(?=\s)/gi, 'with'],
  [/\bw\/o\b/gi, 'without'],
];
const UNITS: Record<string, string> = {
  lb: 'pounds', lbs: 'pounds', kg: 'kilos', kgs: 'kilos', km: 'kilometres', mi: 'miles', hr: 'hours', hrs: 'hours',
  min: 'minutes', mins: 'minutes', sec: 'seconds', secs: 'seconds', oz: 'ounces', g: 'grams', ml: 'millilitres',
};
const PER: Record<string, string> = { mo: 'a month', month: 'a month', wk: 'a week', week: 'a week', yr: 'a year', year: 'a year', day: 'a day', hr: 'an hour', hour: 'an hour' };

export interface TtsRisk {
  readonly token: string;
  readonly kind: 'number' | 'money' | 'percent' | 'time' | 'symbol' | 'acronym' | 'abbreviation' | 'url' | 'emoji' | 'hashtag';
  readonly spoken: string;
}

const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}]/gu;

/**
 * Rewrites `text` for the voice. `keep` lists words to leave exactly as written (e.g. the CTA keyword, which the
 * caption repeats). Returns the TTS-safe text and every rewrite it made (Q1 reports them).
 */
export function ttsNormalize(text: string, opts: { keep?: readonly string[] } = {}): { text: string; risks: TtsRisk[] } {
  const risks: TtsRisk[] = [];
  const keep = new Set((opts.keep ?? []).map((k) => k.toUpperCase()));
  const sub = (re: RegExp, kind: TtsRisk['kind'], fn: (m: string, ...g: string[]) => string) => {
    s = s.replace(re, (m: string, ...g: string[]) => {
      const spoken = fn(m, ...g);
      if (spoken !== m) risks.push({ token: m.trim(), kind, spoken: spoken.trim() });
      return spoken;
    });
  };
  let s = text;
  sub(/\s?(?:\bhttps?:\/\/\S+|\bwww\.\S+)/gi, 'url', () => '');
  sub(EMOJI_RE, 'emoji', () => '');
  sub(/(^|\s)#[A-Za-z][\w]*/g, 'hashtag', (_m, pre: string) => pre);
  for (const [re, spoken] of ABBREV) sub(re, 'abbreviation', () => spoken);
  // Pence: 50p · £0.99 (Dot is UK: "a 75p tin" is "seventy-five p", never "seven five p")
  sub(/£0\.(\d{1,2})\b/g, 'money', (_m, c: string) => `${numberToWords(Number(c.padEnd(2, '0')))} p`);
  sub(/\b(\d{1,3})p\b/g, 'money', (_m, n: string) => `${numberToWords(Number(n))} p`);
  // Money: $1,200 · $5K · $2.50 · £40 · $5K/month
  sub(/([$£€])(\d[\d,]*(?:\.\d+)?)(?:\s?([kKmMbB])\b)?(?:\s?\/\s?(mo|month|wk|week|yr|year|day|hr|hour)\b)?/g, 'money', (_m, cur: string, num: string, mult: string, per: string) => {
    const [one, many] = CURRENCY[cur]!;
    const value = parseNum(num) * (mult ? MULT[mult]! : 1);
    let spoken: string;
    if (!mult && num.includes('.') && Number(num.split('.')[1]) > 0) {
      const [d, c] = num.split('.');
      const dollars = parseNum(d!);
      spoken = `${numberToWords(dollars)} ${dollars === 1 ? one : many} ${numberToWords(Number(c!.padEnd(2, '0').slice(0, 2)))}`;
    } else spoken = `${numberToWords(Math.round(value))} ${value === 1 ? one : many}`;
    return per ? `${spoken} ${PER[per]}` : spoken;
  });
  sub(/(\d+(?:\.\d+)?)\s?%/g, 'percent', (_m, n: string) => `${numberToWords(Number(n))} percent`);
  sub(/\b(\d{1,2}):(\d{2})\s?(am|pm|a\.m\.|p\.m\.)?/gi, 'time', (_m, h: string, mm: string, ap: string) => {
    const mins = Number(mm);
    const spokenMins = mins === 0 ? '' : mins < 10 ? ` oh ${numberToWords(mins)}` : ` ${numberToWords(mins)}`;
    const suffix = ap ? ` ${ap.toLowerCase().startsWith('a') ? 'a.m.' : 'p.m.'}` : '';
    return `${numberToWords(Number(h))}${spokenMins}${suffix}`;
  });
  sub(/\b(\d{1,2})\s?(am|pm)\b/gi, 'time', (_m, h: string, ap: string) => `${numberToWords(Number(h))} ${ap.toLowerCase() === 'am' ? 'a.m.' : 'p.m.'}`);
  sub(/\b401\s?\(?k\)?/gi, 'acronym', () => 'four-oh-one-K');
  sub(/\b24\/7\b/g, 'number', () => 'twenty-four seven');
  sub(/\b(\d+)(st|nd|rd|th)\b/gi, 'number', (_m, n: string) => ordinalToWords(Number(n)));
  sub(/\b(\d+(?:\.\d+)?)\s?[xX]\b/g, 'number', (_m, n: string) => `${numberToWords(Number(n))} times`);
  sub(/\b(\d+)\s?[-–]\s?(\d+)\b/g, 'number', (_m, a: string, b: string) => `${numberToWords(Number(a))} to ${numberToWords(Number(b))}`);
  sub(/\b(\d+)\/(\d+)(?:\/(\d+))?\b/g, 'number', (_m, a: string, b: string, c: string) => [a, b, c].filter(Boolean).map((x) => numberToWords(Number(x))).join(' '));
  sub(/\b(\d[\d,]*(?:\.\d+)?)\s?([kKmM])\b/g, 'number', (_m, n: string, mult: string) => numberToWords(Math.round(parseNum(n) * MULT[mult]!)));
  sub(/\b(\d[\d,]*(?:\.\d+)?)\s?(lbs?|kgs?|km|mi|hrs?|mins?|secs?|oz|g|ml)\b/g, 'number', (_m, n: string, u: string) => `${numberToWords(parseNum(n))} ${UNITS[u.toLowerCase()]}`);
  sub(/\b(1[1-9]\d\d|20\d\d)\b(?![,.]?\d)/g, 'number', (_m, y: string) => yearToWords(Number(y)));
  sub(/\b\d[\d,]*(?:\.\d+)?\b/g, 'number', (m) => numberToWords(parseNum(m)));
  sub(/\s&\s/g, 'symbol', () => ' and ');
  sub(/(\w)\+(?=\s|$)/g, 'symbol', (_m, w: string) => `${w} plus`);
  sub(/\s\+\s/g, 'symbol', () => ' plus ');
  sub(/\s@\s/g, 'symbol', () => ' at ');
  sub(/\s?(->|→|=>)\s?/g, 'symbol', () => ', then ');
  sub(/~\s?/g, 'symbol', () => 'about ');
  sub(/\s=\s/g, 'symbol', () => ' equals ');
  sub(/\b(and|or)\/(and|or)\b/gi, 'symbol', (_m, a: string, b: string) => `${a} or ${b}`);
  sub(/\b[A-Z]{2,5}s?\b/g, 'acronym', (m) => {
    if (keep.has(m) || keep.has(m.replace(/s$/, ''))) return m;
    const known = ACRONYMS[m] ?? ACRONYMS[m.toUpperCase()];
    if (known) return known;
    // All-caps real words (comment keywords like PLAN, SHEET) read fine; short or vowel-less tokens get spelled out.
    if (m.length >= 4 && /[AEIOUY]/.test(m)) return m;
    return m.split('').join('-');
  });
  s = s.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1').trim();
  return { text: s, risks };
}

/** Tokens TTS is still likely to mispronounce after normalising (should be empty). */
export function residualTtsRisks(text: string): string[] {
  const out = text.match(/[\d$£€%#@&*^_|<>{}[\]\\+=~]|https?:\/\//g) ?? [];
  return [...new Set(out)];
}
