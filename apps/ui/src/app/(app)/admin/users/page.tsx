'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { fmtRelative } from '@/lib/format';

interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'user';
  createdAt: string;
  lastLoginAt: string | null;
}

interface AuditEntry {
  id: string;
  action: string;
  userId: string | null;
  user: { email: string; displayName: string } | null;
  targetType: string | null;
  targetId: string | null;
  payload: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: string;
}

export default function AdminUsersPage() {
  const qc = useQueryClient();
  const users = useQuery<AdminUser[]>({
    queryKey: ['admin', 'users'],
    queryFn: () => api.get<AdminUser[]>('/api/admin/users'),
  });
  const audit = useQuery<AuditEntry[]>({
    queryKey: ['admin', 'audit'],
    queryFn: () => api.get<AuditEntry[]>('/api/admin/audit?limit=50'),
    refetchInterval: 8_000,
  });

  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ email: '', displayName: '', password: '', role: 'user' as 'user' | 'admin' });
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setError(null);
    try {
      await api.post('/api/admin/users', form);
      setCreating(false);
      setForm({ email: '', displayName: '', password: '', role: 'user' });
      await qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      await qc.invalidateQueries({ queryKey: ['admin', 'audit'] });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function reset(u: AdminUser) {
    const pw = prompt(`New password for ${u.email}? (min 8 chars)`);
    if (!pw) return;
    try {
      await api.post(`/api/admin/users/${u.id}/reset-password`, { newPassword: pw });
      await qc.invalidateQueries({ queryKey: ['admin', 'audit'] });
      alert(`Password reset for ${u.email}. All their sessions were invalidated.`);
    } catch (e) {
      alert((e as Error).message);
    }
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">Admin · Users</h1>
        <p className="font-mono text-xs text-hive-subtle">ROLES · SESSIONS · AUDIT</p>
      </div>

      <div className="rounded-lg border border-hive-border bg-hive-surface">
        <div className="flex items-center justify-between border-b border-hive-border px-4 py-2">
          <div className="font-mono text-[11px] uppercase text-hive-subtle">Users</div>
          <button
            type="button"
            onClick={() => setCreating((c) => !c)}
            className="rounded border border-honey-500/40 px-2 py-0.5 font-mono text-xs text-honey-500 hover:bg-honey-500/10"
          >
            {creating ? 'Cancel' : '+ Create user'}
          </button>
        </div>
        {creating && (
          <div className="space-y-2 border-b border-hive-border px-4 py-3">
            <div className="grid grid-cols-2 gap-2">
              <input
                placeholder="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                className="rounded border border-hive-border bg-hive-bg px-2 py-1 font-mono text-xs"
              />
              <input
                placeholder="display name"
                value={form.displayName}
                onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                className="rounded border border-hive-border bg-hive-bg px-2 py-1 font-mono text-xs"
              />
              <input
                type="password"
                placeholder="password (min 8)"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                className="rounded border border-hive-border bg-hive-bg px-2 py-1 font-mono text-xs"
              />
              <select
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value as 'admin' | 'user' })}
                className="rounded border border-hive-border bg-hive-bg px-2 py-1 font-mono text-xs"
              >
                <option value="user">user</option>
                <option value="admin">admin</option>
              </select>
            </div>
            {error && <div className="font-mono text-xs text-red-400">{error}</div>}
            <button
              type="button"
              onClick={create}
              className="rounded bg-honey-500 px-3 py-1 text-xs font-semibold text-black hover:bg-honey-400"
            >Create</button>
          </div>
        )}
        <table className="w-full text-sm">
          <thead className="text-left font-mono text-[10px] uppercase text-hive-subtle">
            <tr>
              <th className="px-4 py-2">Email</th>
              <th className="px-4 py-2">Display name</th>
              <th className="px-4 py-2">Role</th>
              <th className="px-4 py-2">Created</th>
              <th className="px-4 py-2">Last login</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {users.data?.map((u) => (
              <tr key={u.id} className="border-t border-hive-border">
                <td className="px-4 py-2 font-mono text-xs">{u.email}</td>
                <td className="px-4 py-2 font-mono text-xs">{u.displayName}</td>
                <td className="px-4 py-2">
                  <span className={cn(
                    'rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase',
                    u.role === 'admin' ? 'border-honey-500/50 text-honey-500' : 'border-hive-border text-hive-subtle',
                  )}>{u.role}</span>
                </td>
                <td className="px-4 py-2 font-mono text-[11px] text-hive-subtle">{fmtRelative(u.createdAt)}</td>
                <td className="px-4 py-2 font-mono text-[11px] text-hive-subtle">{u.lastLoginAt ? fmtRelative(u.lastLoginAt) : '—'}</td>
                <td className="px-4 py-2 text-right">
                  <button
                    onClick={() => reset(u)}
                    className="rounded border border-hive-border px-2 py-0.5 font-mono text-[11px] text-hive-subtle hover:text-honey-500"
                  >Reset password</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="rounded-lg border border-hive-border bg-hive-surface">
        <div className="border-b border-hive-border px-4 py-2 font-mono text-[11px] uppercase text-hive-subtle">Audit log · 50 most recent</div>
        <table className="w-full text-sm">
          <thead className="text-left font-mono text-[10px] uppercase text-hive-subtle">
            <tr>
              <th className="px-4 py-2">Time</th>
              <th className="px-4 py-2">Action</th>
              <th className="px-4 py-2">Actor</th>
              <th className="px-4 py-2">Target</th>
              <th className="px-4 py-2">IP</th>
            </tr>
          </thead>
          <tbody>
            {audit.data?.map((a) => (
              <tr key={a.id} className="border-t border-hive-border">
                <td className="px-4 py-2 font-mono text-[11px] text-hive-subtle">{fmtRelative(a.createdAt)}</td>
                <td className="px-4 py-2 font-mono text-xs">{a.action}</td>
                <td className="px-4 py-2 font-mono text-[11px] text-hive-subtle">{a.user?.email ?? '—'}</td>
                <td className="px-4 py-2 font-mono text-[11px] text-hive-subtle">{a.targetType ? `${a.targetType}/${a.targetId?.slice(0, 10)}` : '—'}</td>
                <td className="px-4 py-2 font-mono text-[11px] text-hive-subtle">{a.ipAddress ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
