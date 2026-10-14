import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="card mx-auto mt-16 max-w-md p-8 text-center">
      <h1 className="font-[family-name:var(--font-display)] text-4xl">Not here</h1>
      <p className="mt-2 text-muted">That page or persona doesn&apos;t exist.</p>
      <Link href="/" className="btn btn-ink mt-5">
        Back to the studio
      </Link>
    </div>
  );
}
