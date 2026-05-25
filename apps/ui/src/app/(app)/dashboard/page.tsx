'use client';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { PoolBadge } from '@/components/PoolBadge';
import { StatusBadge } from '@/components/StatusBadge';
import { fmtDuration, fmtRelative } from '@/lib/format';
import type { Job, Worker, BotTemplate } from '@/lib/types';

function Stat({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div className="rounded-lg border border-hive-border bg-hive-surface p-4">
      <div className="font-mono text-[10px] uppercase tracking-wide text-hive-subtle">{label}</div>
      <div className="mt-1 text-3xl font-semibold text-honey-500">{value}</div>
      {hint && <div className="mt-1 font-mono text-[10px] text-hive-subtle">{hint}</div>}
    </div>
  );
}

export default function DashboardPage() {
  const recent = useQuery<Job[]>({
    queryKey: ['jobs', 'recent', 12],
    queryFn: () => api.get<Job[]>('/api/jobs?limit=12'),
    refetchInterval: 4_000,
  });
  const running = useQuery<Job[]>({
    queryKey: ['jobs', 'running'],
    queryFn: () => api.get<Job[]>('/api/jobs?status=running&limit=200'),
    refetchInterval: 3_000,
  });
  const queued = useQuery<Job[]>({
    queryKey: ['jobs', 'queued'],
    queryFn: () => api.get<Job[]>('/api/jobs?status=queued&limit=200'),
    refetchInterval: 5_000,
  });
  const workers = useQuery<Worker[]>({
    queryKey: ['workers'],
    queryFn: () => api.get<Worker[]>('/api/workers'),
    refetchInterval: 10_000,
  });
  const templates = useQuery<BotTemplate[]>({
    queryKey: ['templates'],
    queryFn: () => api.get<BotTemplate[]>('/api/templates'),
  });

  const onlineWorkers = workers.data?.filter((w) => w.status === 'online').length ?? 0;

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="font-mono text-xs text-hive-subtle">HIVE CONTROL PLANE · PHASE 1</p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Running" value={running.data?.length ?? 0} />
        <Stat label="Queued" value={queued.data?.length ?? 0} />
        <Stat label="Workers online" value={onlineWorkers} hint={`OF ${workers.data?.length ?? 0} TOTAL`} />
        <Stat label="Templates" value={templates.data?.length ?? 0} />
      </div>

      <div className="rounded-lg border border-hive-border bg-hive-surface">
        <div className="flex items-center justify-between border-b border-hive-border px-4 py-3">
          <h2 className="font-semibold">Recent jobs</h2>
          <Link href="/jobs" className="font-mono text-xs text-honey-500 hover:underline">All jobs →</Link>
        </div>
        <table className="w-full text-sm">
          <thead className="text-left font-mono text-[10px] uppercase text-hive-subtle">
            <tr>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Bot</th>
              <th className="px-4 py-2">Pool</th>
              <th className="px-4 py-2">Created</th>
              <th className="px-4 py-2">Duration</th>
            </tr>
          </thead>
          <tbody>
            {recent.data?.map((j) => (
              <tr key={j.id} className="border-t border-hive-border hover:bg-hive-muted/30">
                <td className="px-4 py-2"><StatusBadge status={j.status} /></td>
                <td className="px-4 py-2">
                  <Link href={`/jobs/${j.id}`} className="hover:text-honey-500">
                    {j.bot?.name ?? j.botId.slice(0, 8)}
                  </Link>
                </td>
                <td className="px-4 py-2">{j.bot?.template && <PoolBadge pool={j.bot.template.poolType} />}</td>
                <td className="px-4 py-2 font-mono text-xs text-hive-subtle">{fmtRelative(j.createdAt)}</td>
                <td className="px-4 py-2 font-mono text-xs">{fmtDuration(j.startedAt, j.finishedAt)}</td>
              </tr>
            ))}
            {recent.data && recent.data.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-6 text-center font-mono text-xs text-hive-subtle">No jobs yet — run a bot to see them here</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
