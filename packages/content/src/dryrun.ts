import { MEDIA_RENDER_JOB, type MediaRenderPayload, type StudioServices } from '@troupe/agents';
import { createTestStudio, makeTestPersona } from '@troupe/agents/testing';
import type { PersonaState } from '@troupe/core';
import { planWeek } from './calendar';
import { type CycleSummary, runMonetizationCycle } from './monetization';
import { processSlot, type SlotOutcome } from './pipeline';
import { voiceCheck } from './qc';
import { attachSampleBible } from './sample';
import { DAY_MS, mondayUtc } from './util';

/**
 * The end-to-end dry run on fakes (no keys, in-memory PGlite): persona → week of slots → hook-lab + scripts → Q1 →
 * Gate → `media.render` jobs, plus a Monetization Agent cycle and a Q2 voice check (perfect and misheard).
 */
export interface DryRunReport {
  persona: { id: string; name: string; state: PersonaState; timezone: string };
  postsPerWeek: number;
  slots: Array<{
    slotId: string;
    at: string;
    window: string | null;
    format: string;
    purpose: string;
    pillar: string | null;
    title: string;
    ctaKeyword: string | null;
    hook: string | null;
    hookScore: number | null;
    variants: string[];
    q1Pass: boolean | null;
    fixLoops: number;
    verdict: string | null;
    status: string;
  }>;
  mediaJobs: MediaRenderPayload[];
  monetization: CycleSummary & { products: Array<{ name: string; rung: string; priceCents: number; status: string }> };
  q2: { clean: { pass: boolean; wer: number }; misheard: { pass: boolean; wer: number; message: string } } | null;
  ledger: Array<{ refType: string | null; usd: number }>;
  services: StudioServices;
  close(): Promise<void>;
}

export async function dryRun(opts: { state?: PersonaState; timezone?: string; now?: Date; name?: string } = {}): Promise<DryRunReport> {
  const now = opts.now ?? new Date();
  const t = await createTestStudio({ now: () => now });
  const persona = await makeTestPersona(t, { name: opts.name ?? 'Nora Vale', niche: 'Personal finance', state: opts.state ?? 'TESTING', timezone: opts.timezone ?? 'America/New_York' });
  await attachSampleBible(t.db, persona.id);
  const services = t.services;

  // Monetization first (FR-20.1: a lead magnet and an entry product so the persona can sell from day 1).
  const cycle = await runMonetizationCycle(services, persona.id, now);
  await t.db.query(`UPDATE product SET status = 'live' WHERE persona_id = $1`, [persona.id]); // stand-in for v1 build + Owner approval

  const nextWeek = new Date(mondayUtc(now).getTime() + 7 * DAY_MS);
  const plan = await planWeek(services, persona.id, nextWeek, { now });
  const outcomes: SlotOutcome[] = [];
  for (const id of plan.slotIds) outcomes.push(await processSlot(services, id));

  const rows = await t.db.query<{
    id: string; slot_at: Date; posting_window: string | null; format: string; purpose: string; pillar: string | null; title: string; cta_keyword: string | null;
    status: string; hook: string | null; hooks: { shipped?: { score: number }; variants?: Array<{ text: string }> } | null; fix_loops: number | null;
  }>(
    `SELECT s.id, s.slot_at, s.posting_window, s.format, s.purpose, s.pillar, s.title, s.cta_keyword, s.status, sc.hook, sc.hooks, sc.fix_loops
       FROM calendar_slot s LEFT JOIN script sc ON sc.id = s.script_id WHERE s.persona_id = $1 ORDER BY s.slot_at`,
    [persona.id],
  );
  const jobs = await t.db.query<{ payload: MediaRenderPayload }>(`SELECT payload FROM job WHERE kind = $1 ORDER BY created_at`, [MEDIA_RENDER_JOB]);

  // Q2: synthesise the first spoken script with the fake voice, re-transcribe it, then once more with a misheard word.
  let q2: DryRunReport['q2'] = null;
  const spoken = jobs.find((j) => j.payload.voiceover);
  if (spoken?.payload.voiceover) {
    const tts = await services.providers.voice.tts({ voiceId: 'voice_sample', text: spoken.payload.voiceover });
    const clean = await voiceCheck(services, { studioId: t.studioId, personaId: persona.id, scriptId: spoken.payload.scriptId, audioUrl: tts.url });
    const kw = spoken.payload.ctaKeyword;
    const misheardProviders = (await import('@troupe/providers')).createFakeProviders({ mishear: (text) => text.replace(new RegExp(`\\b${kw}\\b`, 'i'), 'PLANT') });
    const tts2 = await misheardProviders.voice.tts({ voiceId: 'voice_sample', text: spoken.payload.voiceover });
    const bad = await voiceCheck({ ...services, providers: misheardProviders }, { studioId: t.studioId, personaId: persona.id, scriptId: spoken.payload.scriptId, audioUrl: tts2.url });
    q2 = {
      clean: { pass: clean.pass, wer: clean.wer },
      misheard: { pass: bad.pass, wer: bad.wer, message: bad.checks.find((c) => c.check === 'mispronunciation')?.message ?? '' },
    };
  }
  const products = await t.db.query<{ name: string; ladder_rung: string; price_cents: number; status: string }>(
    `SELECT name, ladder_rung, price_cents, status FROM product WHERE persona_id = $1 ORDER BY price_cents`,
    [persona.id],
  );
  const ledger = await t.db.query<{ ref_type: string | null; usd: number }>(
    `SELECT ref_type, round(sum(amount)::numeric, 6)::float8 AS usd FROM credit_ledger WHERE persona_id = $1 AND entry_type = 'debit' GROUP BY ref_type ORDER BY ref_type`,
    [persona.id],
  );
  const pState = await t.db.one<{ state: PersonaState }>('SELECT state FROM persona WHERE id = $1', [persona.id]);
  return {
    persona: { id: persona.id, name: persona.name, state: pState.state, timezone: opts.timezone ?? 'America/New_York' },
    postsPerWeek: plan.target?.postsPerWeek ?? 0,
    slots: rows.map((r) => ({
      slotId: r.id,
      at: new Date(r.slot_at).toISOString(),
      window: r.posting_window,
      format: r.format,
      purpose: r.purpose,
      pillar: r.pillar,
      title: r.title,
      ctaKeyword: r.cta_keyword,
      hook: r.hook,
      hookScore: r.hooks?.shipped?.score ?? null,
      variants: (r.hooks?.variants ?? []).map((v) => v.text),
      q1Pass: outcomes.find((o) => o.slotId === r.id)?.q1Pass ?? null,
      fixLoops: r.fix_loops ?? 0,
      verdict: outcomes.find((o) => o.slotId === r.id)?.verdict ?? null,
      status: r.status,
    })),
    mediaJobs: jobs.map((j) => j.payload),
    monetization: { ...cycle, products: products.map((p) => ({ name: p.name, rung: p.ladder_rung, priceCents: p.price_cents, status: p.status })) },
    q2,
    ledger: ledger.map((l) => ({ refType: l.ref_type, usd: Number(l.usd) })),
    services,
    close: () => t.db.close(),
  };
}
