import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-5 bg-hive-bg bg-hex-grid p-4 text-center">
      <svg width="48" height="48" viewBox="0 0 24 24" aria-hidden className="text-honey-500">
        <path fill="currentColor" d="M12 2 21 7v10l-9 5-9-5V7l9-5Zm0 4.2L7 9.1v5.8l5 2.9 5-2.9V9.1l-5-2.9Z" />
      </svg>
      <div>
        <p className="font-mono text-5xl font-bold text-honey-500">404</p>
        <p className="mt-1 font-mono text-sm text-hive-subtle">This cell of the hive is empty.</p>
      </div>
      <Link
        href="/dashboard"
        className="rounded bg-honey-500 px-4 py-2 font-semibold text-black hover:bg-honey-400"
      >
        Back to dashboard
      </Link>
    </div>
  );
}
