// `pnpm formats <command>`: stream L's CLI (docs/IOS-5-CONTRACTS.md). With local PGlite only one process may open the
// data dir: use a scratch PGLITE_DIR, never the dev server's.
import { getStudio } from '@ios/core';
import { exitOnOpenError, openDb } from '@ios/db';
import { FORMAT_LABEL, usd } from './catalog';
import { monthlyCostUsd, recommendPlan } from './plan';
import { planHistory, planInForce } from './store';
import { localDate } from './time';

const HELP = `pnpm formats <command>

  recommend <niche> <archetype…> [--budget 50]   the Studio Manager's Format Plan for a concept (no database)
  plan <persona-slug>                           the persona's Format Plan in force and its versions
  stories <persona-slug> [YYYY-MM-DD]           the persona's Story frames for a day (default: today, persona-local)`;

const flag = (args: string[], name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

function printPlan(plan: ReturnType<typeof recommendPlan>) {
  console.log(`${plan.postsPerWeek} feed posts a week · ${plan.stories.perDay} Stories a day · ~${usd(plan.costPerWeekUsd)}/week (~${usd(monthlyCostUsd(plan))}/month)\n`);
  for (const l of plan.lines.filter((x) => x.enabled)) console.log(`  ${String(l.perWeek).padStart(2)} × ${FORMAT_LABEL[l.format].padEnd(28)} ${usd(l.costPerWeekUsd).padStart(7)}/wk  ${l.reason}`);
  const off = plan.lines.filter((x) => !x.enabled).map((x) => FORMAT_LABEL[x.format]);
  if (off.length) console.log(`  off: ${off.join(', ')}`);
  console.log(`\n  Stories: ${plan.stories.mix.filter((m) => m.perDay).map((m) => `${m.perDay} ${m.kind}${m.kind === 'sell' ? ' (sell days)' : ''}`).join(', ')}`);
  console.log(`\n${plan.reason}`);
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(HELP);
    return cmd ? 0 : 1;
  }
  if (cmd === 'recommend') {
    const words = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--budget');
    const [niche, ...rest] = words;
    if (!niche) {
      console.log(HELP);
      return 1;
    }
    printPlan(recommendPlan({ niche, archetype: rest.join(' '), ladder: [], budgetUsdPerMonth: Number(flag(args, '--budget') ?? 53), benchmark: null }));
    return 0;
  }
  const db = await openDb().catch((err) => exitOnOpenError('formats', err));
  try {
    const studio = await getStudio(db);
    const slug = args[0];
    const p = slug ? await db.maybeOne<{ id: string; name: string; timezone: string }>('SELECT id, name, timezone FROM persona WHERE studio_id = $1 AND slug = $2', [studio.id, slug]) : null;
    if (!p) {
      console.error(slug ? `no persona ${slug}` : HELP);
      return 1;
    }
    switch (cmd) {
      case 'plan': {
        const plan = await planInForce(db, p.id, new Date());
        if (!plan) {
          console.log(`${p.name} has no Format Plan: the studio default applies (2/2/1/2/2/1, 4 Stories a day).`);
          return 0;
        }
        console.log(`${p.name}: Format Plan v${plan.version} (${plan.source})`);
        printPlan(plan);
        for (const h of await planHistory(db, p.id)) console.log(`  v${h.version} ${h.source} from ${h.effectiveFrom} by ${h.createdBy}`);
        return 0;
      }
      case 'stories': {
        const date = args[1] ?? localDate(new Date(), p.timezone);
        const frames = await db.query<{ seq: number; kind: string; status: string; text: string | null; gate_verdict: string | null; block_reason: string | null }>(
          'SELECT seq, kind, status, text, gate_verdict, block_reason FROM story_frame WHERE persona_id = $1 AND story_date = $2::date ORDER BY seq',
          [p.id, date],
        );
        console.log(`${p.name}, ${date}: ${frames.length} frames`);
        for (const f of frames) console.log(`  ${f.seq}. ${f.kind.padEnd(10)} ${f.status.padEnd(17)} ${f.gate_verdict ?? '-'}  ${f.text ?? ''}${f.block_reason ? `  [${f.block_reason}]` : ''}`);
        return 0;
      }
      default:
        console.log(HELP);
        return 1;
    }
  } finally {
    await db.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
