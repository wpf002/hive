'use client';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Wand2, Sparkles } from 'lucide-react';
import { api } from '@/lib/api';
import { useMe } from '@/lib/useMe';
import { PoolBadge } from '@/components/PoolBadge';
import { SchemaForm, pruneUndefined } from '@/components/SchemaForm';
import type { Bot, BotTemplate } from '@/lib/types';

interface Suggestion {
  templateId: string;
  templateName: string;
  poolType: BotTemplate['poolType'];
  botName: string;
  config: Record<string, unknown>;
  rationale: string;
  warnings: string[];
}

const EXAMPLES = [
  'Scrape tonight’s NBA scores from ESPN every morning',
  'Ping my website every 5 minutes and alert me if it goes down',
  'Ask Claude to summarize a block of text I give it',
  'Take a full-page screenshot of a URL',
];

export default function BotBuilderPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const { isAdmin, loading } = useMe();

  // Templates are needed to render the editable config form (the suggest
  // endpoint returns a templateId; we look up its configSchema here). Cached
  // under the same key the create dialog uses.
  const templates = useQuery<BotTemplate[]>({
    queryKey: ['templates'],
    queryFn: () => api.get<BotTemplate[]>('/api/templates'),
  });

  const [description, setDescription] = useState('');
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [botName, setBotName] = useState('');
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [creating, setCreating] = useState(false);

  const selectedTemplate = useMemo(
    () => templates.data?.find((t) => t.id === suggestion?.templateId),
    [templates.data, suggestion],
  );

  async function generate() {
    setError(null);
    if (description.trim().length < 3) return setError('Describe what you want the bot to do.');
    setGenerating(true);
    try {
      const s = await api.post<Suggestion>('/api/bot-builder/suggest', {
        description: description.trim(),
      });
      setSuggestion(s);
      setBotName(s.botName);
      setConfig(s.config ?? {});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGenerating(false);
    }
  }

  async function create() {
    if (!suggestion) return;
    setError(null);
    if (!botName.trim()) return setError('Give the bot a name.');
    setCreating(true);
    try {
      const cfg = (pruneUndefined(config) ?? {}) as Record<string, unknown>;
      const bot = await api.post<Bot>('/api/bots', {
        templateId: suggestion.templateId,
        name: botName.trim(),
        config: cfg,
      });
      await qc.invalidateQueries({ queryKey: ['bots'] });
      router.push(`/bots/${bot.id}`);
    } catch (e) {
      setError((e as Error).message);
      setCreating(false);
    }
  }

  function reset() {
    setSuggestion(null);
    setError(null);
    setBotName('');
    setConfig({});
  }

  if (!loading && !isAdmin) {
    return (
      <div className="p-4 sm:p-6">
        <div className="rounded-lg border border-hive-border bg-hive-surface p-8 text-center font-mono text-sm text-hive-subtle">
          The AI Builder creates and configures bots — available to admins only.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4 sm:space-y-6 sm:p-6">
      <div className="rounded-lg border border-hive-border bg-hive-surface px-4 py-3">
        <h1 className="flex items-center gap-2 text-xl font-bold sm:text-2xl">
          <Wand2 className="h-5 w-5 text-honey-500" /> AI Builder
        </h1>
        <p className="mt-1 font-mono text-xs text-hive-subtle">
          DESCRIBE A BOT IN PLAIN ENGLISH — AI PICKS THE TEMPLATE &amp; FILLS THE CONFIG
        </p>
      </div>

      {/* Prompt */}
      <div className="rounded-lg border border-hive-border bg-hive-surface p-4">
        <label className="block">
          <span className="font-mono text-[11px] uppercase text-hive-subtle">What should the bot do?</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            placeholder="e.g. Every morning, scrape tonight’s NBA games from ESPN and save the results."
            className="mt-1 w-full rounded border border-hive-border bg-hive-bg px-3 py-2 text-sm focus:border-honey-500 focus:outline-none"
          />
        </label>

        <div className="mt-3 flex flex-wrap gap-2">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => setDescription(ex)}
              className="rounded-full border border-hive-border px-3 py-1 text-[11px] text-hive-subtle hover:border-honey-500/40 hover:text-hive-text"
            >
              {ex}
            </button>
          ))}
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={generate}
            disabled={generating}
            className="inline-flex items-center gap-2 rounded bg-honey-500 px-4 py-1.5 text-sm font-semibold text-black hover:bg-honey-400 disabled:opacity-60"
          >
            <Sparkles className="h-4 w-4" />
            {generating ? 'Designing…' : suggestion ? 'Regenerate' : 'Generate bot'}
          </button>
          {suggestion && (
            <button
              onClick={reset}
              className="rounded border border-hive-border px-3 py-1.5 text-sm hover:bg-hive-muted"
            >
              Start over
            </button>
          )}
        </div>

        {error && <div className="mt-3 font-mono text-xs text-red-400">{error}</div>}
      </div>

      {/* Proposal */}
      {suggestion && (
        <div className="space-y-4 rounded-lg border border-honey-500/30 bg-hive-surface p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-mono text-[11px] uppercase text-hive-subtle">Proposed bot</div>
              <div className="mt-0.5 text-lg font-semibold">{suggestion.templateName}</div>
            </div>
            <PoolBadge pool={suggestion.poolType} />
          </div>

          {suggestion.rationale && (
            <p className="rounded border border-hive-border bg-hive-bg/40 p-3 text-sm leading-relaxed text-hive-text/90">
              {suggestion.rationale}
            </p>
          )}

          {suggestion.warnings.length > 0 && (
            <div className="rounded border border-amber-500/30 bg-amber-500/5 p-3">
              <div className="font-mono text-[11px] uppercase text-amber-400">Review these</div>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-amber-300/90">
                {suggestion.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          <label className="block">
            <span className="font-mono text-[11px] uppercase text-hive-subtle">Name</span>
            <input
              value={botName}
              onChange={(e) => setBotName(e.target.value)}
              className="mt-1 w-full rounded border border-hive-border bg-hive-bg px-2 py-1.5 text-sm focus:border-honey-500 focus:outline-none"
            />
          </label>

          <div className="rounded border border-hive-border bg-hive-bg/30 p-3">
            <div className="mb-2 font-mono text-[11px] uppercase text-hive-subtle">Config — edit anything before creating</div>
            {selectedTemplate ? (
              <SchemaForm schema={selectedTemplate.configSchema} value={config} onChange={setConfig} />
            ) : (
              <div className="text-xs text-hive-subtle">Loading template schema…</div>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <button
              onClick={create}
              disabled={creating}
              className="rounded bg-honey-500 px-4 py-1.5 text-sm font-semibold text-black hover:bg-honey-400 disabled:opacity-60"
            >
              {creating ? 'Creating…' : 'Create bot'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
