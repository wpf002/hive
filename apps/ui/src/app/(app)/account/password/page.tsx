'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';

export default function ChangePasswordPage() {
  const router = useRouter();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (next.length < 8) return setError('new password must be at least 8 characters');
    if (next !== confirm) return setError('new password and confirmation do not match');
    try {
      await api.post('/api/auth/change-password', { currentPassword: current, newPassword: next });
      setDone(true);
      setTimeout(() => {
        router.push('/login');
        router.refresh();
      }, 1500);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="space-y-4 p-6">
      <div className="rounded-lg border border-hive-border bg-hive-surface px-4 py-3">
        <h1 className="text-xl font-bold sm:text-2xl">Change Password</h1>
        <p className="mt-1 font-mono text-xs text-hive-subtle">CHANGING WILL INVALIDATE ALL YOUR OTHER SESSIONS</p>
      </div>
      <form onSubmit={submit} className="max-w-md space-y-3 rounded-lg border border-hive-border bg-hive-surface p-4">
        <label className="block">
          <span className="font-mono text-[11px] uppercase text-hive-subtle">Current password</span>
          <input
            type="password" required value={current}
            onChange={(e) => setCurrent(e.target.value)}
            className="mt-1 w-full rounded border border-hive-border bg-hive-bg px-2 py-1 font-mono text-xs"
          />
        </label>
        <label className="block">
          <span className="font-mono text-[11px] uppercase text-hive-subtle">New password</span>
          <input
            type="password" required value={next}
            onChange={(e) => setNext(e.target.value)}
            className="mt-1 w-full rounded border border-hive-border bg-hive-bg px-2 py-1 font-mono text-xs"
          />
        </label>
        <label className="block">
          <span className="font-mono text-[11px] uppercase text-hive-subtle">Confirm new password</span>
          <input
            type="password" required value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="mt-1 w-full rounded border border-hive-border bg-hive-bg px-2 py-1 font-mono text-xs"
          />
        </label>
        {error && <div className="font-mono text-xs text-red-400">{error}</div>}
        {done && <div className="font-mono text-xs text-emerald-400">Password changed. Redirecting to login…</div>}
        <button
          type="submit"
          className="rounded bg-honey-500 px-3 py-1.5 text-xs font-semibold text-black hover:bg-honey-400"
        >Change password</button>
      </form>
    </div>
  );
}
