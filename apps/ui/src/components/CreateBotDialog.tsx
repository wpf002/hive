'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Bot, BotTemplate } from '@/lib/types';

export function CreateBotDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const templates = useQuery<BotTemplate[]>({
    queryKey: ['templates'],
    queryFn: () => api.get<BotTemplate[]>('/api/templates'),
  });
  const [templateId, setTemplateId] = useState<string>('');
  const [name, setName] = useState('');
  const [configJson, setConfigJson] = useState('{}');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const selected = useMemo(
    () => templates.data?.find((t) => t.id === templateId),
    [templates.data, templateId],
  );

  useEffect(() => {
    if (templates.data && !templateId && templates.data[0]) {
      setTemplateId(templates.data[0].id);
    }
  }, [templates.data, templateId]);

  useEffect(() => {
    if (selected) setConfigJson(JSON.stringify(selected.defaultConfig, null, 2));
  }, [selected]);

  async function submit() {
    setError(null);
    if (!templateId) return setError('Pick a template');
    if (!name.trim()) return setError('Name is required');
    let config: Record<string, unknown>;
    try { config = JSON.parse(configJson); }
    catch (e) { return setError(`Invalid JSON: ${(e as Error).message}`); }
    setSubmitting(true);
    try {
      const bot = await api.post<Bot>('/api/bots', { templateId, name: name.trim(), config });
      await qc.invalidateQueries({ queryKey: ['bots'] });
      onClose();
      router.push(`/bots/${bot.id}`);
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
        <h2 className="text-lg font-semibold">New bot</h2>
        <label className="block">
          <span className="font-mono text-[11px] uppercase text-hive-subtle">Template</span>
          <select
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value)}
            className="mt-1 w-full rounded border border-hive-border bg-hive-bg px-2 py-1.5 text-sm"
          >
            {templates.data?.map((t) => (
              <option key={t.id} value={t.id}>{t.name} ({t.poolType})</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="font-mono text-[11px] uppercase text-hive-subtle">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My ESPN bot"
            className="mt-1 w-full rounded border border-hive-border bg-hive-bg px-2 py-1.5 text-sm"
          />
        </label>
        <label className="block">
          <span className="font-mono text-[11px] uppercase text-hive-subtle">Config (JSON)</span>
          <textarea
            value={configJson}
            onChange={(e) => setConfigJson(e.target.value)}
            rows={8}
            className="mt-1 w-full rounded border border-hive-border bg-black/40 px-2 py-1.5 font-mono text-xs"
          />
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
            disabled={submitting}
            className="rounded bg-honey-500 px-4 py-1.5 text-sm font-semibold text-black hover:bg-honey-400 disabled:opacity-60"
          >
            {submitting ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
