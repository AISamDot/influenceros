import { safeNext } from '@troupe/auth';
import { AuthNotice } from '@/components/auth-notice';
import { SubmitButton } from '@/components/submit-button';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Sign in', referrer: 'no-referrer' };

/**
 * Where the emailed link lands. Signing in takes one click here (a POST), so a mail scanner that opens the link
 * can't use up the one-time token.
 */
export default async function Verify({ searchParams }: { searchParams: Promise<{ token?: string; next?: string }> }) {
  const { token, next } = await searchParams;
  return (
    <div className="mx-auto mt-[12vh] w-full max-w-sm space-y-4">
      <h1 className="text-[20px] font-semibold tracking-tight">Sign in to Troupe House</h1>
      {token ? (
        <form action="/api/auth/verify" method="post" className="card space-y-3 p-5">
          <input type="hidden" name="token" value={token} />
          {next ? <input type="hidden" name="next" value={safeNext(next)} /> : null}
          <p className="text-[13.5px] text-muted">This link works once.</p>
          <SubmitButton className="btn btn-ink w-full justify-center">Sign in</SubmitButton>
        </form>
      ) : (
        <AuthNotice tone="error">This link is missing its token. Request a new one from the sign-in page.</AuthNotice>
      )}
    </div>
  );
}
