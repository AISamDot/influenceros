// `pnpm profit <command>`: Profit Engine commands. With local PGlite, stop `pnpm dev` first (one process per data
// dir) or set DATABASE_URL.
import { getStudio, OWNER } from '@ios/core';
import { exitOnOpenError, openDb } from '@ios/db';
import { rankActions } from './actions';
import { forecastStudio, storeForecasts } from './forecast';
import { leverInputs, measureLevers, planLevers, runLevers } from './levers';
import { PROFIT_JOBS } from './module';
import { pnlWithTotals } from './pnl';
import { enqueueOnce } from './scheduler';
import { getProfitSettings, type ProfitSettings, updateProfitSettings } from './settings';
import { periodRange } from './tools';
import type { PnlGrain } from './types';
import { isoDate, mondayOf } from './util';

const HELP = `pnpm profit <command>

  pnl [persona|post|format|product|platform] [--period mtd|last_week|last_7_days|last_30_days|last_90_days]
  forecast [--store]        90-day Monte Carlo forecast (P10 / median / P90)
  actions                   "how do we make more profit": ranked actions with $ impact
  levers [--apply]          what the levers would do now (dry run), or pull them
  measure                   measure lever actions whose review window has passed
  cycle                     queue this week's Profit Engine cycle (the worker runs it and posts the report)
  settings [key value]      show or change Profit Engine settings (Owner)`;

const usd = (c: number) => `${c < 0 ? '-' : ''}$${(Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length));
const lpad = (s: string, n: number) => (s.length >= n ? s : ' '.repeat(n - s.length) + s);
const flag = (args: string[], name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? '') : undefined;
};
const GRAINS: readonly PnlGrain[] = ['persona', 'post', 'format', 'product', 'platform'];

async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(HELP);
    return cmd ? 0 : 1;
  }
  const db = await openDb().catch((err) => exitOnOpenError('profit', err));
  try {
    const studio = await getStudio(db);
    const now = new Date();
    switch (cmd) {
      case 'pnl': {
        const grain = (args.find((a) => GRAINS.includes(a as PnlGrain)) ?? 'persona') as PnlGrain;
        const period = (flag(args, '--period') ?? 'mtd') as Parameters<typeof periodRange>[0];
        const range = periodRange(period, now);
        const { rows, totals } = await pnlWithTotals(db, { studioId: studio.id, ...range, grain });
        console.log(`P&L by ${grain}, ${isoDate(range.from)} → ${isoDate(range.to)}\n`);
        console.log(`${pad('', 34)}${lpad('sales', 12)}${lpad('fees+ref', 12)}${lpad('cost', 12)}${lpad('profit', 12)}${lpad('posts', 7)}`);
        for (const r of [...rows, { label: 'Total', ...totals }]) {
          console.log(
            `${pad(r.label, 34)}${lpad(usd(r.revenueCents), 12)}${lpad(usd(r.feesCents + r.refundsCents), 12)}${lpad(usd(r.costCents), 12)}${lpad(usd(r.profitCents), 12)}${lpad(String(r.posts), 7)}`,
          );
        }
        return 0;
      }
      case 'forecast': {
        const f = await forecastStudio(db, { studioId: studio.id, now });
        if (args.includes('--store')) await storeForecasts(db, studio.id, f, now);
        const t = f.studio.totalCents;
        console.log(`Studio 90-day profit: median ${usd(t.median)} (P10 ${usd(t.p10)}, P90 ${usd(t.p90)}), ${f.studio.runs} runs`);
        const names = new Map((await db.query<{ id: string; name: string }>('SELECT id, name FROM persona WHERE studio_id = $1', [studio.id])).map((p) => [p.id, p.name]));
        for (const p of f.personas) {
          console.log(`  ${pad(names.get(p.personaId!) ?? p.personaId!, 24)} ${lpad(usd(p.totalCents.median), 12)}  negative weeks ahead: ${p.negativeWeeks}`);
        }
        return 0;
      }
      case 'actions': {
        const list = await rankActions(db, studio.id, now);
        if (!list.length) console.log('Nothing to suggest yet: the studio needs a few weeks of posts and sales.');
        for (const a of list) {
          console.log(`${a.rank}. ${a.title}  ${usd(a.expectedImpactCents)}/month  [${a.confidence}${a.requiresOwner ? ', needs you' : ''}]\n   ${a.rationale}`);
        }
        return 0;
      }
      case 'levers': {
        if (args.includes('--apply')) {
          const applied = await runLevers(db, studio.id, now);
          console.log(applied.length ? applied.map((a) => `- ${a.rationale}`).join('\n') : 'No lever is due.');
        } else {
          const plans = await planLevers(await leverInputs(db, studio.id, now));
          console.log(plans.length ? plans.map((p) => `- ${p.rationale} (expected ${usd(p.expectedImpactCents)}/month)`).join('\n') : 'No lever is due.');
        }
        return 0;
      }
      case 'measure': {
        const r = await measureLevers(db, studio.id, now);
        console.log(`Measured ${r.measured.length}, reverted ${r.reverted.length}.`);
        return 0;
      }
      case 'cycle': {
        const week = isoDate(mondayOf(now));
        const queued = await enqueueOnce(db, { kind: PROFIT_JOBS.weeklyCycle, studioId: studio.id, payload: { studio_id: studio.id, week_start: week }, priority: 50 });
        console.log(queued ? `Queued the Profit Engine cycle for the week of ${week}; the worker runs it.` : `The cycle for the week of ${week} is already queued or done.`);
        return 0;
      }
      case 'settings': {
        const [key, value] = args;
        if (key) {
          const current = await getProfitSettings(db, studio.id);
          if (!(key in current) || typeof current[key as keyof ProfitSettings] !== 'number') {
            console.error(`unknown or non-numeric setting: ${key}`);
            return 1;
          }
          const n = Number(value);
          if (value === undefined || !Number.isFinite(n)) {
            console.error('value must be a number');
            return 1;
          }
          await updateProfitSettings(db, studio.id, { [key]: n } as Partial<ProfitSettings>, OWNER);
        }
        console.log(JSON.stringify(await getProfitSettings(db, studio.id), null, 2));
        return 0;
      }
      default:
        console.error(`unknown command: ${cmd}\n\n${HELP}`);
        return 1;
    }
  } finally {
    await db.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(`[profit] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
