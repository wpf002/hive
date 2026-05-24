'use client';
import { useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import type { Bot, Job } from '@/lib/types';

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false });

export function RunBotDialog({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const router = useRouter();
  const [json, setJson] = useState(JSON.stringify(bot.config, null, 2));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(json);
    } catch (e) {
      setError(`Invalid JSON: ${(e as Error).message}`);
      return;
    }
    setSubmitting(true);
    try {
      const job = await api.post<Job>(`/api/bots/${bot.id}/run`, { overrideConfig: parsed });
      onClose();
      router.push(`/jobs/${job.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/60" onClick={onClose}>
      <div
        className="flex h-full w-[640px] max-w-full flex-col border-l border-hive-border bg-hive-surface"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-hive-border px-4 py-3">
          <div className="font-mono text-xs text-hive-subtle">Run Bot</div>
          <div className="text-lg font-semibold">{bot.name}</div>
        </div>
        <div className="grid flex-1 grid-cols-2 gap-3 overflow-hidden p-4">
          <div className="flex min-h-0 flex-col">
            <div className="mb-1 font-mono text-[11px] uppercase text-hive-subtle">Config (editable)</div>
            <div className="flex-1 overflow-hidden rounded border border-hive-border">
              <MonacoEditor
                language="json"
                theme="vs-dark"
                value={json}
                onChange={(v) => setJson(v ?? '')}
                options={{ minimap: { enabled: false }, fontSize: 12 }}
              />
            </div>
          </div>
          <div className="flex min-h-0 flex-col">
            <div className="mb-1 font-mono text-[11px] uppercase text-hive-subtle">Schema (read-only)</div>
            <pre className="flex-1 overflow-auto rounded border border-hive-border bg-black/40 p-2 font-mono text-[11px] text-hive-subtle">
              {JSON.stringify(bot.template?.configSchema ?? {}, null, 2)}
            </pre>
          </div>
        </div>
        {error && <div className="px-4 pb-2 font-mono text-xs text-red-400">{error}</div>}
        <div className="flex justify-end gap-2 border-t border-hive-border px-4 py-3">
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
            {submitting ? 'Starting…' : 'Run'}
          </button>
        </div>
      </div>
    </div>
  );
}
