'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { PoolBadge } from '@/components/PoolBadge';
import { RunBotDialog } from '@/components/RunBotDialog';
import { CreateBotDialog } from '@/components/CreateBotDialog';
import type { Bot } from '@/lib/types';

export default function BotsPage() {
  const qc = useQueryClient();
  const bots = useQuery<Bot[]>({
    queryKey: ['bots'],
    queryFn: () => api.get<Bot[]>('/api/bots'),
    refetchInterval: 10_000,
  });
  const [runTarget, setRunTarget] = useState<Bot | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  async function toggle(bot: Bot) {
    await api.patch(`/api/bots/${bot.id}`, { enabled: !bot.enabled });
    await qc.invalidateQueries({ queryKey: ['bots'] });
  }
  async function remove(bot: Bot) {
    if (!confirm(`Delete bot "${bot.name}"? This also removes its jobs.`)) return;
    try {
      await api.delete(`/api/bots/${bot.id}`);
      await qc.invalidateQueries({ queryKey: ['bots'] });
    } catch (e) {
      alert((e as Error).message);
    }
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold">Bots</h1>
          <p className="font-mono text-xs text-hive-subtle">Instantiated templates · ready to run</p>
        </div>
        <button
          onClick={() => setCreateOpen(true)}
          className="rounded bg-honey-500 px-3 py-1.5 text-sm font-semibold text-black hover:bg-honey-400"
        >
          + New bot
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {bots.data?.map((bot) => (
          <div
            key={bot.id}
            className="relative overflow-hidden rounded-lg border border-hive-border bg-hive-surface p-4 transition-colors hover:border-honey-500/30"
          >
            <div className="absolute -right-4 -top-4 text-6xl opacity-5">⬡</div>
            <div className="relative space-y-3">
              <div className="flex items-start justify-between gap-2">
                <Link href={`/bots/${bot.id}`} className="font-semibold hover:text-honey-500">{bot.name}</Link>
                {bot.template && <PoolBadge pool={bot.template.poolType} />}
              </div>
              <div className="font-mono text-xs text-hive-subtle">
                {bot.template?.name ?? 'template missing'}
              </div>
              <div className="flex items-center gap-2 text-xs">
                <button
                  onClick={() => setRunTarget(bot)}
                  disabled={!bot.enabled}
                  className="rounded bg-honey-500 px-3 py-1 font-semibold text-black hover:bg-honey-400 disabled:opacity-50"
                >Run</button>
                <button
                  onClick={() => toggle(bot)}
                  className="rounded border border-hive-border px-3 py-1 hover:bg-hive-muted"
                >{bot.enabled ? 'Disable' : 'Enable'}</button>
                <button
                  onClick={() => remove(bot)}
                  className="ml-auto rounded border border-red-500/30 px-3 py-1 text-red-400 hover:bg-red-500/10"
                >Delete</button>
              </div>
            </div>
          </div>
        ))}
        {bots.data && bots.data.length === 0 && (
          <div className="col-span-full rounded-lg border border-dashed border-hive-border p-8 text-center font-mono text-sm text-hive-subtle">
            No bots yet. Click "+ New bot" to create one from a template.
          </div>
        )}
      </div>

      {runTarget && <RunBotDialog bot={runTarget} onClose={() => setRunTarget(null)} />}
      {createOpen && <CreateBotDialog onClose={() => setCreateOpen(false)} />}
    </div>
  );
}
