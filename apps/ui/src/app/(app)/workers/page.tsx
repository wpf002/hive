'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { PoolBadge } from '@/components/PoolBadge';
import { fmtRelative } from '@/lib/format';
import { cn } from '@/lib/cn';
import type { Worker, Pool, Job } from '@/lib/types';

export default function WorkersPage() {
  const qc = useQueryClient();
  const workers = useQuery<Worker[]>({
    queryKey: ['workers'],
    queryFn: () => api.get<Worker[]>('/api/workers'),
    refetchInterval: 5_000,
  });
  const unroutable = useQuery<Job[]>({
    queryKey: ['jobs', 'unroutable'],
    queryFn: () => api.get<Job[]>('/api/jobs?status=unroutable'),
    refetchInterval: 10_000,
  });

  async function stop(w: Worker) {
    if (!confirm(`Stop ${w.id}? It will finish its ${w.activeJobs} in-flight job(s), then exit and stop accepting new ones.`)) return;
    try {
      await api.post(`/api/workers/${w.id}/drain`);
      await qc.invalidateQueries({ queryKey: ['workers'] });
    } catch (e) {
      alert((e as Error).message);
    }
  }

  // Phase 5b: group by region first, then zone, then pool. Single-host
  // setups collapse into (local, default) and render identically to pre-5b.
  type Group = { region: string; zone: string; pools: Map<string, Worker[]> };
  const groups: Group[] = useMemo(() => {
    const byRegionZone = new Map<string, Group>();
    for (const w of workers.data ?? []) {
      const key = `${w.region ?? 'local'}/${w.zone ?? 'default'}`;
      let g = byRegionZone.get(key);
      if (!g) {
        g = { region: w.region ?? 'local', zone: w.zone ?? 'default', pools: new Map() };
        byRegionZone.set(key, g);
      }
      const list = g.pools.get(w.poolType) ?? [];
      list.push(w);
      g.pools.set(w.poolType, list);
    }
    return Array.from(byRegionZone.values()).sort((a, b) =>
      a.region.localeCompare(b.region) || a.zone.localeCompare(b.zone),
    );
  }, [workers.data]);

  return (
    <div className="space-y-6 p-6">
      <div className="rounded-lg border border-hive-border bg-hive-surface px-4 py-3">
        <h1 className="text-2xl font-bold">Workers</h1>
        <p className="mt-1 font-mono text-xs text-hive-subtle">HEARTBEATS EVERY 10S · OFFLINE AFTER 30S SILENCE · GROUPED BY REGION/ZONE</p>
      </div>

      {(unroutable.data?.length ?? 0) > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm">
          <strong className="font-mono uppercase text-amber-300">⚠ {unroutable.data!.length} unroutable job{unroutable.data!.length === 1 ? '' : 's'}</strong>
          <span className="ml-2 text-amber-200/80">
            no online worker matched the bot&rsquo;s affinity within 60s.
            {' '}
            <Link href="/jobs?status=unroutable" className="underline">
              View jobs
            </Link>{' '}— spin up a worker in the right region/zone, or edit the bot&rsquo;s affinity override.
          </span>
        </div>
      )}

      {groups.length === 0 && (
        <div className="rounded-lg border border-dashed border-hive-border p-8 text-center font-mono text-sm text-hive-subtle">
          No workers have checked in yet.
        </div>
      )}

      {groups.map((g) => (
        <RegionZoneGroup key={`${g.region}-${g.zone}`} group={g} onStop={stop} />
      ))}
    </div>
  );
}

function RegionZoneGroup({
  group,
  onStop,
}: {
  group: { region: string; zone: string; pools: Map<string, Worker[]> };
  onStop: (w: Worker) => void;
}) {
  const [open, setOpen] = useState(true);
  const total = Array.from(group.pools.values()).reduce((sum, ws) => sum + ws.length, 0);
  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 text-left"
      >
        <span className="rounded border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 font-mono text-[10px] uppercase text-sky-300">
          {group.region}
        </span>
        <span className="rounded border border-zinc-500/30 bg-zinc-500/10 px-1.5 py-0.5 font-mono text-[10px] uppercase text-zinc-300">
          {group.zone}
        </span>
        <span className="font-mono text-xs text-hive-subtle">
          {total} worker{total === 1 ? '' : 's'} · {group.pools.size} pool{group.pools.size === 1 ? '' : 's'}
        </span>
        <span className="font-mono text-[10px] text-hive-subtle">{open ? '▾' : '▸'}</span>
      </button>
      {open &&
        Array.from(group.pools.entries()).map(([pool, ws]) => (
          <div key={pool} className="rounded-lg border border-hive-border bg-hive-surface">
            <div className="flex items-center gap-2 border-b border-hive-border px-4 py-3">
              <PoolBadge pool={pool as Pool} />
              <span className="font-mono text-xs text-hive-subtle">
                {ws.length} worker{ws.length === 1 ? '' : 's'}
              </span>
            </div>
            <div className="overflow-x-auto"><table className="w-full min-w-[680px] text-sm">
              <thead className="text-left font-mono text-[10px] uppercase text-hive-subtle">
                <tr>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">ID</th>
                  <th className="px-4 py-2">Hostname</th>
                  <th className="px-4 py-2">Capacity</th>
                  <th className="px-4 py-2">Active</th>
                  <th className="px-4 py-2">Last seen</th>
                  <th className="px-4 py-2">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {ws.map((w) => (
                  <tr key={w.id} className="border-t border-hive-border">
                    <td className="px-4 py-2">
                      <span
                        className={cn(
                          'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase',
                          w.status === 'online'
                            ? 'border-emerald-500/30 text-emerald-400'
                            : w.status === 'draining'
                              ? 'border-amber-500/30 text-amber-400'
                              : 'border-zinc-500/30 text-zinc-400',
                        )}
                      >
                        <span
                          className={cn(
                            'h-1.5 w-1.5 rounded-full',
                            w.status === 'online' ? 'bg-emerald-400' : 'bg-zinc-500',
                          )}
                        />
                        {w.status}
                      </span>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">{w.id}</td>
                    <td className="px-4 py-2 font-mono text-xs text-hive-subtle">{w.hostname}</td>
                    <td className="px-4 py-2 font-mono text-xs">{w.capacity}</td>
                    <td className="px-4 py-2 font-mono text-xs">{w.activeJobs}</td>
                    <td className="px-4 py-2 font-mono text-xs text-hive-subtle">
                      {fmtRelative(w.lastSeenAt)}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {w.status === 'online' && (
                        <button
                          type="button"
                          onClick={() => onStop(w)}
                          title="Finish in-flight jobs, then exit. Stops accepting new jobs immediately."
                          className="rounded border border-amber-500/30 px-2 py-0.5 text-xs text-amber-400 hover:bg-amber-500/10"
                        >
                          Stop
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </div>
        ))}
    </div>
  );
}
