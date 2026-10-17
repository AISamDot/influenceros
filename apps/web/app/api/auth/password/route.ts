import { authSecret, AuthError, hashIp, loginWithPassword, safeNext } from '@troupe/auth';
import { getDb } from '@troupe/db';
import { clientIp, redirectWithSession } from '@/lib/auth';
import { isFormPost } from '@/lib/http';

export const dynamic = 'force-dynamic';

/** Fallback sign-in with the CLI-set password (form post from /login). Sets the session cookie and returns to ?next. */
export async function POST(req: Request) {
  if (!isFormPost(req)) return new Response('send the sign-in form', { status: 415 });
  const f = await req.formData();
  const next = safeNext(f.get('next'));
  const back = (code: string) => new Response(null, { status: 303, headers: { Location: `/login?error=${code}&next=${encodeURIComponent(next)}` } });
  const secret = authSecret();
  if (!secret) return back('config');
  try {
    const s = await loginWithPassword(await getDb(), {
      password: String(f.get('password') ?? ''),
      secret,
      userAgent: req.headers.get('user-agent'),
      ipHash: hashIp(clientIp(req), secret),
    });
    return redirectWithSession(next, s.token, req);
  } catch (err) {
    if (err instanceof AuthError) return back(err.status === 429 ? 'throttled' : 'bad_password');
    throw err;
  }
}
