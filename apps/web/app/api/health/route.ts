import { getDb } from '@ios/db';

export const dynamic = 'force-dynamic';

/** Public and minimal (uptime checks): is the database reachable? No details. */
export async function GET() {
  try {
    await (await getDb()).query('SELECT 1');
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}
