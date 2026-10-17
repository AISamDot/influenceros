import { accountSetupSheet, type SetupSheetRow } from '@ios/distribution';
import { defaultBackend, integrationStates } from '@ios/secrets';
import Link from 'next/link';
import { AccountStatusPill } from '@/components/accounts-status';
import { Flash } from '@/components/flash';
import { SubmitButton } from '@/components/submit-button';
import { requireOwnerPage } from '@/lib/auth';
import { studioContext } from '@/lib/server';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Accounts' };

const PLATFORM_LABEL: Record<string, string> = { tiktok: 'TikTok', instagram: 'Instagram', youtube: 'YouTube Shorts' };

function Row({ r, personaId }: { r: SetupSheetRow; personaId: string }) {
  return (
    <div className="grid gap-3 py-4 lg:grid-cols-[1fr_1.3fr_1.2fr]">
      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13.5px] font-semibold">{PLATFORM_LABEL[r.platform] ?? r.platform}</span>
          <AccountStatusPill status={r.status} aiLabelOk={r.aiLabelOk} linked={r.linked} />
        </div>
        <div className="text-[13px]">
          @{r.handle} {r.suggested ? <span className="text-[11.5px] text-muted">(suggested)</span> : null}
        </div>
        {r.availableFrom ? <div className="text-[11.5px] text-muted">Create from {r.availableFrom.toISOString().slice(0, 10)} (day 30)</div> : null}
        {r.warning ? (
          <p role="alert" className="rounded-lg border border-warn/40 bg-warn-soft px-2.5 py-1.5 text-[11.5px] text-warn">
            {r.warning}
          </p>
        ) : null}
      </div>
      <div className="min-w-0 space-y-1 text-[12.5px]">
        <div>
          <span className="text-muted">Bio · </span>
          {r.bio}
        </div>
        <div className="break-all">
          <span className="text-muted">Link · </span>
          {r.link}
        </div>
        <div>
          <span className="text-muted">Profile image · </span>
          {r.profileImageUrl ? (
            <a className="underline" href={r.profileImageUrl} target="_blank" rel="noreferrer">
              portrait
            </a>
          ) : (
            'portrait pending'
          )}
        </div>
        <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-[12px] text-muted">
          {r.aiLabelSteps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      </div>
      <div className="min-w-0">
        {r.accountId ? (
          <form action="/api/distribution/accounts" method="post" className="grid grid-cols-2 gap-2">
            <input type="hidden" name="action" value="update" />
            <input type="hidden" name="accountId" value={r.accountId} />
            <label className="block">
              <span className="text-[11.5px] font-medium text-muted">Status</span>
              <select name="status" defaultValue={r.status} className="input mt-1">
                <option value="pending">pending</option>
                <option value="active">active</option>
                <option value="paused">paused</option>
                <option value="retired">retired</option>
              </select>
            </label>
            <label className="block">
              <span className="text-[11.5px] font-medium text-muted">Platform AI label</span>
              <select name="aiLabel" defaultValue={r.aiLabelOk ? 'on' : 'off'} className="input mt-1">
                <option value="on">on</option>
                <option value="off">not yet</option>
              </select>
            </label>
            {r.linked ? null : (
              <label className="col-span-2 block">
                <span className="text-[11.5px] font-medium text-muted">Zernio account id (sync fills it)</span>
                <input name="vendorRef" defaultValue="" placeholder="optional" className="input mt-1" />
              </label>
            )}
            <div className="col-span-2 flex justify-end">
              <SubmitButton className="btn btn-sm">Save</SubmitButton>
            </div>
          </form>
        ) : (
          <form action="/api/distribution/accounts" method="post" className="flex items-end gap-2">
            <input type="hidden" name="action" value="add" />
            <input type="hidden" name="personaId" value={personaId} />
            <input type="hidden" name="platform" value={r.platform} />
            <label className="block min-w-0 flex-1">
              <span className="text-[11.5px] font-medium text-muted">Handle you created</span>
              <input name="handle" defaultValue={r.handle} className="input mt-1" required />
            </label>
            <SubmitButton className="btn btn-sm btn-ink">Add</SubmitButton>
          </form>
        )}
      </div>
    </div>
  );
}

/**
 * Settings → Accounts (stream F, docs/IOS-34-CONTRACTS.md §4): per persona, the handles, the platform AI-profile-label
 * status and the account-setup sheet the Owner uses to create the accounts (creating accounts is the Owner's job).
 */
export default async function Accounts({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  await requireOwnerPage();
  const sp = await searchParams;
  const { db, studio } = await studioContext();
  const personas = await db.query<{ id: string }>(`SELECT id FROM persona WHERE studio_id = $1 AND state NOT IN ('KILLED','RETIRED','ARCHIVED') ORDER BY name`, [studio.id]);
  const sheets = await Promise.all(personas.map((p) => accountSetupSheet(db, p.id)));
  const zernio = integrationStates(defaultBackend()).find((s) => s.def.id === 'zernio');
  const unlabelled = sheets.flatMap((s) => s.rows).filter((r) => r.accountId && r.status === 'active' && !r.aiLabelOk).length;
  const loginWarnings = sheets.flatMap((s) => s.rows).filter((r) => r.warning).length;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <Link href="/settings" className="text-[13px] text-muted hover:text-fg">
        ← Settings
      </Link>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-[44px] leading-none tracking-tight">Accounts</h1>
          <p className="mt-2 max-w-2xl text-muted">
            Create each account from its setup sheet (platforms ban automated sign-ups), connect it in Zernio, then sync. Every post carries the platform AI flag; the profile label is the other half of the
            platform minimum.
          </p>
        </div>
        <form action="/api/distribution/accounts" method="post" className="flex items-center gap-2">
          <input type="hidden" name="action" value="sync" />
          <span className="text-[12px] text-muted">Zernio: {zernio?.mode === 'live' ? 'live' : zernio?.status === 'pending_key' ? 'pending key (fake mode)' : 'fake mode'}</span>
          <SubmitButton className="btn btn-sm">Sync from Zernio</SubmitButton>
        </form>
      </div>
      <Flash error={sp.error} ok={sp.ok} />
      {unlabelled ? (
        <p className="rounded-xl border border-warn/40 bg-warn-soft px-4 py-3 text-[13px] text-warn">
          {unlabelled} active account{unlabelled === 1 ? '' : 's'} without the platform AI label: their posts wait for your approval (Gate amber) until it&apos;s on.
        </p>
      ) : null}
      {loginWarnings ? (
        <p className="rounded-xl border border-warn/40 bg-warn-soft px-4 py-3 text-[13px] text-warn">
          {loginWarnings} Instagram account{loginWarnings === 1 ? ' is' : 's are'} connected in Zernio without Facebook Login. Reconnect {loginWarnings === 1 ? 'it' : 'them'} choosing the Facebook
          option so Reels can use Instagram&apos;s audio catalog.
        </p>
      ) : null}
      {sheets.map((s) => (
        <section key={s.personaId} className="card p-5 sm:p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-[family-name:var(--font-display)] text-[26px] leading-none">{s.name}</h2>
            <span className="text-[12px] text-muted">{s.niche}</span>
          </div>
          <div className="mt-2 divide-y divide-line">
            {s.rows.map((r) => (
              <Row key={r.platform} r={r} personaId={s.personaId} />
            ))}
          </div>
        </section>
      ))}
      {!sheets.length ? <p className="rounded-xl border border-dashed border-line-strong p-4 text-center text-[12.5px] text-muted">No personas yet.</p> : null}
    </div>
  );
}
