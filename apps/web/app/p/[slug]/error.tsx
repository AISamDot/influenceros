'use client';

/** Errors on a persona site: neutral public copy, never the error text or setup commands. */
export default function SiteError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="site-wrap" style={{ textAlign: 'center' }}>
      <h1 className="site-name" style={{ fontSize: 32 }}>
        Something went wrong
      </h1>
      <p className="site-lead" style={{ marginTop: 10 }}>
        Please try again in a moment.
      </p>
      <div className="site-links">
        <button type="button" className="site-btn site-btn-primary" onClick={reset}>
          Try again
        </button>
      </div>
    </main>
  );
}
