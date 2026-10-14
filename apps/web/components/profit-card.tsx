import type { Db } from '@ios/db';

/**
 * Profit card on the Studio wall (PRD §3.11 outputs): this month's profit vs forecast, top three levers pulled, top
 * three opportunities. IOS-2 stream D owns this file and fills it from @ios/profit; until then it renders nothing.
 */
export async function ProfitCard(_props: { db: Db; studioId: string }) {
  return null;
}
