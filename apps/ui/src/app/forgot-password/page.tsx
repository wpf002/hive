'use client';
import { useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      // The API always returns 200 (no account enumeration), so we show the
      // same confirmation regardless of whether the address exists.
      await api.post('/api/auth/request-password-reset', { email });
    } catch {
      /* swallow — still show the neutral confirmation */
    } finally {
      setBusy(false);
      setDone(true);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-hive-bg bg-hex-grid p-4">
      <div className="w-full max-w-sm space-y-4 rounded-lg border border-hive-border bg-hive-surface p-6 shadow-xl">
        <div>
          <h1 className="font-mono text-xl font-bold text-honey-500">Reset password</h1>
          <p className="font-mono text-xs text-hive-subtle">
            Enter your email and we&apos;ll send you a reset link.
          </p>
        </div>

        {done ? (
          <div className="space-y-4">
            <div className="rounded border border-honey-500/30 bg-honey-500/10 p-3 font-mono text-xs text-hive-text">
              If an account exists for <span className="text-honey-400">{email}</span>, a reset
              link is on its way. Check your inbox (and spam) — the link expires in 1 hour.
            </div>
            <Link href="/login" className="block font-mono text-xs text-hive-subtle hover:text-honey-400">
              ← Back to sign in
            </Link>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
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
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded bg-honey-500 px-3 py-2 font-semibold text-black hover:bg-honey-400 disabled:opacity-60"
            >
              {busy ? 'Sending…' : 'Send reset link'}
            </button>
            <Link href="/login" className="block text-center font-mono text-[11px] text-hive-subtle hover:text-honey-400">
              ← Back to sign in
            </Link>
          </form>
        )}
      </div>
    </div>
  );
}
