'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useMe } from '@/lib/useMe';
import { StatusBadge } from '@/components/StatusBadge';
import { PoolBadge } from '@/components/PoolBadge';
import { LiveLogStream } from '@/components/LiveLogStream';
import { fmtDateTime, fmtDuration, fmtJobShort } from '@/lib/format';
import type { Job } from '@/lib/types';

interface ArtifactSummary {
  id: string;
  jobId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

export default function JobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const { isAdmin } = useMe();
  const job = useQuery<Job>({
    queryKey: ['job', id],
    queryFn: () => api.get<Job>(`/api/jobs/${id}`),
    refetchInterval: (q) => (q.state.data && TERMINAL.has(q.state.data.status) ? false : 3_000),
  });
  const artifacts = useQuery<ArtifactSummary[]>({
    queryKey: ['job-artifacts', id],
    queryFn: () => api.get<ArtifactSummary[]>(`/api/jobs/${id}/artifacts`),
    // Poll while the job is still running so new uploads appear without a hard refresh.
    refetchInterval: () => (job.data && TERMINAL.has(job.data.status) ? false : 5_000),
    enabled: !!job.data,
  });

  async function cancel() {
    if (!confirm('Cancel this job?')) return;
    try {
      await api.post(`/api/jobs/${id}/cancel`);
      await qc.invalidateQueries({ queryKey: ['job', id] });
    } catch (e) {
      alert((e as Error).message);
    }
  }

  if (!job.data) {
    return <div className="p-6 font-mono text-sm text-hive-subtle">{job.isLoading ? 'Loading…' : 'Job not found'}</div>;
  }

  const j = job.data;

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <Link href="/jobs" className="font-mono text-xs text-hive-subtle hover:text-honey-500">← Jobs</Link>
          <div className="flex items-center gap-2">
            <StatusBadge status={j.status} />
            {j.bot?.template && <PoolBadge pool={j.bot.template.poolType} />}
            {j.bot?.template?.poolType === 'trading' && (
              <TradingModeBadge config={j.bot.config as Record<string, unknown>} />
            )}
            <span title={j.id} className="font-mono text-xs text-hive-subtle">{fmtJobShort(j.id)}</span>
          </div>
          <div className="font-mono text-xs text-hive-subtle">
            Bot: {j.bot && <Link className="hover:text-honey-500" href={`/bots/${j.botId}`}>{j.bot.name}</Link>}
          </div>
        </div>
        <div className="flex gap-2">
          {isAdmin && (j.status === 'running' || j.status === 'queued') && (
            <button
              type="button"
              onClick={cancel}
              className="rounded border border-red-500/30 px-3 py-1.5 text-sm text-red-400 hover:bg-red-500/10"
            >Cancel</button>
          )}
          {isAdmin && j.status === 'failed' && (
            <button
              type="button"
              onClick={async () => {
                try {
                  await api.post(`/api/jobs/${id}/requeue`);
                  await qc.invalidateQueries({ queryKey: ['job', id] });
                } catch (e) {
                  alert((e as Error).message);
                }
              }}
              className="rounded border border-honey-500/30 px-3 py-1.5 text-sm text-honey-500 hover:bg-honey-500/10"
            >Requeue</button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Info label="created" value={fmtDateTime(j.createdAt)} />
        <Info label="started" value={j.startedAt ? fmtDateTime(j.startedAt) : '—'} />
        <Info label="finished" value={j.finishedAt ? fmtDateTime(j.finishedAt) : '—'} />
        <Info label="duration" value={fmtDuration(j.startedAt, j.finishedAt)} />
        <Info label="attempts" value={`${j.attempts}/${j.maxAttempts}`} />
      </div>

      <section className="space-y-2">
        <h2 className="font-semibold">Live Logs</h2>
        <LiveLogStream jobId={j.id} />
      </section>

      {artifacts.data && artifacts.data.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-semibold">Artifacts</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {artifacts.data.map((a) => (
              <ArtifactCard key={a.id} artifact={a} />
            ))}
          </div>
        </section>
      )}

      <section className="grid gap-4 lg:grid-cols-2">
        <Panel title="Result">
          {j.result !== null ? (
            <pre className="max-h-72 overflow-auto rounded border border-hive-border bg-black/40 p-2 font-mono text-[11px]">
              {JSON.stringify(j.result, null, 2)}
            </pre>
          ) : (
            <div className="font-mono text-xs text-hive-subtle">—</div>
          )}
        </Panel>
        <Panel title="Payload">
          <pre className="max-h-72 overflow-auto rounded border border-hive-border bg-black/40 p-2 font-mono text-[11px]">
            {JSON.stringify(j.payload, null, 2)}
          </pre>
        </Panel>
        {j.error && (
          <Panel title="Error">
            <pre className="overflow-auto rounded border border-red-500/30 bg-red-500/10 p-2 font-mono text-[11px] text-red-300">{j.error}</pre>
          </Panel>
        )}
      </section>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-hive-border bg-hive-surface p-3">
      <div className="font-mono text-[10px] uppercase text-hive-subtle">{label}</div>
      <div className="mt-1 font-mono text-xs">{value}</div>
    </div>
  );
}

function TradingModeBadge({ config }: { config: Record<string, unknown> }) {
  const mode = config?.mode === 'live' ? 'live' : 'paper';
  return (
    <span
      className={
        'inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase ' +
        (mode === 'live'
          ? 'border-red-500/60 bg-red-500/20 text-red-300'
          : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400')
      }
    >
      {mode}
    </span>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-hive-border bg-hive-surface">
      <div className="border-b border-hive-border px-4 py-2 font-semibold">{title}</div>
      <div className="p-3">{children}</div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function ArtifactCard({ artifact }: { artifact: ArtifactSummary }) {
  const base = (process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:4000').replace(/\/$/, '');
  // Artifact GET is cookie-auth'd by the API, but <img>/<a> on the same origin
  // automatically include the cookie thanks to credentials:include CORS config.
  const href = `${base}/api/artifacts/${artifact.id}`;
  const isImage = artifact.contentType?.startsWith('image/');
  return (
    <div className="rounded-lg border border-hive-border bg-hive-surface">
      <div className="border-b border-hive-border px-3 py-2">
        <div className="truncate font-mono text-xs">{artifact.filename}</div>
        <div className="mt-0.5 flex justify-between text-[10px] text-hive-subtle">
          <span>{artifact.contentType}</span>
          <span>{formatBytes(artifact.sizeBytes)}</span>
        </div>
      </div>
      <div className="p-2">
        {isImage ? (
          <a href={href} target="_blank" rel="noreferrer">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={href}
              alt={artifact.filename}
              className="max-h-48 w-full rounded border border-hive-border object-contain bg-black/40"
            />
          </a>
        ) : (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="inline-block rounded border border-honey-500/30 px-3 py-1 text-xs text-honey-500 hover:bg-honey-500/10"
          >
            Download
          </a>
        )}
      </div>
    </div>
  );
}
