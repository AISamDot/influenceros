import Link from 'next/link';
import { Empty, StubHeader } from '@/components/stub';
import { requireOwnerPage } from '@/lib/auth';
import { studioContext } from '@/lib/server';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Accounts' };

/**
 * Settings → Accounts (IOS-4 stream F owns this route, docs/IOS-34-CONTRACTS.md §4): per persona, the handles, the
 * platform AI-profile-label status and the account-setup sheet the Owner uses to create the accounts.
 * Contract stub: lists the account rows that exist today.
 */
export default async function Accounts() {
  await requireOwnerPage();
  const { db, studio } = await studioContext();
  const rows = await db.query<{ name: string; slug: string; platform: string; handle: string; status: string; ai_label_ok: boolean }>(
    `SELECT p.name, p.slug, a.platform, a.handle, a.status, a.ai_label_ok
       FROM account a JOIN persona p ON p.id = a.persona_id
      WHERE p.studio_id = $1 ORDER BY p.name, a.platform`,
    [studio.id],
  );
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <Link href="/settings" className="text-[13px] text-muted hover:text-fg">
        ← Settings
      </Link>
      <StubHeader title="Accounts" milestone="IOS-4" lead="Handles per persona, the platform AI profile label on each account, and the setup sheet for creating them." />
      {rows.length ? (
        <div className="card overflow-hidden">
          <table className="w-full text-[13px]">
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.slug}-${r.platform}-${r.handle}`} className="border-t border-line first:border-t-0">
                  <td className="px-4 py-2 font-medium">{r.name}</td>
                  <td className="px-2 py-2 text-muted">{r.platform}</td>
                  <td className="px-2 py-2">@{r.handle}</td>
                  <td className="px-2 py-2 text-muted">{r.status}</td>
                  <td className="px-4 py-2 text-right text-muted">{r.ai_label_ok ? 'AI label on' : 'AI label pending'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>No accounts yet.</Empty>
      )}
    </div>
  );
}
