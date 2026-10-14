import { getDb } from '@ios/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const db = await getDb();
    await db.query('SELECT 1');
    return Response.json({ ok: true, db: db.dialect });
  } catch (err) {
    return Response.json({ ok: false, error: (err as Error).message }, { status: 503 });
  }
}
