import { downloadByToken } from '@ios/commerce';
import { fileResponse } from '@/components/site-http';
import { getServices } from '@/lib/services';

export const dynamic = 'force-dynamic';

/** Lead-magnet download from the welcome email (token valid 30 days). */
export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get('t') ?? '';
  const file = await downloadByToken(await getServices(), token);
  if (!file) return new Response('This download link has expired. Sign up again for a fresh one.', { status: 404 });
  return fileResponse(file);
}
