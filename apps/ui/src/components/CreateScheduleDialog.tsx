'use client';
import { useEffect, useMemo, useState } from 'react';
import cronParser from 'cron-parser';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import type { Bot, Schedule } from '@/lib/types';

const PRESETS: Array<{ label: string; cron: string }> = [
  { label: 'Every 5 min', cron: '*/5 * * * *' },
  { label: 'Hourly',      cron: '0 * * * *' },
  { label: 'Daily 9am',   cron: '0 9 * * *' },
  { label: 'Mon 9am',     cron: '0 9 * * MON' },
];

export function CreateScheduleDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const bots = useQuery<Bot[]>({
    queryKey: ['bots'],
    queryFn: () => api.get<Bot[]>('/api/bots'),
  });
  const [botId, setBotId] = useState('');
  const [cron, setCron] = useState('*/5 * * * *');
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (bots.data && !botId && bots.data[0]) setBotId(bots.data[0].id);
  }, [bots.data, botId]);

  const preview = useMemo<{ ok: true; runs: string[] } | { ok: false; error: string }>(() => {
    try {
      const it = cronParser.parseExpression(cron);
      const runs: string[] = [];
      for (let i = 0; i < 5; i += 1) runs.push(fmtDateTime(it.next().toDate()));
      return { ok: true, runs };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }, [cron]);

  async function submit() {
    setError(null);
    if (!botId) return setError('Pick a bot');
    if (!preview.ok) return setError(`Invalid cron: ${preview.error}`);
    setSubmitting(true);
    try {
      await api.post<Schedule>('/api/schedules', { botId, cron, enabled });
      await qc.invalidateQueries({ queryKey: ['schedules'] });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-lg space-y-3 rounded-lg border border-hive-border bg-hive-surface p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">New Schedule</h2>
        <label className="block">
          <span className="font-mono text-[11px] uppercase text-hive-subtle">Bot</span>
          <select
            value={botId}
            onChange={(e) => setBotId(e.target.value)}
            className="mt-1 w-full rounded border border-hive-border bg-hive-bg px-2 py-1.5 text-sm"
          >
            {bots.data?.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name} ({b.template?.name ?? 'unknown'})
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="font-mono text-[11px] uppercase text-hive-subtle">Cron expression</span>
          <input
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            className="mt-1 w-full rounded border border-hive-border bg-hive-bg px-2 py-1.5 font-mono text-sm"
          />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.cron}
                type="button"
                onClick={() => setCron(p.cron)}
                className="rounded border border-hive-border px-2 py-0.5 font-mono text-[10px] uppercase text-hive-subtle hover:bg-hive-muted hover:text-honey-500"
              >
                {p.label}
              </button>
            ))}
          </div>
        </label>

        <div className="rounded border border-hive-border bg-black/40 p-2 text-xs">
          <div className="mb-1 font-mono text-[10px] uppercase text-hive-subtle">Next 5 runs</div>
          {preview.ok ? (
            <ul className="space-y-0.5 font-mono">
              {preview.runs.map((r, i) => (
                <li key={i} className="text-hive-text">{r}</li>
              ))}
            </ul>
          ) : (
            <div className="font-mono text-red-400">{preview.error}</div>
          )}
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enable immediately
        </label>

        {error && <div className="font-mono text-xs text-red-400">{error}</div>}
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded border border-hive-border px-3 py-1.5 text-sm hover:bg-hive-muted"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={submitting || !preview.ok}
            className="rounded bg-honey-500 px-4 py-1.5 text-sm font-semibold text-black hover:bg-honey-400 disabled:opacity-60"
          >
            {submitting ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
