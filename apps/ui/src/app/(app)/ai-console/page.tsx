'use client';
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useMe } from '@/lib/useMe';
import { PromptEditor } from '@/components/PromptEditor';
import { LiveLogStream } from '@/components/LiveLogStream';
import { StreamingResponse } from '@/components/StreamingResponse';
import { StatusBadge } from '@/components/StatusBadge';
import { cn } from '@/lib/cn';
import { fmtRelative } from '@/lib/format';
import type { Bot, BotTemplate, Job } from '@/lib/types';

type Provider = 'claude' | 'gpt' | 'perplexity';
type VerdictMode = 'consensus' | 'best' | 'all';

const PROVIDERS: Provider[] = ['claude', 'gpt', 'perplexity'];
const DEFAULT_MODELS: Record<Provider, string> = {
  claude: 'claude-sonnet-4-5',
  gpt: 'gpt-4o',
  perplexity: 'sonar-pro',
};

const SINGLE_NAME = 'AI Single Call';
const MULTI_NAME = 'AI Multi-Provider Verdict';

interface MultiSlot {
  provider: Provider;
  model: string;
  response?: string;
  latencyMs?: number;
  costCents?: number;
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
}
interface MultiResult {
  providers: MultiSlot[];
  verdict?: string | null;
  agreement?: string | null;
  disagreement?: string | null;
  confidence?: number | null;
  totalCostCents: number;
  synthesisModel?: string;
  synthesisError?: string;
}
interface SingleResult {
  provider: Provider;
  model: string;
  response: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  costCents: number;
}

function fmtCents(c: number): string {
  return `$${(c / 100).toFixed(2)}`;
}

export default function AiConsolePage() {
  const qc = useQueryClient();
  const { isAdmin } = useMe();
  const templates = useQuery<BotTemplate[]>({
    queryKey: ['templates'],
    queryFn: () => api.get<BotTemplate[]>('/api/templates'),
  });

  const [systemPrompt, setSystemPrompt] = useState('');
  const [systemOpen, setSystemOpen] = useState(false);
  const [userPrompt, setUserPrompt] = useState('What is the capital of France?');
  const [selected, setSelected] = useState<Set<Provider>>(new Set(['claude']));
  const [models, setModels] = useState<Record<Provider, string>>(DEFAULT_MODELS);
  // Locked defaults — exposing these as user-facing knobs added clutter without
  // value for the ad-hoc prompt use case the AI Console serves. If a power user
  // ever needs to tune them, build a dedicated bot in the Bots page where the
  // full template schema is editable.
  const TEMPERATURE = 0.7;
  const MAX_TOKENS = 1024;
  const STREAM_SINGLE = true;
  const [verdictMode, setVerdictMode] = useState<VerdictMode>('consensus');
  const [jobId, setJobId] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const isMulti = selected.size >= 2;

  function toggleProvider(p: Provider) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(p)) {
        if (next.size > 1) next.delete(p);
      } else {
        next.add(p);
      }
      return next;
    });
  }

  const recent = useQuery<Job[]>({
    queryKey: ['ai', 'recent'],
    queryFn: () => api.get<Job[]>('/api/ai/jobs/recent'),
    refetchInterval: 8_000,
  });
  const usage = useQuery<{ totalCostCents: number; calls: number; byProvider: Record<string, { calls: number; costCents: number }> }>({
    queryKey: ['ai', 'usage', 'today'],
    queryFn: () => api.get('/api/ai/usage/today'),
    refetchInterval: 30_000,
  });

  const job = useQuery<Job>({
    queryKey: ['job', jobId],
    queryFn: () => api.get<Job>(`/api/jobs/${jobId}`),
    enabled: !!jobId,
    refetchInterval: (q) => {
      const status = (q.state.data as Job | undefined)?.status;
      return status && (status === 'succeeded' || status === 'failed' || status === 'cancelled') ? false : 2000;
    },
  });

  async function run() {
    setRunError(null);
    const singleTemplate = templates.data?.find((t) => t.name === SINGLE_NAME);
    const multiTemplate = templates.data?.find((t) => t.name === MULTI_NAME);
    const template = isMulti ? multiTemplate : singleTemplate;
    if (!template) {
      setRunError('Templates not loaded — try refreshing.');
      return;
    }
    if (!userPrompt.trim()) {
      setRunError('User prompt is required.');
      return;
    }

    const providers = Array.from(selected);
    const config = isMulti
      ? {
          providers,
          systemPrompt: systemPrompt || undefined,
          userPrompt,
          maxTokens: MAX_TOKENS,
          temperature: TEMPERATURE,
          verdictMode,
        }
      : {
          provider: providers[0],
          model: models[providers[0]],
          systemPrompt: systemPrompt || undefined,
          userPrompt,
          maxTokens: MAX_TOKENS,
          temperature: TEMPERATURE,
          stream: STREAM_SINGLE,
        };

    // Reuse one stable AI Console bot per template instead of creating a new
    // bot per click. Run-time settings are passed as overrideConfig (the API
    // merges them over the bot's stored config on /api/bots/:id/run).
    const stableName = isMulti ? 'AI Console (Multi)' : 'AI Console (Single)';

    setRunning(true);
    try {
      const allBots = await api.get<Bot[]>('/api/bots');
      let bot = allBots.find((b) => b.name === stableName);
      if (!bot) {
        bot = await api.post<Bot>('/api/bots', {
          templateId: template.id,
          name: stableName,
          config: {},
        });
        await qc.invalidateQueries({ queryKey: ['bots'] });
      }
      const created = await api.post<Job>(`/api/bots/${bot.id}/run`, { overrideConfig: config });
      setJobId(created.id);
      await qc.invalidateQueries({ queryKey: ['ai', 'recent'] });
    } catch (e) {
      setRunError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  function loadFromJob(j: Job) {
    const cfg = (j.bot?.config ?? {}) as Record<string, unknown>;
    if (typeof cfg.userPrompt === 'string') setUserPrompt(cfg.userPrompt);
    if (typeof cfg.systemPrompt === 'string') {
      setSystemPrompt(cfg.systemPrompt);
      setSystemOpen(true);
    }
    // temperature / maxTokens / stream are intentionally not restored —
    // the AI Console no longer exposes them, so silently dropping is fine.
    if (typeof cfg.provider === 'string') setSelected(new Set([cfg.provider as Provider]));
    if (Array.isArray(cfg.providers)) setSelected(new Set(cfg.providers as Provider[]));
    if (typeof cfg.verdictMode === 'string') setVerdictMode(cfg.verdictMode as VerdictMode);
    setJobId(j.id);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-hive-border bg-hive-surface px-6 py-3">
        <div>
          <h1 className="text-2xl font-bold">AI Console</h1>
          <p className="font-mono text-xs text-hive-subtle">PROMPT · STREAM · COMPARE PROVIDERS</p>
        </div>
        <CostMeter
          totalCostCents={usage.data?.totalCostCents ?? 0}
          calls={usage.data?.calls ?? 0}
        />
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-12 gap-4 p-6">
        {/* Composer */}
        <div className="lg:col-span-5 flex min-h-0 flex-col gap-3 rounded-lg border border-hive-border bg-hive-surface p-4">
          <div>
            <button
              onClick={() => setSystemOpen((o) => !o)}
              className="font-mono text-[11px] uppercase text-hive-subtle hover:text-honey-500"
            >
              {systemOpen ? '▼' : '▶'} System prompt
            </button>
            {systemOpen && (
              <div className="mt-1">
                <PromptEditor value={systemPrompt} onChange={setSystemPrompt} height={120} />
              </div>
            )}
          </div>

          <div className="flex flex-col">
            <div className="mb-1 font-mono text-[11px] uppercase text-hive-subtle">User prompt</div>
            <PromptEditor value={userPrompt} onChange={setUserPrompt} height={220} />
          </div>

          <div>
            <div className="mb-1 font-mono text-[11px] uppercase text-hive-subtle">
              Providers ({selected.size === 1 ? 'single-call' : `multi · ${verdictMode}`})
            </div>
            <div className="flex flex-wrap gap-2">
              {PROVIDERS.map((p) => {
                const on = selected.has(p);
                return (
                  <button
                    key={p}
                    onClick={() => toggleProvider(p)}
                    className={cn(
                      'rounded border px-2 py-1 font-mono text-[11px] uppercase',
                      on
                        ? 'border-honey-500 bg-honey-500/10 text-honey-500'
                        : 'border-hive-border text-hive-subtle hover:bg-hive-muted',
                    )}
                  >
                    {p}
                  </button>
                );
              })}
            </div>
          </div>

          {!isMulti && (
            <label className="block">
              <span className="font-mono text-[11px] uppercase text-hive-subtle">
                Model · {Array.from(selected)[0]}
              </span>
              <input
                value={models[Array.from(selected)[0]] ?? ''}
                onChange={(e) => {
                  const p = Array.from(selected)[0];
                  setModels((m) => ({ ...m, [p]: e.target.value }));
                }}
                className="mt-1 w-full rounded border border-hive-border bg-hive-bg px-2 py-1 font-mono text-xs"
              />
            </label>
          )}

          {isMulti && (
            <div>
              <div className="mb-1 font-mono text-[11px] uppercase text-hive-subtle">Verdict mode</div>
              <div className="flex gap-2">
                {(['consensus', 'best', 'all'] as VerdictMode[]).map((m) => (
                  <button
                    key={m}
                    onClick={() => setVerdictMode(m)}
                    className={cn(
                      'rounded border px-2 py-1 font-mono text-[11px] uppercase',
                      verdictMode === m
                        ? 'border-honey-500 bg-honey-500/10 text-honey-500'
                        : 'border-hive-border text-hive-subtle hover:bg-hive-muted',
                    )}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Temperature, Max tokens, and Stream are hardcoded to sensible defaults
              (0.7 / 1024 / always-on for single-call). Most users don't need to tune
              these for ad-hoc questions, and the controls were just noise. */}

          {runError && <div className="font-mono text-xs text-red-400">{runError}</div>}
          {!isAdmin && (
            <div className="font-mono text-xs text-hive-subtle">
              Running prompts dispatches a job to a worker — this is restricted to admins.
            </div>
          )}

          <button
            onClick={run}
            disabled={running || !isAdmin}
            title={!isAdmin ? 'Admin role required to run jobs' : undefined}
            className="rounded bg-honey-500 px-4 py-2 text-sm font-semibold text-black hover:bg-honey-400 disabled:opacity-60"
          >
            {running ? 'Starting…' : isMulti ? `Run · ${selected.size} providers` : 'Run'}
          </button>
        </div>

        {/* Results */}
        <div className="lg:col-span-5 min-h-0 rounded-lg border border-hive-border bg-hive-surface p-4">
          {!jobId ? (
            <div className="flex h-full items-center justify-center rounded border border-dashed border-hive-border p-6 text-center font-mono text-sm text-hive-subtle">
              Run a prompt to see streaming logs and the rendered response here.
            </div>
          ) : (
            <ResultPane jobId={jobId} job={job.data ?? null} isMulti={isMulti} />
          )}
        </div>

        {/* Recent runs */}
        <div className="lg:col-span-2 min-h-0 space-y-2 overflow-auto rounded-lg border border-hive-border bg-hive-surface p-3">
          <div className="font-mono text-[11px] uppercase text-hive-subtle">Recent runs</div>
          <div className="space-y-1">
            {recent.data?.map((r) => (
              <button
                key={r.id}
                onClick={() => loadFromJob(r)}
                className={cn(
                  'block w-full rounded border border-hive-border p-2 text-left text-xs hover:border-honey-500/50',
                  jobId === r.id && 'border-honey-500/50 bg-honey-500/5',
                )}
              >
                <div className="flex items-center justify-between">
                  <StatusBadge status={r.status} />
                  <span className="font-mono text-[10px] text-hive-subtle">{fmtRelative(r.createdAt)}</span>
                </div>
                <div className="mt-1 truncate text-hive-text">
                  {(r.bot?.config as Record<string, unknown> | undefined)?.userPrompt
                    ? String((r.bot?.config as Record<string, unknown>).userPrompt).slice(0, 60)
                    : r.bot?.name ?? r.id.slice(0, 8)}
                </div>
              </button>
            ))}
            {recent.data && recent.data.length === 0 && (
              <div className="rounded border border-dashed border-hive-border p-3 text-center font-mono text-xs text-hive-subtle">
                No runs yet
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function CostMeter({ totalCostCents, calls }: { totalCostCents: number; calls: number }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 divide-x divide-hive-border overflow-hidden rounded-lg border border-hive-border bg-hive-bg">
      <div className="border-b border-hive-border px-4 py-1.5 text-center font-mono text-[10px] uppercase tracking-wider text-hive-subtle">
        Today
      </div>
      <div className="border-b border-hive-border px-4 py-1.5 text-center font-mono text-[10px] uppercase tracking-wider text-hive-subtle">
        Calls
      </div>
      <div className="px-4 py-2 text-center text-xl font-semibold leading-none text-honey-500">
        {fmtCents(totalCostCents)}
      </div>
      <div className="px-4 py-2 text-center font-mono text-xl leading-none text-hive-text">
        {calls}
      </div>
    </div>
  );
}

function ResultPane({ jobId, job, isMulti }: { jobId: string; job: Job | null; isMulti: boolean }) {
  const done = job && (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled');
  return (
    <div className="flex h-full flex-col gap-3">
      {!isMulti && <StreamingResponse jobId={jobId} />}
      <LiveLogStream jobId={jobId} />
      {done && job.status === 'succeeded' && (
        isMulti
          ? <MultiResultView result={job.result as MultiResult} />
          : <SingleResultView result={job.result as SingleResult} />
      )}
      {done && job.status !== 'succeeded' && (
        <div className="rounded border border-red-500/30 bg-red-500/5 p-3 font-mono text-xs text-red-400">
          {job.status}: {job.error ?? '—'}
        </div>
      )}
    </div>
  );
}

function SingleResultView({ result }: { result: SingleResult | null }) {
  if (!result) return null;
  return (
    <div className="rounded border border-hive-border bg-hive-surface">
      <div className="flex items-center justify-between border-b border-hive-border px-3 py-1.5 font-mono text-[10px] uppercase text-hive-subtle">
        <span>{result.provider} · {result.model}</span>
        <span>{result.inputTokens}↑ {result.outputTokens}↓ · {result.latencyMs}ms · {fmtCents(result.costCents)}</span>
      </div>
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap p-3 text-sm">{result.response}</pre>
    </div>
  );
}

function MultiResultView({ result }: { result: MultiResult | null }) {
  const [tab, setTab] = useState<string>('verdict');
  if (!result) return null;
  const slots = result.providers ?? [];
  const hasVerdict = result.verdict != null;
  return (
    <div className="rounded border border-hive-border bg-hive-surface">
      <div className="flex items-center justify-between border-b border-hive-border px-3 py-1.5">
        <div className="flex gap-1">
          {hasVerdict && (
            <button
              onClick={() => setTab('verdict')}
              className={cn(
                'rounded border px-2 py-0.5 font-mono text-[10px] uppercase',
                tab === 'verdict' ? 'border-honey-500 text-honey-500' : 'border-hive-border text-hive-subtle',
              )}
            >
              Verdict
            </button>
          )}
          {slots.map((s) => (
            <button
              key={s.provider}
              onClick={() => setTab(s.provider)}
              className={cn(
                'rounded border px-2 py-0.5 font-mono text-[10px] uppercase',
                tab === s.provider ? 'border-honey-500 text-honey-500' : 'border-hive-border text-hive-subtle',
                s.error && 'border-red-500/30 text-red-400',
              )}
            >
              {s.provider}
            </button>
          ))}
        </div>
        <span className="font-mono text-[10px] uppercase text-hive-subtle">
          Total · {fmtCents(result.totalCostCents)}
        </span>
      </div>
      <div className="p-3">
        {tab === 'verdict' && hasVerdict && (
          <div className="space-y-2 text-sm">
            <pre className="whitespace-pre-wrap">{result.verdict}</pre>
            {result.agreement && (
              <div className="text-xs">
                <div className="font-mono uppercase text-hive-subtle">Agreement</div>
                <div>{result.agreement}</div>
              </div>
            )}
            {result.disagreement && (
              <div className="text-xs">
                <div className="font-mono uppercase text-hive-subtle">Disagreement</div>
                <div>{result.disagreement}</div>
              </div>
            )}
            {result.confidence != null && (
              <div className="font-mono text-xs text-hive-subtle">
                Confidence · {(result.confidence * 100).toFixed(0)}%
              </div>
            )}
          </div>
        )}
        {tab !== 'verdict' && slots.find((s) => s.provider === tab) && (() => {
          const s = slots.find((x) => x.provider === tab)!;
          return (
            <div className="space-y-2 text-sm">
              <div className="font-mono text-[10px] uppercase text-hive-subtle">
                {s.model}
                {s.latencyMs != null && ` · ${s.latencyMs}ms`}
                {s.costCents != null && ` · ${fmtCents(s.costCents)}`}
              </div>
              {s.error ? (
                <div className="font-mono text-xs text-red-400">{s.error}</div>
              ) : (
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap">{s.response}</pre>
              )}
            </div>
          );
        })()}
      </div>
    </div>
  );
}
