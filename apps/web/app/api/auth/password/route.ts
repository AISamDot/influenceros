import { authSecret, AuthError, hashIp, loginWithPassword, safeNext } from '@ios/auth';
import { getDb } from '@ios/db';
import { clientIp, redirectWithSession } from '@/lib/auth';
import { isFormPost } from '@/lib/http';

export const dynamic = 'force-dynamic';

/** Fallback sign-in with the CLI-set password (form post from /login). Sets the session cookie and returns to ?next. */
export async function POST(req: Request) {
  if (!isFormPost(req)) return new Response('send the sign-in form', { status: 415 });
  const f = await req.formData();
  const next = safeNext(f.get('next'));
  const back = (error: string) => new Response(null, { status: 303, headers: { Location: `/login?error=${encodeURIComponent(error)}&next=${encodeURIComponent(next)}` } });
  const secret = authSecret();
  if (!secret) return back('Sign-in is not configured: set AUTH_SECRET.');
  try {
    const s = await loginWithPassword(await getDb(), {
      password: String(f.get('password') ?? ''),
      secret,
      userAgent: req.headers.get('user-agent'),
      ipHash: hashIp(clientIp(req), secret),
    });
    return redirectWithSession(next, s.token, req);
  } catch (err) {
    if (err instanceof AuthError) return back(err.message);
    throw err;
  }
}
