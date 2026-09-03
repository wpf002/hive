'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';

/**
 * Take your data, or delete your account.
 *
 * Deletion is behind a password and a typed confirmation rather than a single
 * button, because it cannot be undone and a session cookie on a shared machine
 * should not be enough to destroy someone's work.
 */
export default function YourDataPage() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function download() {
    // Straight to the endpoint rather than through the JSON client: the
    // response is a file, and the browser should treat it as one.
    window.location.href = '/api/account/export';
  }

  async function remove(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.post('/api/account/delete', { password });
      router.push('/login');
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl space-y-8 px-4 py-8">
      <section className="space-y-3">
        <h1 className="font-mono text-sm uppercase tracking-[0.1em] text-hive-text">Your data</h1>
        <p className="font-mono text-xs leading-relaxed text-hive-subtle">
          Everything your account holds — bots, missions, what they found, your billing history and
          audit log — as one JSON file. Secret config values are masked; you already have those.
        </p>
        <button
          onClick={download}
          className="rounded border border-hive-border px-3 py-1.5 font-mono text-xs uppercase tracking-[0.1em] text-hive-subtle transition-all duration-150 hover:text-honey-500 active:scale-[0.96]"
        >
          Download export
        </button>
      </section>

      <section className="space-y-3 border-t border-hive-border pt-6">
        <h2 className="font-mono text-sm uppercase tracking-[0.1em] text-red-400">
          Delete this account
        </h2>
        <p className="font-mono text-xs leading-relaxed text-hive-subtle">
          Your bots stop and are removed, along with your missions and everything they collected.
          This cannot be undone. Download your export first if you want a copy.
        </p>
        <form onSubmit={remove} className="space-y-3">
          <label className="block">
            <span className="font-mono text-[11px] uppercase text-hive-subtle">
              Type DELETE to confirm
            </span>
            <input
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="mt-1 w-full rounded border border-hive-border bg-hive-bg px-2 py-1.5 font-mono text-sm"
            />
          </label>
          <label className="block">
            <span className="font-mono text-[11px] uppercase text-hive-subtle">Your password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
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
            disabled={busy || confirm !== 'DELETE' || !password}
            className="rounded bg-red-600 px-3 py-1.5 font-mono text-xs font-semibold uppercase tracking-[0.1em] text-white transition-all duration-150 hover:bg-red-500 active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100"
          >
            {busy ? 'Deleting…' : 'Delete my account'}
          </button>
        </form>
      </section>
    </div>
  );
}
