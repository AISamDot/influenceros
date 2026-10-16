import { DraftError, generatorTurn, getDraft, listDraftMessages, MAX_CHAT_CHARS } from '@ios/generator';
// Relative imports so the route can be exercised directly in tests (apps/web/test/routes.test.ts).
import { requireOwner } from '../../../../../lib/auth';
import { UUID_RE } from '../../../../../lib/http';
import { getServices } from '../../../../../lib/services';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

type Ctx = { params: Promise<{ draftId: string }> };

/** The draft's chat (same contract as /api/chat/:id/messages, so the dashboard's ChatPanel drives it). */
export async function GET(req: Request, { params }: Ctx) {
  const denied = await requireOwner(req);
  if (denied) return denied;
  const { draftId } = await params;
  if (!UUID_RE.test(draftId)) return Response.json({ error: 'draft not found' }, { status: 404 });
  const { db } = await getServices();
  if (!(await getDraft(db, draftId))) return Response.json({ error: 'draft not found' }, { status: 404 });
  return Response.json({ messages: await listDraftMessages(db, draftId, 80) });
}

/**
 * The Owner's message to the Studio Manager about this draft, on step `?step=N`. The reply streams as text/plain; it
 * may revise the draft (only what the Owner asked for in this message: the registry gates generator.* writes).
 */
export async function POST(req: Request, { params }: Ctx) {
  const denied = await requireOwner(req);
  if (denied) return denied;
  const { draftId } = await params;
  if (!UUID_RE.test(draftId)) return new Response('draft not found', { status: 404 });
  if (!(req.headers.get('content-type') ?? '').includes('application/json')) return new Response('expected application/json', { status: 415 });
  let body: string;
  try {
    body = String(((await req.json()) as { body?: unknown }).body ?? '').trim();
  } catch {
    return new Response('expected JSON {"body": "…"}', { status: 400 });
  }
  if (!body) return new Response('say something first', { status: 400 });
  if (body.length > MAX_CHAT_CHARS) return new Response(`messages are limited to ${MAX_CHAT_CHARS} characters`, { status: 400 });
  const step = Number(new URL(req.url).searchParams.get('step') ?? '1');
  const services = await getServices();
  const draft = await getDraft(services.db, draftId);
  if (!draft) return new Response('draft not found', { status: 404 });
  const enc = new TextEncoder();
  let open = true;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const push = (text: string) => {
        if (!open) return;
        try {
          controller.enqueue(enc.encode(text));
        } catch {
          open = false;
        }
      };
      void generatorTurn(services, { draftId, step: Number.isFinite(step) ? step : draft.current_step, text: body, onText: push })
        .catch((err) => {
          if (!(err instanceof DraftError)) console.error('[generator] chat failed:', err);
          push(`\n\n(${err instanceof DraftError ? err.message : 'Something went wrong. Nothing was changed; try again.'})`);
        })
        .finally(() => {
          if (!open) return;
          open = false;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        });
    },
    cancel() {
      open = false;
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-agent-mode': services.runtime.mode } });
}
