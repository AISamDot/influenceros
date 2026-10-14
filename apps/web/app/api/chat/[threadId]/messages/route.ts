import { getThread, listMessages, postOwnerMessage, replyAsAgent } from '@ios/core';
import { getDb } from '@ios/db';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ threadId: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { threadId } = await params;
  const db = await getDb();
  if (!(await getThread(db, threadId))) return Response.json({ error: 'thread not found' }, { status: 404 });
  return Response.json({ messages: await listMessages(db, threadId) });
}

/**
 * Stores the Owner's message, generates the agent reply (fake agent in IOS-1), persists it, then streams it
 * back as plain-text chunks. The streaming contract stays the same when the Claude Agent SDK takes over.
 */
export async function POST(req: Request, { params }: Ctx) {
  const { threadId } = await params;
  const db = await getDb();
  if (!(await getThread(db, threadId))) return new Response('thread not found', { status: 404 });
  let body: string;
  try {
    body = String(((await req.json()) as { body?: unknown }).body ?? '');
  } catch {
    return new Response('expected JSON {"body": "…"}', { status: 400 });
  }
  try {
    await postOwnerMessage(db, threadId, body);
  } catch (err) {
    return new Response((err as Error).message, { status: 400 });
  }
  const reply = await replyAsAgent(db, threadId, body);
  const words = reply.body.split(/(?<=\s)/);
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (let i = 0; i < words.length; i += 3) {
        controller.enqueue(enc.encode(words.slice(i, i + 3).join('')));
        await new Promise((r) => setTimeout(r, 18));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-message-id': reply.id },
  });
}
