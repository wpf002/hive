'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { HealthCheck, Worker, Job } from '@/lib/types';
import { cn } from '@/lib/cn';

function Pill({ label, ok, value }: { label: string; ok?: boolean; value?: string | number }) {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-hive-border bg-hive-surface px-2 py-0.5 text-[11px] font-mono">
      {ok !== undefined && (
        <span className={cn('inline-block h-1.5 w-1.5 rounded-full', ok ? 'bg-emerald-400' : 'bg-red-500')} />
      )}
      <span className="text-hive-subtle">{label}</span>
      {value !== undefined && <span className="text-hive-text">{value}</span>}
    </span>
  );
}

export function StatusBar() {
  const health = useQuery<HealthCheck>({
    queryKey: ['health'],
    queryFn: () => api.get<HealthCheck>('/healthz'),
    refetchInterval: 5_000,
  });
  const workers = useQuery<Worker[]>({
    queryKey: ['workers'],
    queryFn: () => api.get<Worker[]>('/api/workers'),
    refetchInterval: 10_000,
  });
  const queued = useQuery<Job[]>({
    queryKey: ['jobs', 'queued'],
    queryFn: () => api.get<Job[]>('/api/jobs?status=queued&limit=200'),
    refetchInterval: 5_000,
  });
  const running = useQuery<Job[]>({
    queryKey: ['jobs', 'running'],
    queryFn: () => api.get<Job[]>('/api/jobs?status=running&limit=200'),
    refetchInterval: 3_000,
  });

  const onlineWorkers = workers.data?.filter((w) => w.status === 'online').length ?? 0;
  const totalWorkers = workers.data?.length ?? 0;
  const apiOk = !health.isError;
  const pgOk = health.data?.checks?.postgres?.ok;
  const redisOk = health.data?.checks?.redis?.ok;

  return (
    <footer className="flex h-8 shrink-0 items-center gap-2 border-t border-hive-border bg-hive-bg px-3">
      <Pill label="API"   ok={apiOk} />
      <Pill label="PG"    ok={!!pgOk} />
      <Pill label="Redis" ok={!!redisOk} />
      <div className="mx-1 h-4 w-px bg-hive-border" />
      <Pill label="Workers" value={`${onlineWorkers}/${totalWorkers}`} />
      <Pill label="Queued"  value={queued.data?.length ?? 0} />
      <Pill label="Running" value={running.data?.length ?? 0} />
      <div className="flex-1" />
      <span className="font-mono text-[10px] text-hive-subtle">{api.base}</span>
    </footer>
  );
}
