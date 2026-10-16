'use client';

import { useEffect, useState } from 'react';

/**
 * Root error boundary. Details (the error text, setup commands) only show to the Owner on the studio itself (a
 * loopback host, not a persona site path); persona-site visitors and anyone on a public host get neutral copy.
 */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const [studio, setStudio] = useState(false);
  useEffect(() => {
    const { hostname, pathname } = window.location;
    setStudio(/^(localhost|127\.0\.0\.1|\[::1\])$/.test(hostname) && !pathname.startsWith('/p/') && !pathname.startsWith('/l/'));
  }, []);
  const noDb = studio && /no studio|does not exist|ENOENT|ECONNREFUSED/i.test(error.message);
  return (
    <div className="card mx-auto mt-16 max-w-lg p-8 text-center">
      <h1 className="font-[family-name:var(--font-display)] text-4xl">{noDb ? 'Database not ready' : 'Something broke'}</h1>
      <p className="mt-2 text-muted">{noDb ? 'Run the setup once, then reload.' : studio ? error.message : 'Please try again in a moment.'}</p>
      {noDb ? <pre className="mt-4 rounded-xl bg-surface-2 p-3 text-left text-[13px]">pnpm db:setup</pre> : null}
      <button onClick={reset} className="btn btn-ink mt-5">
        Try again
      </button>
    </div>
  );
}
