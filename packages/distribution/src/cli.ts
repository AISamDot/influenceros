// `pnpm distribution <command>`: stream F (publishing, community, analytics, accounts).
// With local PGlite only one process may open the data dir: never open it while the dev server is running (use a
// scratch PGLITE_DIR or DATABASE_URL).
import { createServices, type ProviderEnv, type StudioServices } from '@ios/agents';
import { getStudio, OWNER } from '@ios/core';
import { type Db, openDb } from '@ios/db';
import { createFakeProviders } from '@ios/providers';
import { defaultBackend, integrationStates, isSecretName, readSecret } from '@ios/secrets';
import { accountSetupSheet, syncAccounts } from './accounts';
import { personaScorecard, pullMetrics } from './analytics';
import { approvedCrisisText, handleCommunity, pollCommunity, proposeCrisisText } from './community';
import { liveProviders } from './index';
import { enqueueDuePosts } from './publishing';
import { runZernioCheck } from './zernio-check';

const HELP = `pnpm distribution <command>

  status                    Zernio mode (live / fake / pending key), webhook secret, crisis text approval
  sheet <persona-slug>      the account-setup sheet (handles, bio, profile image, link, AI-label steps)
  accounts                  every account: handle, status, AI label, vendor link
  sync                      link accounts connected in Zernio (reads the vendor's account list)
  scorecard <slug> [days]   per-persona scorecard from post metrics
  pull                      capture due 1h/24h/72h/7d metric windows now
  poll <slug>               poll comments and DMs for a persona, then handle them by policy
  due                       queue publish.post for approved posts whose time has come
  crisis-text [--propose]   show the crisis helpline approval, or propose the default text to the Owner
  zernio-check              live read-only Zernio check (GET accounts, profiles, usage): counts and platforms only`;

function cliEnv(): ProviderEnv {
  const backend = defaultBackend(process.env);
  const live = new Set(integrationStates(backend, process.env).filter((s) => s.mode === 'live').map((s) => s.def.id));
  return { isLive: (id) => live.has(id), secret: (name) => (isSecretName(name) ? (readSecret(name, backend, process.env)?.reveal() ?? null) : null) };
}

function services(db: Db): StudioServices {
  return createServices({ db, providers: { ...createFakeProviders(), ...liveProviders(cliEnv()) }, mode: 'auto' });
}

async function personaBySlug(db: Db, slug: string | undefined): Promise<{ id: string; name: string }> {
  if (!slug) throw new Error('give a persona slug');
  const p = await db.maybeOne<{ id: string; name: string }>('SELECT id, name FROM persona WHERE slug = $1', [slug]);
  if (!p) throw new Error(`no persona "${slug}"`);
  return p;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(HELP);
    return cmd ? 0 : 1;
  }
  // Read-only and vendor-only: it never opens the database.
  if (cmd === 'zernio-check') return runZernioCheck();
  if (cmd === 'status') {
    const z = integrationStates(defaultBackend(process.env), process.env).find((s) => s.def.id === 'zernio');
    console.log(`Zernio: ${z?.mode ?? 'fake'} (${z?.status ?? 'pending_key'}); webhook secret ${cliEnv().secret('zernio.webhook_secret') ? 'set (webhooks on)' : 'not set (polling)'}`);
  }
  const db = await openDb();
  try {
    const studio = await getStudio(db);
    const s = services(db);
    switch (cmd) {
      case 'status':
        console.log(`Crisis helpline text: ${(await approvedCrisisText(s, studio.id)) ? 'approved' : 'not approved yet (crisis threads pause and alert you)'}`);
        return 0;
      case 'sheet': {
        const p = await personaBySlug(db, args[0]);
        const sheet = await accountSetupSheet(db, p.id);
        console.log(`Account setup: ${sheet.name} (${sheet.niche})\n`);
        for (const r of sheet.rows) {
          console.log(`${r.platform.toUpperCase()}  @${r.handle}${r.suggested ? ' (suggested)' : ''}  · ${r.status}${r.aiLabelOk ? ' · AI label on' : ' · AI label pending'}${r.linked ? ' · linked in Zernio' : ''}`);
          if (r.availableFrom) console.log(`  from ${r.availableFrom.toISOString().slice(0, 10)}`);
          console.log(`  bio:   ${r.bio}\n  link:  ${r.link}\n  image: ${r.profileImageUrl ?? '(portrait pending)'}`);
          for (const step of r.aiLabelSteps) console.log(`  - ${step}`);
          console.log('');
        }
        return 0;
      }
      case 'accounts': {
        const rows = await db.query<{ name: string; platform: string; handle: string; status: string; ai_label_ok: boolean; token_ref: string | null }>(
          `SELECT p.name, a.platform, a.handle, a.status, a.ai_label_ok, a.token_ref FROM account a JOIN persona p ON p.id = a.persona_id WHERE p.studio_id = $1 ORDER BY p.name, a.platform`,
          [studio.id],
        );
        for (const r of rows) {
          console.log(`${r.name.padEnd(22)} ${r.platform.padEnd(10)} @${r.handle.padEnd(24)} ${r.status.padEnd(8)} ${r.ai_label_ok ? 'label on ' : 'label off'} ${r.token_ref && !r.token_ref.startsWith('vault:') ? 'linked' : ''}`);
        }
        return 0;
      }
      case 'sync':
        console.log(JSON.stringify(await syncAccounts(s), null, 2));
        return 0;
      case 'scorecard': {
        const p = await personaBySlug(db, args[0]);
        console.log(JSON.stringify(await personaScorecard(s, p.id, Number(args[1] ?? 7) || 7), null, 2));
        return 0;
      }
      case 'pull':
        console.log(JSON.stringify(await pullMetrics(s), null, 2));
        return 0;
      case 'poll': {
        const p = await personaBySlug(db, args[0]);
        console.log(JSON.stringify({ polled: await pollCommunity(s, p.id), handled: await handleCommunity(s, p.id) }, null, 2));
        return 0;
      }
      case 'due':
        console.log(JSON.stringify({ queued: await enqueueDuePosts(s) }, null, 2));
        return 0;
      case 'crisis-text': {
        const text = await approvedCrisisText(s, studio.id);
        if (text) console.log(`Approved:\n${text}`);
        else if (args.includes('--propose')) console.log((await proposeCrisisText(s, studio.id, OWNER)) ? 'Proposed: approve it on the Approvals page.' : 'Already waiting on the Approvals page.');
        else console.log('No crisis text approved. Run with --propose to send the default to Approvals.');
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

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
