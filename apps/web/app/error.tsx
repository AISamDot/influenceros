'use client';

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const noDb = /no studio|does not exist|ENOENT|ECONNREFUSED/i.test(error.message);
  return (
    <div className="card mx-auto mt-16 max-w-lg p-8 text-center">
      <h1 className="font-[family-name:var(--font-display)] text-4xl">{noDb ? 'Database not ready' : 'Something broke'}</h1>
      <p className="mt-2 text-muted">{noDb ? 'Run the setup once, then reload.' : error.message}</p>
      {noDb ? <pre className="mt-4 rounded-xl bg-surface-2 p-3 text-left text-[13px]">pnpm db:setup</pre> : null}
      <button onClick={reset} className="btn btn-ink mt-5">
        Try again
      </button>
    </div>
  );
}
