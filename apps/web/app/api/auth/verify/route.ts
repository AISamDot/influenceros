import { authSecret, AuthError, hashIp, loginWithMagicToken, safeNext } from '@ios/auth';
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
  const next = safeNext(f.get('next'));
  const fail = (code: string) => new Response(null, { status: 303, headers: { Location: `/login?error=${code}${next === '/' ? '' : `&next=${encodeURIComponent(next)}`}` } });
  if (!secret) return fail('config');
  try {
    const s = await loginWithMagicToken(await getDb(), {
      token: String(f.get('token') ?? ''),
      secret,
      userAgent: req.headers.get('user-agent'),
      ipHash: hashIp(clientIp(req), secret),
    });
    return redirectWithSession(next, s.token, req);
  } catch (err) {
    if (err instanceof AuthError) return fail(err.status === 429 ? 'throttled' : 'link_invalid');
    throw err;
  }
}
