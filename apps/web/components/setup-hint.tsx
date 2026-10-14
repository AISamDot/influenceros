export function SetupHint({ error }: { error?: string }) {
  return (
    <div className="card mx-auto mt-16 max-w-lg p-8 text-center">
      <h1 className="font-[family-name:var(--font-display)] text-4xl">Almost there</h1>
      <p className="mt-3 text-muted">The database has no studio yet. Run the setup once, then reload:</p>
      <pre className="mt-4 rounded-xl bg-surface-2 p-3 text-left text-[13px]">pnpm db:setup</pre>
      {error ? <p className="mt-4 text-[12px] text-faint">{error}</p> : null}
    </div>
  );
}
