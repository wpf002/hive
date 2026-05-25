'use client';
import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next') || '/dashboard';

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
    <div className="flex min-h-screen items-center justify-center bg-hive-bg bg-hex-grid p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-4 rounded-lg border border-hive-border bg-hive-surface p-6"
      >
        <div>
          <h1 className="font-mono text-2xl font-bold text-honey-500">HIVE</h1>
          <p className="font-mono text-xs text-hive-subtle">Sign in to continue</p>
        </div>
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
      </form>
    </div>
  );
}
