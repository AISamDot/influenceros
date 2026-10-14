'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { IconFlag, IconSend } from './icons';

export interface ChatMsg {
  id: string;
  role: 'owner' | 'agent' | 'system';
  body: string;
  created_at: string;
  author?: string;
  meta?: Record<string, unknown>;
}

interface FeedbackMeta {
  id: string;
  status: 'proposed' | 'applied' | 'rejected';
  class?: string;
}

/**
 * Owner ↔ agent chat. The reply streams in as plain-text chunks while the agent writes it (Claude with an
 * Anthropic key, the fake LLM without); afterwards the thread reloads from the server, so approval cards, feedback
 * proposals and @mentioned managers' replies show as their own messages.
 */
export function ChatPanel({
  threadId,
  title,
  subtitle,
  initial,
  mode = 'fake',
  placeholder = 'Message…',
  className = '',
  accent,
  avatar,
}: {
  threadId: string;
  title: string;
  subtitle?: string;
  initial: ChatMsg[];
  mode?: 'live' | 'fake';
  placeholder?: string;
  className?: string;
  accent?: string;
  avatar?: string | null;
}) {
  const [msgs, setMsgs] = useState<ChatMsg[]>(initial);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [agentMode, setAgentMode] = useState(mode);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [msgs]);

  async function reload() {
    const res = await fetch(`/api/chat/${threadId}/messages`, { cache: 'no-store' });
    if (!res.ok) return;
    const j = (await res.json()) as { messages: Array<ChatMsg & { created_at: string }> };
    setMsgs(j.messages.map((m) => ({ ...m, created_at: new Date(m.created_at).toISOString() })));
  }

  async function send() {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    setText('');
    const now = new Date().toISOString();
    const replyId = `pending-${Date.now()}`;
    setMsgs((m) => [...m, { id: `owner-${Date.now()}`, role: 'owner', body, created_at: now }, { id: replyId, role: 'agent', body: '', created_at: now }]);
    try {
      const res = await fetch(`/api/chat/${threadId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body }),
      });
      if (res.status === 401) {
        window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
        return;
      }
      if (!res.ok || !res.body) throw new Error((await res.text()) || `HTTP ${res.status}`);
      const m = res.headers.get('x-agent-mode');
      if (m === 'live' || m === 'fake') setAgentMode(m);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = dec.decode(value, { stream: true });
        setMsgs((list) => list.map((x) => (x.id === replyId ? { ...x, body: x.body + chunk } : x)));
      }
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send');
      setMsgs((m) => m.filter((x) => x.id !== replyId));
    } finally {
      setBusy(false);
    }
  }

  async function decideFeedback(feedbackId: string, decision: 'apply' | 'reject') {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/chat/${threadId}/feedback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ feedbackId, decision }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }

  // A proposal is still open only if nothing later settled it.
  const settled = new Set(
    msgs
      .map((m) => (m.meta?.feedback as FeedbackMeta | undefined))
      .filter((f): f is FeedbackMeta => Boolean(f && f.status !== 'proposed'))
      .map((f) => f.id),
  );

  return (
    <section className={`card flex min-h-0 flex-col overflow-hidden ${className}`} aria-label={title}>
      <div className="flex items-center gap-3 border-b border-line px-4 py-3">
        {avatar ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={avatar} alt="" className="size-9 rounded-full object-cover" />
        ) : (
          <span className={`grid size-9 place-items-center rounded-full text-[13px] font-bold ${accent ? 'text-white' : 'bg-ink text-on-ink'}`} style={accent ? { background: accent } : undefined}>
            {title.slice(0, 1)}
          </span>
        )}
        <div className="min-w-0">
          <div className="truncate text-[14px] font-semibold">{title}</div>
          {subtitle ? <div className="truncate text-[12px] text-muted">{subtitle}</div> : null}
        </div>
        <span
          className="ml-auto hidden shrink-0 items-center gap-1.5 whitespace-nowrap text-[11px] font-medium text-muted sm:flex"
          title={agentMode === 'live' ? 'Agents run on Claude' : 'No Anthropic key: agents run on the fake LLM'}
        >
          <span className={`size-1.5 rounded-full ${agentMode === 'live' ? 'bg-ok' : 'bg-warn'}`} />
          {agentMode === 'live' ? 'Claude' : 'fake LLM (no key)'}
        </span>
      </div>
      <div ref={scroller} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {msgs.length === 0 ? <p className="py-8 text-center text-[13px] text-muted">No messages yet. Say hello.</p> : null}
        {msgs.map((m) => {
          if (m.role === 'owner') {
            return (
              <div key={m.id} className="flex justify-end">
                <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-ink px-3.5 py-2 text-[13.5px] text-on-ink">{m.body}</div>
              </div>
            );
          }
          const kind = m.meta?.kind;
          if (kind === 'approval_card') return <ChatApprovalCard key={m.id} body={m.body} />;
          const feedback = m.meta?.feedback as FeedbackMeta | undefined;
          const open = feedback?.status === 'proposed' && !settled.has(feedback.id);
          const via = typeof m.meta?.personaName === 'string' && m.author === 'agent:persona-manager' ? `${m.meta.personaName}'s manager` : null;
          return (
            <div key={m.id} className="flex">
              <div
                className={`max-w-[92%] whitespace-pre-wrap rounded-2xl rounded-bl-md border px-3.5 py-2 text-[13.5px] leading-relaxed ${
                  kind === 'notice' ? 'border-line bg-surface text-muted' : 'border-line bg-surface-2'
                }`}
              >
                {via ? <div className="mb-1 text-[11.5px] font-semibold text-muted">{via}</div> : null}
                {m.body || (
                  <span className="inline-flex gap-1 py-1">
                    <Dot />
                    <Dot d={150} />
                    <Dot d={300} />
                  </span>
                )}
                {open && feedback ? (
                  <div className="mt-2 flex gap-2">
                    <button type="button" disabled={busy} onClick={() => void decideFeedback(feedback.id, 'apply')} className="btn btn-ink btn-sm">
                      Apply
                    </button>
                    <button type="button" disabled={busy} onClick={() => void decideFeedback(feedback.id, 'reject')} className="btn btn-sm">
                      Not now
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      {error ? <p className="px-4 pb-1 text-[12px] text-danger">{error}</p> : null}
      <form
        className="flex items-end gap-2 border-t border-line p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={1}
          placeholder={placeholder}
          aria-label={`Message ${title}`}
          className="max-h-32 min-h-[38px] flex-1 resize-none rounded-xl border border-line-strong bg-surface px-3 py-2 text-[16px] outline-none sm:text-[13.5px] focus:border-accent"
        />
        <button type="submit" disabled={busy || !text.trim()} className="btn btn-ink size-[38px] shrink-0 p-0 disabled:opacity-40" aria-label="Send">
          <IconSend size={16} />
        </button>
      </form>
    </section>
  );
}

/** An approval card inline in the chat (kill proposals and other Owner-only items are decided in Approvals). */
function ChatApprovalCard({ body }: { body: string }) {
  return (
    <div className="flex">
      <div className="max-w-[92%] overflow-hidden rounded-2xl border border-danger/40 bg-danger-soft text-[13.5px]">
        <div className="flex items-center gap-1.5 px-3.5 pt-2 text-[11.5px] font-semibold uppercase tracking-wide text-danger">
          <IconFlag size={12} /> Needs your approval
        </div>
        <p className="whitespace-pre-wrap px-3.5 py-1.5 leading-relaxed">{body}</p>
        <div className="border-t border-danger/30 px-3.5 py-2">
          <Link href="/approvals" className="text-[12.5px] font-semibold text-danger underline-offset-2 hover:underline">
            Review in Approvals →
          </Link>
        </div>
      </div>
    </div>
  );
}

function Dot({ d = 0 }: { d?: number }) {
  return <span className="size-1.5 animate-bounce rounded-full bg-faint" style={{ animationDelay: `${d}ms` }} />;
}
