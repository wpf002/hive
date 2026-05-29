'use client';
import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';

// useSearchParams() requires a Suspense boundary for static prerendering (next build).
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next') || '/dashboard';
  const justReset = params.get('reset') === '1';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.post('/api/auth/login', { email, password });
      router.push(next);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-hive-bg bg-hex-grid p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-4 rounded-lg border border-hive-border bg-hive-surface p-6 shadow-xl"
      >
        <div className="flex flex-col items-center gap-2 text-center">
          {/* Hive logo — hexagon mark + wordmark. */}
          <svg width="44" height="44" viewBox="0 0 24 24" aria-hidden className="text-honey-500">
            <path
              fill="currentColor"
              d="M12 2 21 7v10l-9 5-9-5V7l9-5Zm0 4.2L7 9.1v5.8l5 2.9 5-2.9V9.1l-5-2.9Z"
            />
          </svg>
          <h1 className="font-mono text-2xl font-bold tracking-widest text-honey-500">HIVE</h1>
          <p className="font-mono text-xs text-hive-subtle">Sign in to your account</p>
        </div>
        {justReset && (
          <div className="rounded border border-honey-500/30 bg-honey-500/10 p-2 font-mono text-xs text-hive-text">
            Password updated. Sign in with your new password.
          </div>
        )}
        <label className="block">
          <span className="font-mono text-[11px] uppercase text-hive-subtle">Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
            className="mt-1 w-full rounded border border-hive-border bg-hive-bg px-2 py-1.5 font-mono text-sm"
          />
        </label>
        <label className="block">
          <span className="font-mono text-[11px] uppercase text-hive-subtle">Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
            className="mt-1 w-full rounded border border-hive-border bg-hive-bg px-2 py-1.5 font-mono text-sm"
          />
        </label>
        {error && (
          <div className="rounded border border-red-500/40 bg-red-500/10 p-2 font-mono text-xs text-red-300">
            {error}
          </div>
        )}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded bg-honey-500 px-3 py-2 font-semibold text-black hover:bg-honey-400 disabled:opacity-60"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <div className="text-center">
          <Link
            href="/forgot-password"
            className="font-mono text-[11px] text-hive-subtle underline-offset-2 hover:text-honey-400 hover:underline"
          >
            Forgot password?
          </Link>
        </div>
      </form>
    </div>
  );
}
