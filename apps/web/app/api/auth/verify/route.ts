import { authSecret, AuthError, hashIp, loginWithMagicToken } from '@ios/auth';
import { getDb } from '@ios/db';
import { clientIp, redirectWithSession } from '@/lib/auth';
import { isFormPost } from '@/lib/http';

export const dynamic = 'force-dynamic';

/**
 * Exchanges a magic-link token for a session. The link opens /login/verify, whose button posts here, so an email
 * scanner that prefetches the link can't use up the token.
 */
export async function POST(req: Request) {
  if (!isFormPost(req)) return new Response('send the sign-in form', { status: 415 });
  const f = await req.formData();
  const secret = authSecret();
  const fail = (error: string) => new Response(null, { status: 303, headers: { Location: `/login?error=${encodeURIComponent(error)}` } });
  if (!secret) return fail('Sign-in is not configured: set AUTH_SECRET.');
  try {
    const s = await loginWithMagicToken(await getDb(), {
      token: String(f.get('token') ?? ''),
      secret,
      userAgent: req.headers.get('user-agent'),
      ipHash: hashIp(clientIp(req), secret),
    });
    return redirectWithSession('/', s.token, req);
  } catch (err) {
    if (err instanceof AuthError) return fail(err.message);
    throw err;
  }
}
