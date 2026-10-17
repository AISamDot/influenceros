import { defaultBackend, integrationStates, SECRETS } from '@troupe/secrets';
import Link from 'next/link';
import { requireOwnerPage } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Integrations' };

const STATUS = {
  connected: { label: 'Connected', cls: 'bg-ok-soft text-ok' },
  pending_key: { label: 'Pending key', cls: 'bg-warn-soft text-warn' },
  fake_mode: { label: 'Fake mode', cls: 'bg-surface-3 text-muted' },
} as const;

export default async function Integrations() {
  await requireOwnerPage();
  // Presence only: values never leave the Keychain or the environment.
  const states = integrationStates(defaultBackend());
  const connected = states.filter((s) => s.status === 'connected').length;
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <Link href="/settings" className="text-[13px] text-muted hover:text-fg">
        ← Settings
      </Link>
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-[44px] leading-none tracking-tight">Integrations</h1>
        <p className="mt-2 max-w-2xl text-muted">
          {connected} of {states.length} have keys. Anything without a key (or whose real adapter hasn&apos;t shipped yet) runs on its deterministic fake, so the
          whole studio works end to end before any account exists.
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {states.map((s) => (
          <article key={s.def.id} className="card p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-[16px] font-semibold">{s.def.name}</h2>
                <p className="text-[12.5px] text-muted">{s.def.purpose}</p>
              </div>
              <span className={`pill shrink-0 ${STATUS[s.status].cls}`}>{STATUS[s.status].label}</span>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px]">
              <span className={`pill ${s.mode === 'live' ? 'bg-ok-soft text-ok' : 'bg-surface-2 text-muted'}`}>Runs on: {s.mode}</span>
              {!s.def.liveAdapter ? <span className="text-muted">Real adapter lands in {s.def.milestone}</span> : null}
            </div>
            <ul className="mt-3 space-y-1 border-t border-line pt-3">
              {s.secrets.map((sec) => (
                <li key={sec.name} className="flex flex-wrap items-center justify-between gap-2 text-[12.5px]">
                  <code className="rounded bg-surface-2 px-1.5 py-0.5 text-[11.5px]">{sec.name}</code>
                  <span className="text-muted">
                    {sec.source ? `set (${sec.source})` : 'not set'} · env {SECRETS[sec.name].env}
                  </span>
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>

      <section className="card p-5 text-[13.5px]">
        <h2 className="font-[family-name:var(--font-display)] text-[24px] leading-none">Adding keys</h2>
        <p className="mt-2 text-muted">Keys live in the macOS Keychain (service ai.troupe-house) on the Mac and in environment variables on Vercel. Claude never types or sees them.</p>
        <pre className="mt-3 overflow-x-auto rounded-xl bg-surface-2 p-3 text-[12.5px] leading-relaxed">
          {`pnpm troupe secrets status
pnpm troupe secrets set anthropic.api_key        # hidden input
pnpm troupe secrets import-brandos               # copies Apify, ElevenLabs, Pixabay (asks y/n each)
pnpm troupe secrets migrate-service              # one time: copies keys saved under ai.influencer-os`}
        </pre>
      </section>
    </div>
  );
}
