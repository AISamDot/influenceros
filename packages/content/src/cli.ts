// `pnpm content <command>`: the content pipeline from the terminal.
//   dry-run [--winner] [--tz <IANA zone>]   persona → week → hook-lab + scripts → Q1 → Gate → media.render, on fakes in memory
//   plan <persona-slug> [--this-week]       plan a week on the real database and queue its slots (the worker runs them)
//   run <persona-slug>                      run every planned slot of this and next week inline (idea → … → media_queued)
//   monetize <persona-slug>                 run the Monetization Agent's cycle inline
// The real-database commands need DATABASE_URL, or a stopped dev server when using local PGlite (they refuse while it runs).
import { createServices } from '@ios/agents';
import { getStudio } from '@ios/core';
import { exitOnOpenError, getDb } from '@ios/db';
import { planWeek } from './calendar';
import { enqueueSlot } from './jobs';
import { runMonetizationCycle } from './monetization';
import { processSlot } from './pipeline';
import { DAY_MS, mondayUtc } from './util';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string) => rest.includes(`--${name}`);
const opt = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));

async function realServices(slug: string | undefined) {
  if (!slug) throw new Error('give a persona slug');
  const db = await getDb().catch((err) => exitOnOpenError('content', err));
  const studio = await getStudio(db);
  const p = await db.maybeOne<{ id: string; name: string }>('SELECT id, name FROM persona WHERE studio_id = $1 AND slug = $2', [studio.id, slug]);
  if (!p) throw new Error(`no persona "${slug}"`);
  return { db, persona: p, services: createServices({ db, mode: 'auto' }) };
}

async function main() {
  switch (cmd) {
    case 'dry-run': {
      const { dryRun } = await import('./dryrun');
      const r = await dryRun({ state: flag('winner') ? 'SCALING' : 'TESTING', timezone: opt('tz') });
      console.log(`\n${r.persona.name} · ${r.persona.state} · ${r.persona.timezone} · ${r.postsPerWeek} posts planned for next week\n`);
      console.log(`${pad('when (UTC)', 17)} ${pad('format', 13)} ${pad('purpose', 7)} ${pad('CTA', 7)} ${pad('Q1', 9)} ${pad('Gate', 6)} ${pad('stage', 13)} shipped hook`);
      for (const s of r.slots) {
        console.log(
          `${pad(s.at.slice(0, 16).replace('T', ' '), 17)} ${pad(s.format, 13)} ${pad(s.purpose, 7)} ${pad(s.ctaKeyword ?? '', 7)} ${pad(s.q1Pass === null ? '' : `${s.q1Pass ? 'pass' : 'FAIL'}${s.fixLoops ? ` +${s.fixLoops}` : ''}`, 9)} ${pad(s.verdict ?? '', 6)} ${pad(s.status, 13)} ${s.hook ?? s.title} (${s.hookScore ?? '-'})`,
        );
      }
      console.log(`\nmedia.render jobs queued: ${r.mediaJobs.length} (IOS-3 handles them)`);
      const v = r.mediaJobs.find((j) => j.voiceover);
      if (v) console.log(`example voiceover (TTS-safe): ${v.voiceover}`);
      console.log(`\nMonetization: ${r.monetization.signals} signals, ${r.monetization.opportunities} opportunities, ${r.monetization.briefed.length} briefs, ${r.monetization.listings.length} listing packs, ${r.monetization.launches.length} launch plans`);
      for (const p of r.monetization.products) console.log(`  ${p.rung.padEnd(12)} ${p.priceCents ? `$${(p.priceCents / 100).toFixed(0)}` : 'free'.padEnd(3)}  ${p.name}`);
      if (r.q2) console.log(`\nQ2 voice: clean read ${r.q2.clean.pass ? 'pass' : 'FAIL'} (WER ${r.q2.clean.wer}); misheard read ${r.q2.misheard.pass ? 'pass' : 'FAIL'}: ${r.q2.misheard.message}`);
      console.log(`\nLedger (fake LLM, USD): ${r.ledger.map((l) => `${l.refType ?? 'none'} ${l.usd.toFixed(4)}`).join(' · ')}\n`);
      await r.close();
      return;
    }
    case 'plan': {
      const { db, persona, services } = await realServices(rest[0]);
      const ws = flag('this-week') ? mondayUtc(new Date()) : new Date(mondayUtc(new Date()).getTime() + 7 * DAY_MS);
      const res = await planWeek(services, persona.id, ws);
      let queued = 0;
      for (const id of res.slotIds) if (await enqueueSlot(services, id, persona.id)) queued += 1;
      console.log(`${persona.name}: ${res.created} slots planned${res.skipped ? ` (${res.skipped})` : ''}, ${queued} queued for the pipeline.`);
      await db.close();
      return;
    }
    case 'run': {
      const { db, persona, services } = await realServices(rest[0]);
      const from = mondayUtc(new Date());
      const slots = await db.query<{ id: string; title: string }>(
        `SELECT id, title FROM calendar_slot WHERE persona_id = $1 AND status IN ('planned','scripted','q1','gate') AND slot_at >= $2 AND slot_at < $3 ORDER BY slot_at`,
        [persona.id, from, new Date(from.getTime() + 14 * DAY_MS)],
      );
      for (const s of slots) {
        const out = await processSlot(services, s.id);
        console.log(`${pad(out.status, 13)} ${pad(out.verdict ?? '', 6)} ${s.title}${out.blockReason ? `  ← ${out.blockReason}` : ''}`);
      }
      await db.close();
      return;
    }
    case 'monetize': {
      const { db, persona, services } = await realServices(rest[0]);
      console.log(JSON.stringify(await runMonetizationCycle(services, persona.id), null, 2));
      await db.close();
      return;
    }
    default:
      console.log('usage: pnpm content dry-run [--winner] [--tz <zone>] | plan <slug> [--this-week] | run <slug> | monetize <slug>');
      if (cmd && cmd !== 'help') process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`[content] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
