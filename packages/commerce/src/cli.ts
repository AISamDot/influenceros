// `pnpm commerce <command>`: stream G's CLI (docs/IOS-34-CONTRACTS.md).
// With local PGlite only one process may open the data dir: never open it while the dev server is running
// (use a scratch PGLITE_DIR for manual runs).
import { personaSiteUrl, SITE_PATHS } from '@ios/agents';
import { defaultBackend, integrationStates } from '@ios/secrets';

const [cmd, ...args] = process.argv.slice(2);

function status(): void {
  const states = integrationStates(defaultBackend(process.env)).filter((s) => ['lemonsqueezy', 'resend'].includes(s.def.id));
  for (const s of states) {
    const missing = s.secrets.filter((x) => !x.source).map((x) => x.name);
    console.log(`${s.def.name.padEnd(14)} ${s.mode === 'live' ? 'live' : 'fake'}  (${s.status.replace('_', ' ')}${missing.length ? `; pending key: ${missing.join(', ')}` : ''})`);
  }
  console.log(`Studio domain   ${process.env.IOS_STUDIO_DOMAIN?.trim() || '(not set: sites are served at /p/<slug>)'}`);
  console.log(`Resend webhooks ${process.env.RESEND_WEBHOOK_SECRET ? 'signed' : 'off until resend.webhook_secret is set (unsubscribes still work through the studio links)'}`);
}

function urls(slug: string | undefined): void {
  if (!slug || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) {
    console.error('Usage: pnpm commerce urls <persona-slug>');
    process.exit(1);
  }
  for (const [label, path] of [
    ['Link in bio', SITE_PATHS.home],
    ['Lead magnet', SITE_PATHS.freebie],
    ['Members', '/members'],
    ['Privacy', '/privacy'],
  ] as const) {
    console.log(`${label.padEnd(12)} ${personaSiteUrl(slug, path)}`);
  }
  console.log(`Webhooks     /api/webhooks/lemonsqueezy (X-Signature) · /api/webhooks/resend (Svix)`);
}

switch (cmd) {
  case 'status':
    status();
    break;
  case 'urls':
    urls(args[0]);
    break;
  default:
    console.log(`Usage: pnpm commerce <command>

  status          Lemon Squeezy / Resend: live or fake, and which keys are pending
  urls <slug>     A persona's public site URLs (link in bio, lead magnet, members, privacy)

Store sync, product sweeps, attribution links, welcome emails and monthly drops run on the scheduler.`);
}
