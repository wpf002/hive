'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { StatusBadge } from '@/components/StatusBadge';
import { PoolBadge } from '@/components/PoolBadge';
import { fmtDuration, fmtRelative } from '@/lib/format';
import { cn } from '@/lib/cn';
import type { Job, JobStatus } from '@/lib/types';

const STATUSES: (JobStatus | 'all')[] = ['all', 'queued', 'running', 'succeeded', 'failed', 'cancelled'];

export default function JobsPage() {
  const [filter, setFilter] = useState<JobStatus | 'all'>('all');
  const jobs = useQuery<Job[]>({
    queryKey: ['jobs', filter],
    queryFn: () => api.get<Job[]>(`/api/jobs?limit=100${filter !== 'all' ? `&status=${filter}` : ''}`),
    refetchInterval: 4_000,
  });

  return (
    <div className="space-y-4 p-6">
      <div>
        <h1 className="text-2xl font-bold">Jobs</h1>
        <p className="font-mono text-xs text-hive-subtle">Every execution, newest first</p>
      </div>

      <div className="flex flex-wrap gap-2">
        {STATUSES.map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={cn(
              'rounded border px-2 py-1 font-mono text-[11px] uppercase',
              filter === s
                ? 'border-honey-500 bg-honey-500/10 text-honey-500'
                : 'border-hive-border text-hive-subtle hover:bg-hive-muted',
            )}
          >{s}</button>
        ))}
      </div>

      <div className="rounded-lg border border-hive-border bg-hive-surface">
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
            {jobs.data?.map((j) => (
              <tr key={j.id} className="border-t border-hive-border hover:bg-hive-muted/30">
                <td className="px-4 py-2">
                  <Link href={`/jobs/${j.id}`}><StatusBadge status={j.status} /></Link>
                </td>
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
            {jobs.data && jobs.data.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-6 text-center font-mono text-xs text-hive-subtle">no jobs</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
