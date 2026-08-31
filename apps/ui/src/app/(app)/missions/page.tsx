'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useMe } from '@/lib/useMe';
import { fmtRelative } from '@/lib/format';
import type { MissionListItem } from '@/lib/mission-types';

const VERTICALS = [
  { domain: 'trading', objective: 'Flag symbols where independent venues disagree on price.' },
  { domain: 'racing', objective: 'Flag races where the morning line diverges from closing money.' },
  { domain: 'recruiting', objective: 'Surface roles matching the brief that appear on multiple boards.' },
  { domain: 'monitoring', objective: 'Detect outages confirmed by more than one vantage point.' },
];

export default function MissionsPage() {
  const qc = useQueryClient();
  const { isAdmin } = useMe();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', domain: 'trading', objective: VERTICALS[0].objective });

  const missions = useQuery<MissionListItem[]>({
    queryKey: ['missions'],
    queryFn: () => api.get<MissionListItem[]>('/api/missions'),
    refetchInterval: 10_000,
  });

  const create = useMutation({
    mutationFn: () =>
      api.post('/api/missions', {
        name: form.name,
        domain: form.domain,
        objective: form.objective,
        // Read-only until an operator widens it. A mission that can only
        // notify can still be wrong; it can't be expensively wrong.
        allowedActions: ['notify'],
        limits: { 'mission:actions': 40, min_independent_sources: 2 },
      }),
    onSuccess: async () => {
      setCreating(false);
      setForm({ name: '', domain: 'trading', objective: VERTICALS[0].objective });
      await qc.invalidateQueries({ queryKey: ['missions'] });
    },
  });

  return (
    <div className="space-y-4 p-4 sm:space-y-6 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-hive-border bg-hive-surface px-4 py-3">
        <div>
          <h1 className="text-xl font-bold sm:text-2xl">Missions</h1>
          <p className="mt-1 font-mono text-xs text-hive-subtle">
            BOTS BOUND INTO ROLES · ONE GATHERER PER SOURCE · EVERY ACTION GATED
          </p>
        </div>
        <button
          onClick={() => setCreating((v) => !v)}
          className="rounded border border-honey-500 px-3 py-1.5 font-mono text-xs text-honey-500 hover:bg-honey-500 hover:text-hive-bg"
        >
          {creating ? 'Cancel' : 'New mission'}
        </button>
      </div>

      {creating && (
        <div className="space-y-3 rounded-lg border border-hive-border bg-hive-surface p-4">
          <input
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="Mission name"
            className="w-full rounded border border-hive-muted bg-hive-bg px-2 py-1.5 font-mono text-sm text-hive-text placeholder:text-hive-subtle"
          />
          <div className="flex flex-wrap gap-1.5">
            {VERTICALS.map((v) => (
              <button
                key={v.domain}
                onClick={() => setForm((f) => ({ ...f, domain: v.domain, objective: v.objective }))}
                className={cn(
                  'rounded border px-2 py-1 font-mono text-xs',
                  form.domain === v.domain
                    ? 'border-honey-500 text-honey-500'
                    : 'border-hive-muted text-hive-subtle hover:border-hive-subtle',
                )}
              >
                {v.domain}
              </button>
            ))}
          </div>
          <textarea
            value={form.objective}
            onChange={(e) => setForm((f) => ({ ...f, objective: e.target.value }))}
            rows={2}
            placeholder="What should this swarm decide?"
            className="w-full rounded border border-hive-muted bg-hive-bg px-2 py-1.5 font-mono text-sm text-hive-text placeholder:text-hive-subtle"
          />
          <div className="flex items-center gap-3">
            <button
              onClick={() => create.mutate()}
              disabled={!form.name.trim() || create.isPending}
              className="rounded bg-honey-500 px-3 py-1.5 font-mono text-xs font-semibold text-hive-bg disabled:opacity-40"
            >
              Create
            </button>
            <span className="font-mono text-[11px] text-hive-subtle">
              starts in draft, allowed actions: notify only
            </span>
          </div>
          {create.isError && (
            <p className="font-mono text-xs text-red-400">{(create.error as Error).message}</p>
          )}
        </div>
      )}

      {missions.isLoading && (
        <p className="font-mono text-xs text-hive-subtle">Loading missions…</p>
      )}

      {missions.data?.length === 0 && (
        <div className="rounded-lg border border-dashed border-hive-border p-6 text-center">
          <p className="font-mono text-sm text-hive-subtle">No missions yet.</p>
          <p className="mt-1 font-mono text-xs text-hive-subtle">
            A mission binds existing bots into roles — gatherers foraging one source each,
            analysts building claims, adversaries attacking them.
          </p>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {(missions.data ?? []).map((m) => (
          <Link
            key={m.id}
            href={`/missions/${m.id}`}
            className="group rounded-lg border border-hive-border bg-hive-surface p-4 transition hover:border-honey-500"
          >
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="truncate font-semibold text-hive-text group-hover:text-honey-500">
                {m.name}
              </h2>
              <span
                className={cn(
                  'shrink-0 font-mono text-[10px] uppercase',
                  m.status === 'running' ? 'text-honey-500' : 'text-hive-subtle',
                )}
              >
                {m.status}
              </span>
            </div>
            <p className="mt-1 line-clamp-2 font-mono text-[11px] leading-snug text-hive-subtle">
              {m.objective}
            </p>
            <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-hive-subtle">
              <span>{m._count.agents} agents</span>
              <span>{m._count.findings} findings</span>
              <span>{m._count.hypotheses} claims</span>
              <span className="text-burnt-500">{m.allowedActions.join(', ') || 'no actions'}</span>
            </div>
            {m.lastDecisionAt && (
              <p className="mt-1 font-mono text-[10px] text-hive-subtle">
                last decision {fmtRelative(m.lastDecisionAt)}
              </p>
            )}
          </Link>
        ))}
      </div>

      {!isAdmin && (
        <p className="font-mono text-[11px] text-hive-subtle">
          Read-only: running a mission and approving its proposals require the admin role.
        </p>
      )}
    </div>
  );
}
