import { authSecret, LOGIN_ERRORS, loginErrorMessage, safeNext } from '@troupe/auth';
import { redirect } from 'next/navigation';
import { AuthNotice } from '@/components/auth-notice';
import { SubmitButton } from '@/components/submit-button';
import { currentSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Sign in' };

/**
 * Owner sign-in: a one-time link to the Owner's email (Resend), or the fallback password set with
 * `pnpm owner set-password`. Only the Owner has an account.
 */
export default async function Login({ searchParams }: { searchParams: Promise<{ next?: string; error?: string; sent?: string; ok?: string }> }) {
  const sp = await searchParams;
  const next = safeNext(sp.next);
  if (await currentSession().catch(() => null)) redirect(next);
  const configured = Boolean(authSecret());
  const emailReady = Boolean(process.env.OWNER_EMAIL);
  return (
    <div className="mx-auto mt-[8vh] w-full max-w-sm space-y-5">
      <div className="flex items-center gap-2.5">
        <span className="grid size-10 place-items-center rounded-xl bg-ink font-[family-name:var(--font-display)] text-[21px] leading-none text-on-ink">io</span>
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight">Troupe House</h1>
          <p className="text-[12.5px] text-muted">Owner sign-in</p>
        </div>
      </div>

      {!configured ? (
        <AuthNotice tone="error">{LOGIN_ERRORS.config}</AuthNotice>
      ) : loginErrorMessage(sp.error) ? (
        <AuthNotice tone="error">{loginErrorMessage(sp.error)}</AuthNotice>
      ) : null}
      {sp.sent ? <AuthNotice tone="ok">If that is the Owner&apos;s address, a sign-in link is on its way. It works once, for 15 minutes.</AuthNotice> : null}
      {sp.ok === 'signed-out' ? <AuthNotice tone="ok">Signed out.</AuthNotice> : null}

      <form action="/api/auth/magic-link" method="post" className="card space-y-3 p-5">
        <input type="hidden" name="next" value={next} />
        <label className="block text-[13px] font-medium">
          Email me a sign-in link
          <input name="email" type="email" required autoComplete="email" className="input mt-1.5" placeholder="you@example.com" />
        </label>
        <SubmitButton className="btn btn-ink w-full justify-center">Send link</SubmitButton>
        {!emailReady ? <p className="text-[12px] text-muted">Email sign-in needs OWNER_EMAIL and a Resend key; until then use the password.</p> : null}
      </form>

      <form action="/api/auth/password" method="post" className="card space-y-3 p-5">
        <input type="hidden" name="next" value={next} />
        <label className="block text-[13px] font-medium">
          Or use the Owner password
          <input name="password" type="password" required autoComplete="current-password" className="input mt-1.5" />
        </label>
        <SubmitButton className="btn w-full justify-center">Sign in</SubmitButton>
        <p className="text-[12px] text-muted">
          Set it on the Mac with <code className="rounded bg-surface-2 px-1">pnpm owner set-password</code>.
        </p>
      </form>
    </div>
  );
}
