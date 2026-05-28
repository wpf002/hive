'use client';
import Link from 'next/link';

// App-router error boundary (the branded "500" page). Next.js passes `error`
// with an optional `digest` — a stable hash of the server error we surface as a
// request ID so a user can quote it to support and we can grep server logs.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const requestId = error.digest ?? 'n/a';
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-5 bg-hive-bg bg-hex-grid p-4 text-center">
      <svg width="48" height="48" viewBox="0 0 24 24" aria-hidden className="text-red-400">
        <path fill="currentColor" d="M12 2 21 7v10l-9 5-9-5V7l9-5Zm0 4.2L7 9.1v5.8l5 2.9 5-2.9V9.1l-5-2.9Z" />
      </svg>
      <div>
        <p className="font-mono text-5xl font-bold text-red-400">500</p>
        <p className="mt-1 font-mono text-sm text-hive-subtle">Something went wrong.</p>
        <p className="mt-3 font-mono text-[11px] text-hive-subtle">
          Request ID: <span className="text-hive-text">{requestId}</span>
        </p>
      </div>
      <div className="flex gap-2">
        <button
          onClick={reset}
          className="rounded bg-honey-500 px-4 py-2 font-semibold text-black hover:bg-honey-400"
        >
          Try again
        </button>
        <Link
          href="/dashboard"
          className="rounded border border-hive-border px-4 py-2 font-mono text-sm text-hive-text hover:border-honey-500"
        >
          Dashboard
        </Link>
      </div>
    </div>
  );
}
