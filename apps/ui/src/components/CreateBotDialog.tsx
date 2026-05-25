'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { SchemaForm, pruneUndefined } from './SchemaForm';
import type { Bot, BotTemplate } from '@/lib/types';

type Mode = 'form' | 'json';

export function CreateBotDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const templates = useQuery<BotTemplate[]>({
    queryKey: ['templates'],
    queryFn: () => api.get<BotTemplate[]>('/api/templates'),
  });
  const [templateId, setTemplateId] = useState<string>('');
  const [name, setName] = useState('');
  const [configValue, setConfigValue] = useState<Record<string, unknown>>({});
  const [configJson, setConfigJson] = useState('{}');
  const [mode, setMode] = useState<Mode>('form');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const selected = useMemo(
    () => templates.data?.find((t) => t.id === templateId),
    [templates.data, templateId],
  );

  // Pre-select first template on first render.
  useEffect(() => {
    if (templates.data && !templateId && templates.data[0]) {
      setTemplateId(templates.data[0].id);
    }
  }, [templates.data, templateId]);

  // When template changes, reset config to its defaultConfig.
  useEffect(() => {
    if (selected) {
      const dc = (selected.defaultConfig ?? {}) as Record<string, unknown>;
      setConfigValue(dc);
      setConfigJson(JSON.stringify(dc, null, 2));
    }
  }, [selected]);

  // Keep JSON view in sync when the user edits via the form.
  useEffect(() => {
    if (mode === 'form') setConfigJson(JSON.stringify(pruneUndefined(configValue), null, 2));
  }, [configValue, mode]);

  async function submit() {
    setError(null);
    if (!templateId) return setError('Pick a template');
    if (!name.trim()) return setError('Name is required');
    let config: Record<string, unknown>;
    if (mode === 'json') {
      try { config = JSON.parse(configJson); }
      catch (e) { return setError(`Invalid JSON: ${(e as Error).message}`); }
    } else {
      config = (pruneUndefined(configValue) ?? {}) as Record<string, unknown>;
    }
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
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="flex w-full max-w-2xl max-h-[90vh] flex-col gap-3 rounded-lg border border-hive-border bg-hive-surface p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">New Bot</h2>
          <div className="flex items-center gap-1 rounded border border-hive-border p-0.5 text-[11px] font-mono uppercase">
            <button
              type="button"
              onClick={() => {
                setMode('form');
                // When switching back to form, parse current JSON into the form state.
                try { setConfigValue(JSON.parse(configJson)); } catch { /* keep last */ }
              }}
              className={
                'px-2 py-0.5 rounded ' +
                (mode === 'form' ? 'bg-honey-500/20 text-honey-500' : 'text-hive-subtle hover:text-hive-text')
              }
            >
              Form
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('json');
                setConfigJson(JSON.stringify(pruneUndefined(configValue), null, 2));
              }}
              className={
                'px-2 py-0.5 rounded ' +
                (mode === 'json' ? 'bg-honey-500/20 text-honey-500' : 'text-hive-subtle hover:text-hive-text')
              }
            >
              JSON
            </button>
          </div>
        </div>

        <label className="block">
          <span className="font-mono text-[11px] uppercase text-hive-subtle">Template</span>
          <select
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value)}
            className="mt-1 w-full rounded border border-hive-border bg-hive-bg px-2 py-1.5 text-sm focus:border-honey-500 focus:outline-none"
          >
            {templates.data?.map((t) => (
              <option key={t.id} value={t.id}>{t.name} ({t.poolType})</option>
            ))}
          </select>
          {selected?.description && (
            <div className="mt-1 text-[11px] leading-snug text-hive-subtle/80">{selected.description}</div>
          )}
        </label>

        <label className="block">
          <span className="font-mono text-[11px] uppercase text-hive-subtle">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={selected ? `${selected.name} #1` : 'My bot'}
            className="mt-1 w-full rounded border border-hive-border bg-hive-bg px-2 py-1.5 text-sm focus:border-honey-500 focus:outline-none"
          />
        </label>

        <div className="min-h-0 flex-1 overflow-auto rounded border border-hive-border bg-hive-bg/30 p-3">
          <div className="mb-2 font-mono text-[11px] uppercase text-hive-subtle">
            Config
          </div>
          {mode === 'form' ? (
            selected ? (
              <SchemaForm
                schema={selected.configSchema}
                value={configValue}
                onChange={setConfigValue}
              />
            ) : (
              <div className="text-xs text-hive-subtle">Pick a template first.</div>
            )
          ) : (
            <textarea
              value={configJson}
              onChange={(e) => setConfigJson(e.target.value)}
              rows={12}
              spellCheck={false}
              aria-label="Bot config JSON"
              title="Bot config (JSON)"
              className="w-full rounded border border-hive-border bg-black/40 px-2 py-1.5 font-mono text-xs"
            />
          )}
        </div>

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
