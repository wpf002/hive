'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { fmtRelative, fmtDateTime } from '@/lib/format';
import { PoolBadge } from '@/components/PoolBadge';
import { CreateScheduleDialog } from '@/components/CreateScheduleDialog';
import type { Schedule } from '@/lib/types';

export default function SchedulesPage() {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const schedules = useQuery<Schedule[]>({
    queryKey: ['schedules'],
    queryFn: () => api.get<Schedule[]>('/api/schedules'),
    refetchInterval: 10_000,
  });

  async function toggle(s: Schedule) {
    await api.patch(`/api/schedules/${s.id}`, { enabled: !s.enabled });
    await qc.invalidateQueries({ queryKey: ['schedules'] });
  }
  async function remove(s: Schedule) {
    if (!confirm(`Delete schedule for "${s.bot?.name ?? s.botId}"?`)) return;
    await api.delete(`/api/schedules/${s.id}`);
    await qc.invalidateQueries({ queryKey: ['schedules'] });
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-end justify-between gap-3">
        <div className="flex-1 rounded-lg border border-hive-border bg-hive-surface px-4 py-3">
          <h1 className="text-2xl font-bold">Schedules</h1>
          <p className="mt-1 font-mono text-xs text-hive-subtle">CRON-DRIVEN BOT RUNS</p>
        </div>
        <button
          onClick={() => setCreateOpen(true)}
          className="shrink-0 rounded bg-honey-500 px-3 py-1.5 text-sm font-semibold text-black hover:bg-honey-400"
        >
          + New Schedule
        </button>
      </div>

      <div className="rounded-lg border border-hive-border bg-hive-surface">
        <table className="w-full text-sm">
          <thead className="text-left font-mono text-[10px] uppercase text-hive-subtle">
            <tr>
              <th className="px-4 py-2">Bot</th>
              <th className="px-4 py-2">Template</th>
              <th className="px-4 py-2">Cron</th>
              <th className="px-4 py-2">Next run</th>
              <th className="px-4 py-2">Last run</th>
              <th className="px-4 py-2">Enabled</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {schedules.data?.map((s) => (
              <tr key={s.id} className="border-t border-hive-border hover:bg-hive-muted/30">
                <td className="px-4 py-2">{s.bot?.name ?? s.botId.slice(0, 8)}</td>
                <td className="px-4 py-2">
                  {s.bot?.template && <PoolBadge pool={s.bot.template.poolType} />}
                  <span className="ml-2 font-mono text-xs text-hive-subtle">{s.bot?.template?.name}</span>
                </td>
                <td className="px-4 py-2 font-mono text-xs">{s.cron}</td>
                <td className="px-4 py-2 font-mono text-xs text-hive-subtle">
                  {s.nextRunAt ? fmtDateTime(s.nextRunAt) : '—'}
                </td>
                <td className="px-4 py-2 font-mono text-xs text-hive-subtle">
                  {s.lastRunAt ? fmtRelative(s.lastRunAt) : '—'}
                </td>
                <td className="px-4 py-2">
                  <button
                    onClick={() => toggle(s)}
                    className={`rounded border px-2 py-0.5 font-mono text-[10px] uppercase ${
                      s.enabled
                        ? 'border-emerald-500/30 text-emerald-400'
                        : 'border-zinc-500/30 text-zinc-400'
                    }`}
                  >
                    {s.enabled ? 'on' : 'off'}
                  </button>
                </td>
                <td className="px-4 py-2 text-right">
                  <button
                    onClick={() => remove(s)}
                    className="rounded border border-red-500/30 px-2 py-0.5 text-xs text-red-400 hover:bg-red-500/10"
                  >
                    delete
                  </button>
                </td>
              </tr>
            ))}
            {schedules.data && schedules.data.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-6 text-center font-mono text-xs text-hive-subtle">No schedules. Click &ldquo;+ New Schedule&rdquo; to add one.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {createOpen && <CreateScheduleDialog onClose={() => setCreateOpen(false)} />}
    </div>
  );
}
