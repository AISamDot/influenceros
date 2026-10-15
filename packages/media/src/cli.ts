// `pnpm media <command>`: stream E's media pipeline from the terminal (docs/IOS-34-CONTRACTS.md).
//   status                 which media providers are live, the FFmpeg build, the Higgsfield CLI and Apple Vision
//   sample <format>        one real post (talking | activity_text | voiceover | static | carousel) on a scratch database,
//                          with the Higgsfield and ElevenLabs keys; credits debited through the governor. Without the keys
//                          it reports "pending key" and spends nothing.
//   probe-costs            print `higgsfield generate cost` for the model grid (the worker's weekly job writes the table)
// None of these opens the studio database, so they are safe while the dev server runs.
import { createServices, MEDIA_RENDER_JOB, type MediaRenderPayload, type ProviderEnv } from '@ios/agents';
import { attachSampleBible, liveProviders as contentLive, planWeek, processSlot } from '@ios/content';
import { DEFAULT_SETTINGS, type PostFormat } from '@ios/core';
import { json } from '@ios/db';
import { createTestDb } from '@ios/db/testing';
import { createFakeProviders, type Providers } from '@ios/providers';
import { defaultBackend, integrationStates, isSecretName, readSecret } from '@ios/secrets';
import { GEN_RESOLUTION, mediaModels, PROBE_GRID } from './config';
import { mediaDeps } from './deps';
import { resolveBins } from './ffmpeg';
import { mediaDir, mediaLiveProviders } from './live';
import { renderSlot } from './render';
import { slotMedia } from './read';
import { appleVisionAvailable } from './vision';

const FORMATS: readonly PostFormat[] = ['talking', 'activity_text', 'voiceover', 'static', 'carousel'];
const [cmd, ...rest] = process.argv.slice(2);

function penv(): ProviderEnv {
  const backend = defaultBackend(process.env);
  const live = new Set(integrationStates(backend, process.env).filter((s) => s.mode === 'live').map((s) => s.def.id));
  return { isLive: (id) => live.has(id), secret: (name) => (isSecretName(name) ? (readSecret(name, backend, process.env)?.reveal() ?? null) : null) };
}

function providers(env: ProviderEnv): Providers {
  return { ...createFakeProviders(), ...contentLive(env), ...mediaLiveProviders(env) } as Providers;
}

async function status() {
  const env = penv();
  const p = providers(env);
  const bins = resolveBins();
  console.log(`image/video  ${p.imageVideo.name}${env.isLive('higgsfield') ? '' : '  (pending key: higgsfield.api_key + higgsfield.api_secret)'}`);
  console.log(`talking      ${p.talking.name === 'higgsfield-seedance' || env.isLive('higgsfield') ? 'higgsfield-seedance' : `${p.talking.name} (Seedance via image/video when Higgsfield is live)`}`);
  console.log(`voice        ${p.voice.name}${env.isLive('elevenlabs') ? '' : '  (pending key: elevenlabs.api_key)'}`);
  console.log(`storage      ${p.storage.name}  ${mediaDir()}`);
  console.log(`ffmpeg       ${bins ? bins.ffmpeg : 'not found (pnpm install builds ffmpeg-static)'}`);
  console.log(`vision       ${appleVisionAvailable() ? 'Apple Vision (OCR + face similarity)' : 'fake (not on macOS)'}`);
  console.log(`models       ${JSON.stringify(mediaModels())}`);
}

async function sample(format: PostFormat) {
  const env = penv();
  const missing = [
    ...(env.isLive('higgsfield') ? [] : ['higgsfield.api_key', 'higgsfield.api_secret']),
    ...(env.isLive('elevenlabs') || !['talking', 'voiceover'].includes(format) ? [] : ['elevenlabs.api_key']),
  ];
  if (missing.length) {
    console.log(`pending key: ${missing.join(', ')}. Add with \`pnpm ios secrets set <name>\`; nothing was spent.`);
    return;
  }
  const db = await createTestDb(); // scratch database: never the studio's .data/pglite
  const now = new Date();
  const { id: studioId } = await db.one<{ id: string }>(`INSERT INTO studio (slug, name, settings) VALUES ('sample', 'Sample Studio', $1::jsonb) RETURNING id`, [json(DEFAULT_SETTINGS)]);
  const { id: personaId } = await db.one<{ id: string }>(
    `INSERT INTO persona (studio_id, slug, name, niche, state, autonomy, timezone) VALUES ($1, 'nora-sample', 'Nora Vale', 'Personal finance', 'TESTING', 'L1', 'America/New_York') RETURNING id`,
    [studioId],
  );
  await attachSampleBible(db, personaId);
  const services = createServices({ db, providers: providers(env), mode: 'fake', now: () => now });
  const next = new Date(now.getTime() + 7 * 86_400_000);
  const { slotIds } = await planWeek(services, personaId, next);
  const slots = await db.query<{ id: string }>('SELECT id FROM calendar_slot WHERE id = ANY($1::uuid[]) AND format = $2 ORDER BY slot_at LIMIT 1', [slotIds, format]);
  if (!slots[0]) throw new Error(`no ${format} slot planned`);
  const out = await processSlot(services, slots[0].id);
  if (out.status !== 'media_queued') throw new Error(`script stage ended at ${out.status}: ${out.blockReason ?? ''}`);
  const { payload } = await db.one<{ payload: MediaRenderPayload }>(`SELECT payload FROM job WHERE kind = $1 AND payload->>'slotId' = $2`, [MEDIA_RENDER_JOB, slots[0].id]);
  const deps = mediaDeps(services);
  console.log(`rendering a ${format} sample with ${services.providers.imageVideo.name} + ${deps.toolkit.name} (${GEN_RESOLUTION} → 1080×1920)…`);
  const r = await renderSlot(services, payload, { deps });
  const media = await slotMedia(db, payload.slotId);
  const ledger = await db.query<{ unit: string; amount: string }>(`SELECT unit, sum(amount) AS amount FROM credit_ledger WHERE entry_type = 'debit' GROUP BY unit`);
  console.log(`result: ${r.status}${r.reason ? ` (${r.reason})` : ''}`);
  for (const a of media?.final ?? []) console.log(`  ${a.type.padEnd(8)} ${a.width}×${a.height}  ${mediaDir()}/${a.url.replace(/^\/api\/(public\/)?media\//, '')}`);
  for (const q of media?.reports ?? []) console.log(`  ${q.stage} ${q.pass ? 'pass' : 'FAIL'} ${q.score ?? ''}`);
  console.log(`spent: ${ledger.map((l) => `${Number(l.amount).toFixed(2)} ${l.unit}`).join(', ') || 'nothing'}`);
  await db.close();
}

async function probe() {
  const env = penv();
  const p = providers(env);
  if (!env.isLive('higgsfield')) console.log('pending key: higgsfield.api_key, higgsfield.api_secret (showing the built-in estimates)');
  const models = mediaModels();
  for (const g of PROBE_GRID)
    for (const d of g.durations) {
      const { credits } = await p.imageVideo.costProbe({ operation: g.operation, model: models[g.model] as string, durationS: d || undefined, resolution: GEN_RESOLUTION });
      console.log(`${g.operation.padEnd(20)} ${String(models[g.model]).padEnd(20)} ${d ? `${d} s` : '    '}  ${credits} credits`);
    }
}

async function main() {
  switch (cmd) {
    case 'status':
      return status();
    case 'sample': {
      const f = rest[0] as PostFormat;
      if (!FORMATS.includes(f)) throw new Error(`pnpm media sample <${FORMATS.join(' | ')}>`);
      return sample(f);
    }
    case 'probe-costs':
      return probe();
    default:
      console.log('Usage: pnpm media status | sample <talking|activity_text|voiceover|static|carousel> | probe-costs');
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
