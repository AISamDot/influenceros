export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(Math.round(n));
}

export function usd(cents: number, opts: { cents?: boolean } = {}): string {
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: opts.cents ? 2 : 0,
  });
}

export function money(amount: number, unit: string): string {
  if (unit === 'hf_credits') return `${Math.round(amount).toLocaleString('en-US')} cr`;
  return `$${amount.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' });
const TIME = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
const DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

export const weekday = (d: Date) => WEEKDAY.format(d);
export const time = (d: Date) => TIME.format(d);
export const shortDate = (d: Date) => DATE.format(d);

export function relative(d: Date, now = new Date()): string {
  const s = Math.round((now.getTime() - d.getTime()) / 1000);
  const a = Math.abs(s);
  const fmt = (v: number, u: string) => (s >= 0 ? `${v}${u} ago` : `in ${v}${u}`);
  if (a < 60) return 'just now';
  if (a < 3600) return fmt(Math.round(a / 60), 'm');
  if (a < 86_400) return fmt(Math.round(a / 3600), 'h');
  return fmt(Math.round(a / 86_400), 'd');
}

export const STATE_LABEL: Record<string, string> = {
  PROPOSED: 'Proposed',
  SETUP: 'Setup',
  TESTING: 'Testing',
  RE_ANGLE: 'Re-angle',
  MONETISING: 'Monetising',
  SCALING: 'Scaling',
  BRAND: 'Brand',
  KILLED: 'Killed',
  RETIRED: 'Retired',
};

export const FORMAT_LABEL: Record<string, string> = {
  talking: 'Talking',
  activity_text: 'Activity + text',
  voiceover: 'Voiceover',
  static: 'Static',
  carousel: 'Carousel',
};

export const daysSince = (d: Date | null, now = new Date()) =>
  d ? Math.max(0, Math.floor((now.getTime() - new Date(d).getTime()) / 86_400_000)) : null;
