'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { PoolBadge } from '@/components/PoolBadge';
import { fmtRelative } from '@/lib/format';
import { cn } from '@/lib/cn';
import type { Worker, Pool } from '@/lib/types';

export default function WorkersPage() {
  const qc = useQueryClient();
  const workers = useQuery<Worker[]>({
    queryKey: ['workers'],
    queryFn: () => api.get<Worker[]>('/api/workers'),
    refetchInterval: 5_000,
  });

  async function drain(w: Worker) {
    if (!confirm(`Drain ${w.id}? It will finish in-flight jobs (${w.activeJobs}) and stop accepting new ones.`)) return;
    try {
      await api.post(`/api/workers/${w.id}/drain`);
      await qc.invalidateQueries({ queryKey: ['workers'] });
    } catch (e) {
      alert((e as Error).message);
    }
  }

  const grouped = (workers.data ?? []).reduce<Record<string, Worker[]>>((acc, w) => {
    (acc[w.poolType] ??= []).push(w);
    return acc;
  }, {});

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">Workers</h1>
        <p className="font-mono text-xs text-hive-subtle">HEARTBEATS EVERY 10S · OFFLINE AFTER 30S SILENCE</p>
      </div>
      {Object.keys(grouped).length === 0 && (
        <div className="rounded-lg border border-dashed border-hive-border p-8 text-center font-mono text-sm text-hive-subtle">
          No workers have checked in yet.
        </div>
      )}
      {Object.entries(grouped).map(([pool, ws]) => (
        <div key={pool} className="rounded-lg border border-hive-border bg-hive-surface">
          <div className="flex items-center gap-2 border-b border-hive-border px-4 py-3">
            <PoolBadge pool={pool as Pool} />
            <span className="font-mono text-xs text-hive-subtle">{ws.length} worker{ws.length === 1 ? '' : 's'}</span>
          </div>
          <table className="w-full text-sm">
            <thead className="text-left font-mono text-[10px] uppercase text-hive-subtle">
              <tr>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">ID</th>
                <th className="px-4 py-2">Hostname</th>
                <th className="px-4 py-2">Capacity</th>
                <th className="px-4 py-2">Active</th>
                <th className="px-4 py-2">Last seen</th>
                <th className="px-4 py-2"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {ws.map((w) => (
                <tr key={w.id} className="border-t border-hive-border">
                  <td className="px-4 py-2">
                    <span className={cn(
                      'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase',
                      w.status === 'online' ? 'border-emerald-500/30 text-emerald-400' :
                      w.status === 'draining' ? 'border-amber-500/30 text-amber-400' :
                      'border-zinc-500/30 text-zinc-400',
                    )}>
                      <span className={cn('h-1.5 w-1.5 rounded-full',
                        w.status === 'online' ? 'bg-emerald-400' : 'bg-zinc-500')} />
                      {w.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">{w.id}</td>
                  <td className="px-4 py-2 font-mono text-xs text-hive-subtle">{w.hostname}</td>
                  <td className="px-4 py-2 font-mono text-xs">{w.capacity}</td>
                  <td className="px-4 py-2 font-mono text-xs">{w.activeJobs}</td>
                  <td className="px-4 py-2 font-mono text-xs text-hive-subtle">{fmtRelative(w.lastSeenAt)}</td>
                  <td className="px-4 py-2 text-right">
                    {w.status === 'online' && (
                      <button
                        type="button"
                        onClick={() => drain(w)}
                        className="rounded border border-amber-500/30 px-2 py-0.5 text-xs text-amber-400 hover:bg-amber-500/10"
                      >
                        drain
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
