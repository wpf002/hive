'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { PoolBadge } from '@/components/PoolBadge';
import { StatusBadge } from '@/components/StatusBadge';
import { RunBotDialog } from '@/components/RunBotDialog';
import { fmtRelative } from '@/lib/format';
import type { Bot, Job } from '@/lib/types';

export default function BotDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const bot = useQuery<Bot>({
    queryKey: ['bot', id],
    queryFn: () => api.get<Bot>(`/api/bots/${id}`),
    refetchInterval: 8_000,
  });
  const [name, setName] = useState('');
  const [configJson, setConfigJson] = useState('');
  const [runOpen, setRunOpen] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  useEffect(() => {
    if (bot.data) {
      setName(bot.data.name);
      setConfigJson(JSON.stringify(bot.data.config, null, 2));
    }
  }, [bot.data]);

  async function save() {
    setSaveErr(null);
    let config: Record<string, unknown>;
    try { config = JSON.parse(configJson); }
    catch (e) { return setSaveErr(`Invalid JSON: ${(e as Error).message}`); }
    try {
      await api.patch<Bot>(`/api/bots/${id}`, { name, config });
      await qc.invalidateQueries({ queryKey: ['bot', id] });
    } catch (e) {
      setSaveErr((e as Error).message);
    }
  }

  async function remove() {
    if (!confirm(`Delete bot "${bot.data?.name}"?`)) return;
    await api.delete(`/api/bots/${id}`);
    router.push('/bots');
  }

  if (!bot.data) {
    return <div className="p-6 font-mono text-sm text-hive-subtle">{bot.isLoading ? 'loading…' : 'bot not found'}</div>;
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <Link href="/bots" className="font-mono text-xs text-hive-subtle hover:text-honey-500">← bots</Link>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold">{bot.data.name}</h1>
            {bot.data.template && <PoolBadge pool={bot.data.template.poolType} />}
          </div>
          <div className="font-mono text-xs text-hive-subtle">{bot.data.template?.name}</div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setRunOpen(true)}
            className="rounded bg-honey-500 px-3 py-1.5 text-sm font-semibold text-black hover:bg-honey-400"
          >Run</button>
          <button
            onClick={remove}
            className="rounded border border-red-500/30 px-3 py-1.5 text-sm text-red-400 hover:bg-red-500/10"
          >Delete</button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="space-y-3 rounded-lg border border-hive-border bg-hive-surface p-4">
          <h2 className="font-semibold">Edit</h2>
          <label className="block">
            <span className="font-mono text-[11px] uppercase text-hive-subtle">Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded border border-hive-border bg-hive-bg px-2 py-1.5 text-sm" />
          </label>
          <label className="block">
            <span className="font-mono text-[11px] uppercase text-hive-subtle">Config (JSON)</span>
            <textarea
              value={configJson}
              onChange={(e) => setConfigJson(e.target.value)}
              rows={10}
              className="mt-1 w-full rounded border border-hive-border bg-black/40 px-2 py-1.5 font-mono text-xs"
            />
          </label>
          {saveErr && <div className="font-mono text-xs text-red-400">{saveErr}</div>}
          <button
            onClick={save}
            className="rounded bg-honey-500 px-3 py-1.5 text-sm font-semibold text-black hover:bg-honey-400"
          >Save</button>
        </div>

        <div className="rounded-lg border border-hive-border bg-hive-surface">
          <div className="border-b border-hive-border px-4 py-3 font-semibold">Run history (last 10)</div>
          <table className="w-full text-sm">
            <thead className="text-left font-mono text-[10px] uppercase text-hive-subtle">
              <tr>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Created</th>
              </tr>
            </thead>
            <tbody>
              {bot.data.jobs?.map((j: Job) => (
                <tr key={j.id} className="border-t border-hive-border hover:bg-hive-muted/30">
                  <td className="px-4 py-2">
                    <Link href={`/jobs/${j.id}`}><StatusBadge status={j.status} /></Link>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-hive-subtle">{fmtRelative(j.createdAt)}</td>
                </tr>
              ))}
              {bot.data.jobs && bot.data.jobs.length === 0 && (
                <tr><td colSpan={2} className="px-4 py-4 text-center font-mono text-xs text-hive-subtle">no runs yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {runOpen && <RunBotDialog bot={bot.data} onClose={() => setRunOpen(false)} />}
    </div>
  );
}
