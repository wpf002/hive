'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useMe } from '@/lib/useMe';
import { PoolBadge } from '@/components/PoolBadge';
import { StatusBadge } from '@/components/StatusBadge';
import { RunBotDialog } from '@/components/RunBotDialog';
import { SchemaForm, pruneUndefined } from '@/components/SchemaForm';
import { fmtRelative } from '@/lib/format';
import type { Bot, Job } from '@/lib/types';

type EditMode = 'form' | 'json';

export default function BotDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const { isAdmin } = useMe();
  const bot = useQuery<Bot>({
    queryKey: ['bot', id],
    queryFn: () => api.get<Bot>(`/api/bots/${id}`),
    refetchInterval: 8_000,
  });
  const [name, setName] = useState('');
  const [configValue, setConfigValue] = useState<Record<string, unknown>>({});
  const [configJson, setConfigJson] = useState('');
  const [editMode, setEditMode] = useState<EditMode>('form');
  const [runOpen, setRunOpen] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  useEffect(() => {
    if (bot.data) {
      setName(bot.data.name);
      const cfg = (bot.data.config ?? {}) as Record<string, unknown>;
      setConfigValue(cfg);
      setConfigJson(JSON.stringify(cfg, null, 2));
    }
  }, [bot.data]);

  // Keep JSON view synced while editing in form mode.
  useEffect(() => {
    if (editMode === 'form') setConfigJson(JSON.stringify(pruneUndefined(configValue), null, 2));
  }, [configValue, editMode]);

  async function save() {
    setSaveErr(null);
    let config: Record<string, unknown>;
    if (editMode === 'json') {
      try { config = JSON.parse(configJson); }
      catch (e) { return setSaveErr(`Invalid JSON: ${(e as Error).message}`); }
    } else {
      config = (pruneUndefined(configValue) ?? {}) as Record<string, unknown>;
    }
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
    return <div className="p-6 font-mono text-sm text-hive-subtle">{bot.isLoading ? 'Loading…' : 'Bot not found'}</div>;
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <Link href="/bots" className="font-mono text-xs text-hive-subtle hover:text-honey-500">← Bots</Link>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold">{bot.data.name}</h1>
            {bot.data.template && <PoolBadge pool={bot.data.template.poolType} />}
          </div>
          <div className="font-mono text-xs text-hive-subtle">{bot.data.template?.name}</div>
        </div>
        {isAdmin && (
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
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {isAdmin && (
        <div className="space-y-3 rounded-lg border border-hive-border bg-hive-surface p-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Edit</h2>
            <div className="flex items-center gap-1 rounded border border-hive-border p-0.5 text-[11px] font-mono uppercase">
              <button
                type="button"
                onClick={() => {
                  setEditMode('form');
                  try { setConfigValue(JSON.parse(configJson)); } catch { /* keep last */ }
                }}
                className={
                  'px-2 py-0.5 rounded ' +
                  (editMode === 'form' ? 'bg-honey-500/20 text-honey-500' : 'text-hive-subtle hover:text-hive-text')
                }
              >Form</button>
              <button
                type="button"
                onClick={() => {
                  setEditMode('json');
                  setConfigJson(JSON.stringify(pruneUndefined(configValue), null, 2));
                }}
                className={
                  'px-2 py-0.5 rounded ' +
                  (editMode === 'json' ? 'bg-honey-500/20 text-honey-500' : 'text-hive-subtle hover:text-hive-text')
                }
              >JSON</button>
            </div>
          </div>
          <label className="block">
            <span className="font-mono text-[11px] uppercase text-hive-subtle">Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded border border-hive-border bg-hive-bg px-2 py-1.5 text-sm focus:border-honey-500 focus:outline-none" />
          </label>
          <div>
            <div className="mb-1 font-mono text-[11px] uppercase text-hive-subtle">Config</div>
            {editMode === 'form' && bot.data.template ? (
              <div className="rounded border border-hive-border bg-hive-bg/30 p-3">
                <SchemaForm
                  schema={bot.data.template.configSchema}
                  value={configValue}
                  onChange={setConfigValue}
                />
              </div>
            ) : (
              <textarea
                value={configJson}
                onChange={(e) => setConfigJson(e.target.value)}
                rows={10}
                spellCheck={false}
                aria-label="Bot config JSON"
                title="Bot config (JSON)"
                className="w-full rounded border border-hive-border bg-black/40 px-2 py-1.5 font-mono text-xs"
              />
            )}
          </div>
          {saveErr && <div className="font-mono text-xs text-red-400">{saveErr}</div>}
          <button
            onClick={save}
            className="rounded bg-honey-500 px-3 py-1.5 text-sm font-semibold text-black hover:bg-honey-400"
          >Save</button>
        </div>
        )}

        <div className="rounded-lg border border-hive-border bg-hive-surface">
          <div className="border-b border-hive-border px-4 py-3 font-semibold">Run History (last 10)</div>
          <div className="overflow-x-auto"><table className="w-full min-w-[680px] text-sm">
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
                <tr><td colSpan={2} className="px-4 py-4 text-center font-mono text-xs text-hive-subtle">No runs yet</td></tr>
              )}
            </tbody>
          </table></div>
        </div>
      </div>

      {runOpen && <RunBotDialog bot={bot.data} onClose={() => setRunOpen(false)} />}
    </div>
  );
}
