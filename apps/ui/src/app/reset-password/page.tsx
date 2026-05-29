'use client';
import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';

// useSearchParams() requires a Suspense boundary for static prerendering (next build).
export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordForm />
    </Suspense>
  );
}

function ResetPasswordForm() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await api.post('/api/auth/reset-password', { token, newPassword: password });
      // Sessions were invalidated server-side; send them to sign in fresh.
      router.push('/login?reset=1');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-hive-bg bg-hex-grid p-4">
      <div className="w-full max-w-sm space-y-4 rounded-lg border border-hive-border bg-hive-surface p-6 shadow-xl">
        <div>
          <h1 className="font-mono text-xl font-bold text-honey-500">Choose a new password</h1>
          <p className="font-mono text-xs text-hive-subtle">
            Enter a new password for your Hive account.
          </p>
        </div>

        {!token ? (
          <div className="space-y-4">
            <div className="rounded border border-red-500/40 bg-red-500/10 p-3 font-mono text-xs text-red-300">
              This reset link is missing its token. Request a new link to continue.
            </div>
            <Link href="/forgot-password" className="block font-mono text-xs text-hive-subtle hover:text-honey-400">
              ← Request a new link
            </Link>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <label className="block">
              <span className="font-mono text-[11px] uppercase text-hive-subtle">New password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
                className="mt-1 w-full rounded border border-hive-border bg-hive-bg px-2 py-1.5 font-mono text-sm"
              />
            </label>
            <label className="block">
              <span className="font-mono text-[11px] uppercase text-hive-subtle">Confirm password</span>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
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
              {busy ? 'Updating…' : 'Update password'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
