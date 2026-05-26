'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { StatusBadge } from '@/components/StatusBadge';
import { PoolBadge } from '@/components/PoolBadge';
import { fmtDuration, fmtRelative, fmtJobShort } from '@/lib/format';
import { cn } from '@/lib/cn';
import type { Job, JobStatus, DlqEntry, Pool } from '@/lib/types';

const STATUSES: (JobStatus | 'all')[] = ['all', 'queued', 'running', 'succeeded', 'failed', 'cancelled', 'unroutable'];
const STATUS_LABELS: Record<JobStatus | 'all', string> = {
  all: 'All',
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
  unroutable: 'Unroutable',
};
type Tab = 'jobs' | 'dlq';

export default function JobsPage() {
  const [tab, setTab] = useState<Tab>('jobs');
  const [filter, setFilter] = useState<JobStatus | 'all'>('all');
  const qc = useQueryClient();

  const jobs = useQuery<Job[]>({
    queryKey: ['jobs', filter],
    queryFn: () => api.get<Job[]>(`/api/jobs?limit=100${filter !== 'all' ? `&status=${filter}` : ''}`),
    refetchInterval: tab === 'jobs' ? 4_000 : false,
  });

  const dlq = useQuery<DlqEntry[]>({
    queryKey: ['jobs', 'dlq'],
    queryFn: () => api.get<DlqEntry[]>('/api/jobs/dlq'),
    refetchInterval: tab === 'dlq' ? 5_000 : false,
    enabled: tab === 'dlq',
  });

  async function retry(jobId: string) {
    try {
      await api.post(`/api/jobs/${jobId}/requeue`);
      await qc.invalidateQueries({ queryKey: ['jobs'] });
    } catch (e) {
      alert((e as Error).message);
    }
  }

  return (
    <div className="space-y-4 p-6">
      <div className="rounded-lg border border-hive-border bg-hive-surface px-4 py-3">
        <h1 className="text-2xl font-bold">Jobs</h1>
        <p className="mt-1 font-mono text-xs text-hive-subtle">EVERY EXECUTION</p>
      </div>

      <div className="rounded-lg border border-hive-border bg-hive-surface">
        <div className="flex gap-1 border-b border-hive-border px-2 pt-1">
          {(['jobs', 'dlq'] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                '-mb-px border-b-2 px-3 py-1.5 font-mono text-xs',
                tab === t
                  ? 'border-honey-500 text-honey-500'
                  : 'border-transparent text-hive-subtle hover:text-hive-text',
              )}
            >
              {t === 'jobs' ? 'Jobs' : `Quarantine${dlq.data ? ` · ${dlq.data.length}` : ''}`}
            </button>
          ))}
        </div>
        {tab === 'jobs' && (
          <div className="flex flex-wrap gap-2 p-3">
            {STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setFilter(s)}
                className={cn(
                  'rounded border px-2 py-1 font-mono text-[11px]',
                  filter === s
                    ? 'border-honey-500 bg-honey-500/10 text-honey-500'
                    : 'border-hive-border text-hive-subtle hover:bg-hive-muted',
                )}
              >{STATUS_LABELS[s]}</button>
            ))}
          </div>
        )}
      </div>

      {tab === 'jobs' && (
        <>
          <div className="rounded-lg border border-hive-border bg-hive-surface">
            <table className="w-full text-sm">
              <thead className="text-left font-mono text-[10px] uppercase text-hive-subtle">
                <tr>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Bot</th>
                  <th className="px-4 py-2">Pool</th>
                  <th className="px-4 py-2">Attempts</th>
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
                    <td className="px-4 py-2 font-mono text-xs">{j.attempts}/{j.maxAttempts}</td>
                    <td className="px-4 py-2 font-mono text-xs text-hive-subtle">{fmtRelative(j.createdAt)}</td>
                    <td className="px-4 py-2 font-mono text-xs">{fmtDuration(j.startedAt, j.finishedAt)}</td>
                  </tr>
                ))}
                {jobs.data && jobs.data.length === 0 && (
                  <tr><td colSpan={6} className="px-4 py-6 text-center font-mono text-xs text-hive-subtle">No jobs</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === 'dlq' && (
        <div className="rounded-lg border border-hive-border bg-hive-surface">
          <table className="w-full text-sm">
            <thead className="text-left font-mono text-[10px] uppercase text-hive-subtle">
              <tr>
                <th className="px-4 py-2">Job ID</th>
                <th className="px-4 py-2">Pool</th>
                <th className="px-4 py-2">Template</th>
                <th className="px-4 py-2">Error</th>
                <th className="px-4 py-2">Failed at</th>
                <th className="px-4 py-2"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {dlq.data?.map((d) => (
                <tr key={d.entryId} className="border-t border-hive-border hover:bg-hive-muted/30">
                  <td className="px-4 py-2 font-mono text-xs">
                    <Link href={`/jobs/${d.jobId}`} title={d.jobId} className="hover:text-honey-500">{fmtJobShort(d.jobId)}</Link>
                  </td>
                  <td className="px-4 py-2"><PoolBadge pool={d.pool as Pool} /></td>
                  <td className="px-4 py-2 font-mono text-xs">{d.templateName}</td>
                  <td className="px-4 py-2 max-w-md truncate font-mono text-xs text-red-400">{d.error}</td>
                  <td className="px-4 py-2 font-mono text-xs text-hive-subtle">{fmtRelative(d.failedAt)}</td>
                  <td className="px-4 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => retry(d.jobId)}
                      title="Re-queue this job using the bot's current config"
                      className="rounded border border-honey-500/30 px-2 py-0.5 text-xs text-honey-500 hover:bg-honey-500/10"
                    >
                      Retry
                    </button>
                  </td>
                </tr>
              ))}
              {dlq.data && dlq.data.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-6 text-center font-mono text-xs text-hive-subtle">No dead-lettered jobs</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
