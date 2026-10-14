'use client';

import { useEffect, useRef, useState } from 'react';
import { IconSend } from './icons';

export interface ChatMsg {
  id: string;
  role: 'owner' | 'agent' | 'system';
  body: string;
  created_at: string;
}

/**
 * Owner ↔ agent chat. Messages persist server-side; the reply streams in as plain text chunks
 * (the fake agent today, the Claude Agent SDK runtime from IOS-2).
 */
export function ChatPanel({
  threadId,
  title,
  subtitle,
  initial,
  placeholder = 'Message…',
  className = '',
  accent,
  avatar,
}: {
  threadId: string;
  title: string;
  subtitle?: string;
  initial: ChatMsg[];
  placeholder?: string;
  className?: string;
  accent?: string;
  avatar?: string | null;
}) {
  const [msgs, setMsgs] = useState<ChatMsg[]>(initial);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [msgs]);

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
      if (!res.ok || !res.body) throw new Error((await res.text()) || `HTTP ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = dec.decode(value, { stream: true });
        setMsgs((m) => m.map((x) => (x.id === replyId ? { ...x, body: x.body + chunk } : x)));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send');
      setMsgs((m) => m.filter((x) => x.id !== replyId));
    } finally {
      setBusy(false);
    }
  }

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
        <span className="ml-auto hidden shrink-0 items-center gap-1.5 whitespace-nowrap text-[11px] font-medium text-muted sm:flex">
          <span className="size-1.5 rounded-full bg-ok" />
          stand-in agent
        </span>
      </div>
      <div ref={scroller} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {msgs.length === 0 ? <p className="py-8 text-center text-[13px] text-muted">No messages yet. Say hello.</p> : null}
        {msgs.map((m) =>
          m.role === 'owner' ? (
            <div key={m.id} className="flex justify-end">
              <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-ink px-3.5 py-2 text-[13.5px] text-on-ink">{m.body}</div>
            </div>
          ) : (
            <div key={m.id} className="flex">
              <div className="max-w-[92%] whitespace-pre-wrap rounded-2xl rounded-bl-md border border-line bg-surface-2 px-3.5 py-2 text-[13.5px] leading-relaxed">
                {m.body || <span className="inline-flex gap-1 py-1"><Dot /><Dot d={150} /><Dot d={300} /></span>}
              </div>
            </div>
          ),
        )}
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
          className="max-h-32 min-h-[38px] flex-1 resize-none rounded-xl border border-line-strong bg-surface px-3 py-2 text-[13.5px] outline-none focus:border-accent"
        />
        <button type="submit" disabled={busy || !text.trim()} className="btn btn-ink size-[38px] shrink-0 p-0 disabled:opacity-40" aria-label="Send">
          <IconSend size={16} />
        </button>
      </form>
    </section>
  );
}

function Dot({ d = 0 }: { d?: number }) {
  return <span className="size-1.5 animate-bounce rounded-full bg-faint" style={{ animationDelay: `${d}ms` }} />;
}
