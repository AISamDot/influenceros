import { authSecret, AuthError, hashIp, isDeployed, requestMagicLink, safeNext } from '@ios/auth';
import { getDb } from '@ios/db';
import { clientIp, publicOrigin } from '@/lib/auth';
import { isFormPost } from '@/lib/http';
import { getServices } from '@/lib/services';

export const dynamic = 'force-dynamic';

/**
 * Emails a one-time sign-in link to OWNER_EMAIL (Resend) when the address typed is the Owner's. The answer is the
 * same either way, so the page never reveals which address is the Owner's.
 */
export async function POST(req: Request) {
  if (!isFormPost(req)) return new Response('send the sign-in form', { status: 415 });
  const f = await req.formData();
  const next = safeNext(f.get('next'));
  const go = (q: string) => new Response(null, { status: 303, headers: { Location: `/login?${q}&next=${encodeURIComponent(next)}` } });
  const secret = authSecret();
  if (!secret) return go('error=config');
  const services = await getServices();
  try {
    const r = await requestMagicLink(await getDb(), services.providers.email, {
      email: String(f.get('email') ?? ''),
      ownerEmail: process.env.OWNER_EMAIL,
      from: process.env.AUTH_EMAIL_FROM || 'Influencer OS <onboarding@resend.dev>',
      baseUrl: publicOrigin(req),
      ipHash: hashIp(clientIp(req), secret),
      next,
    });
    // Local development without a Resend key: the email goes to the fake provider, so print the link here.
    if (r.link && services.providers.email.name.startsWith('fake') && !isDeployed() && process.env.NODE_ENV !== 'production') {
      console.info(`[auth] email is in fake mode; sign-in link: ${r.link}`);
    }
  } catch (err) {
    if (err instanceof AuthError) return go(`error=${err.status === 429 ? 'link_throttled' : 'link_invalid'}`);
    throw err;
  }
  return go('sent=1');
}
