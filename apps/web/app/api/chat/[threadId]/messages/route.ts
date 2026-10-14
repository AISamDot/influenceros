import { acceptOwnerMessage, newMessageId, respondToOwner } from '@ios/agents';
import { getThread, listMessages, NotFoundError } from '@ios/core';
// Relative imports so the route can be exercised directly in tests (apps/web/test/routes.test.ts).
import { requireOwner } from '../../../../../lib/auth';
import { UUID_RE } from '../../../../../lib/http';
import { getServices } from '../../../../../lib/services';

export const dynamic = 'force-dynamic';
// Agent turns with tools can take a while.
export const maxDuration = 300;

type Ctx = { params: Promise<{ threadId: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const denied = await requireOwner(req);
  if (denied) return denied;
  const { threadId } = await params;
  if (!UUID_RE.test(threadId)) return Response.json({ error: 'thread not found' }, { status: 404 });
  const { db } = await getServices();
  if (!(await getThread(db, threadId))) return Response.json({ error: 'thread not found' }, { status: 404 });
  return Response.json({ messages: await listMessages(db, threadId, 60) });
}

/**
 * Stores the Owner's message, then streams the agent's reply as text/plain chunks while it is written (the Claude
 * runtime with an Anthropic key, the fake LLM without). `x-message-id` names the reply message, which is saved in
 * chat_message when the turn ends, even if the browser disconnects. @mentioned persona managers answer in the same
 * stream and are saved as their own messages.
 */
export async function POST(req: Request, { params }: Ctx) {
  const denied = await requireOwner(req);
  if (denied) return denied;
  const { threadId } = await params;
  if (!UUID_RE.test(threadId)) return new Response('thread not found', { status: 404 });
  // JSON only: a cross-site text/plain "simple request" must not be able to post as the Owner.
  if (!(req.headers.get('content-type') ?? '').includes('application/json')) return new Response('expected application/json', { status: 415 });
  let body: string;
  try {
    body = String(((await req.json()) as { body?: unknown }).body ?? '');
  } catch {
    return new Response('expected JSON {"body": "…"}', { status: 400 });
  }
  const services = await getServices();
  let accepted: Awaited<ReturnType<typeof acceptOwnerMessage>>;
  try {
    accepted = await acceptOwnerMessage(services, threadId, body);
  } catch (err) {
    return new Response((err as Error).message, { status: err instanceof NotFoundError ? 404 : 400 });
  }
  const replyId = newMessageId();
  const enc = new TextEncoder();
  let open = true;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const push = (text: string) => {
        if (!open) return;
        try {
          controller.enqueue(enc.encode(text));
        } catch {
          open = false; // the browser went away; the turn still finishes and is saved
        }
      };
      void respondToOwner(services, { ...accepted, replyId, onText: push })
        .catch((err) => {
          console.error('[chat] reply failed:', err);
          push('\n\n(Something went wrong. Nothing was changed; try again.)');
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
  return new Response(stream, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-message-id': replyId,
      'x-agent-mode': services.runtime.mode,
    },
  });
}
