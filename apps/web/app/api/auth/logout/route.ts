import { authSecret, readCookie, revokeSession, verifySession } from '@ios/auth';
import { getDb } from '@ios/db';
import { redirectWithSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/** Signs out: revokes the session row and clears the cookie. */
export async function POST(req: Request) {
  const claims = verifySession(readCookie(req.headers.get('cookie')), authSecret());
  if (claims) await revokeSession(await getDb(), claims.sid);
  return redirectWithSession('/login?ok=signed-out', null, req);
}
