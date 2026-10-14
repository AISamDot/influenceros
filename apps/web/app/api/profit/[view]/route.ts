import { requireOwner } from '@/lib/auth';
import { forecastStudio, latestForecast, listLeverActions, type PnlGrain, periodRange, pnlWithTotals, profitCard, rankActions } from '@ios/profit';
import { UUID_RE } from '@/lib/http';
import { studioContext } from '@/lib/server';

export const dynamic = 'force-dynamic';

const GRAINS: readonly PnlGrain[] = ['persona', 'post', 'format', 'product', 'platform'];
const PERIODS = ['mtd', 'last_week', 'last_7_days', 'last_30_days', 'last_90_days'] as const;
type Period = (typeof PERIODS)[number];

/**
 * Profit Engine read API (JSON): `/api/profit/pnl?grain=&period=&persona=`, `/api/profit/actions`,
 * `/api/profit/card`, `/api/profit/forecast?persona=`, `/api/profit/levers`. Read only: levers run on their own
 * schedule, and anything that needs the Owner goes through Approvals.
 */
export async function GET(req: Request, { params }: { params: Promise<{ view: string }> }) {
  const denied = await requireOwner(req);
  if (denied) return denied;
  const { view } = await params;
  const url = new URL(req.url);
  const persona = url.searchParams.get('persona');
  if (persona && !UUID_RE.test(persona)) return Response.json({ error: 'persona must be a uuid' }, { status: 400 });
  const { db, studio } = await studioContext();
  const now = new Date();
  switch (view) {
    case 'pnl': {
      const grain = (url.searchParams.get('grain') ?? 'persona') as PnlGrain;
      const period = (url.searchParams.get('period') ?? 'mtd') as Period;
      if (!GRAINS.includes(grain) || !PERIODS.includes(period)) return Response.json({ error: 'bad grain or period' }, { status: 400 });
      const range = periodRange(period, now);
      return Response.json({ grain, period, ...range, ...(await pnlWithTotals(db, { studioId: studio.id, ...range, grain, personaId: persona ?? undefined })) });
    }
    case 'actions':
      return Response.json({ actions: await rankActions(db, studio.id, now, { personaId: persona }) });
    case 'card':
      return Response.json(await profitCard(db, studio.id, now));
    case 'forecast': {
      const stored = await latestForecast(db, studio.id, persona);
      if (stored) return Response.json(stored);
      const f = await forecastStudio(db, { studioId: studio.id, now, personaId: persona, runs: 500 });
      return Response.json(persona ? (f.personas[0] ?? null) : f.studio);
    }
    case 'levers':
      return Response.json({ levers: await listLeverActions(db, studio.id, { personaId: persona, limit: 100 }) });
    default:
      return Response.json({ error: 'not found' }, { status: 404 });
  }
}
