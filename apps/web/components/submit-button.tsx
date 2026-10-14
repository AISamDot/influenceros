'use client';

import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';

/**
 * A submit button that disables itself once its form submits, so a double click can't post twice.
 * Works for native form posts (to an API route) and for server-action forms.
 */
export function SubmitButton({ className, children, title }: { className?: string; children: ReactNode; title?: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [submitted, setSubmitted] = useState(false);
  const { pending } = useFormStatus();
  useEffect(() => {
    const form = ref.current?.form;
    if (!form) return;
    // Server-action forms report through useFormStatus; native posts navigate away, so latch until then.
    const native = !(form.getAttribute('action') ?? '').startsWith('javascript:');
    const onSubmit = () => {
      if (native) setSubmitted(true);
    };
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) setSubmitted(false); // back/forward cache restore
    };
    form.addEventListener('submit', onSubmit);
    window.addEventListener('pageshow', onShow);
    return () => {
      form.removeEventListener('submit', onSubmit);
      window.removeEventListener('pageshow', onShow);
    };
  }, []);
  const busy = pending || submitted;
  return (
    <button ref={ref} className={className} disabled={busy} aria-busy={busy} title={title}>
      {children}
    </button>
  );
}
