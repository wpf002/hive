'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import type { ProposalView } from '@/lib/mission-types';

/**
 * The only place a human is in the loop.
 *
 * Every pending proposal shows its hard countdown. An approval that lands after
 * expiry is refused server-side, so the timer is real information rather than
 * decoration — and when it runs out the buttons go away rather than staying
 * clickable and failing.
 */
export function ProposalQueue({
  missionId,
  proposals,
  canApprove,
}: {
  missionId: string;
  proposals: ProposalView[];
  canApprove: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, tick] = useState(0);

  // Drives the countdown; the SSE snapshot drives everything else.
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const pending = proposals.filter((p) => p.status === 'pending');
  const recent = proposals.filter((p) => p.status !== 'pending').slice(0, 8);

  async function respond(id: string, decision: 'approve' | 'reject') {
    setBusy(id);
    setError(null);
    try {
      await api.post(`/api/missions/${missionId}/proposals/${id}/${decision}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-baseline justify-between border-b border-hive-border px-3 py-2">
        <h2 className="font-mono text-[11px] uppercase tracking-wider text-hive-subtle">
          Awaiting approval
        </h2>
        {pending.length > 0 && (
          <span className="font-mono text-[10px] text-hive-text">{pending.length} pending</span>
        )}
      </div>

      {error && (
        <p className="border-b border-red-900/60 bg-red-950/40 px-3 py-1.5 font-mono text-[11px] text-red-400">
          {error}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {pending.length === 0 && (
          <p className="px-3 py-4 font-mono text-xs text-hive-subtle">Nothing to approve.</p>
        )}

        {pending.map((p) => {
          const left = Math.max(0, Math.floor((Date.parse(p.expiresAt) - Date.now()) / 1000));
          const expired = left === 0;
          const failed = p.constraintResults.filter((r) => !r.passed);
          return (
            <div key={p.id} className="border-b border-hive-border px-3 py-2">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-xs font-semibold text-hive-text">{p.action}</span>
                <span
                  className={cn(
                    'font-mono text-[11px] tabular-nums',
                    expired ? 'text-red-500' : left < 30 ? 'text-burnt-500' : 'text-hive-subtle',
                  )}
                >
                  {expired ? 'expired' : `${left}s`}
                </span>
              </div>

              <p className="mt-0.5 font-mono text-[11px] leading-snug text-hive-subtle">
                {p.rationale}
              </p>

              {failed.length > 0 && (
                <p className="mt-1 font-mono text-[10px] text-red-500">
                  gated: {failed.map((r) => `${r.rule} (${r.detail ?? 'failed'})`).join(' · ')}
                </p>
              )}

              {!expired && canApprove && (
                <div className="mt-1.5 flex gap-1.5">
                  <button
                    onClick={() => respond(p.id, 'approve')}
                    disabled={busy === p.id}
                    className="rounded border border-honey-500 px-2 py-0.5 font-mono text-[11px] text-honey-500 hover:bg-honey-500 hover:text-hive-bg disabled:opacity-40"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => respond(p.id, 'reject')}
                    disabled={busy === p.id}
                    className="rounded border border-hive-muted px-2 py-0.5 font-mono text-[11px] text-hive-subtle hover:border-red-700 hover:text-red-400 disabled:opacity-40"
                  >
                    Reject
                  </button>
                </div>
              )}
              {!expired && !canApprove && (
                <p className="mt-1.5 font-mono text-[10px] text-hive-subtle">
                  admin role required to approve
                </p>
              )}
            </div>
          );
        })}

        {recent.length > 0 && (
          <div className="px-3 py-2">
            <p className="font-mono text-[10px] uppercase tracking-wider text-hive-subtle">
              Recent
            </p>
            {recent.map((p) => (
              <div key={p.id} className="flex gap-2 py-0.5 font-mono text-[11px]">
                <span
                  className={cn(
                    'w-16 shrink-0',
                    p.status === 'executed' && 'text-honey-500',
                    p.status === 'approved' && 'text-burnt-500',
                    (p.status === 'rejected' || p.status === 'failed') && 'text-red-500',
                    (p.status === 'expired' || p.status === 'pending') && 'text-hive-subtle',
                  )}
                >
                  {p.status}
                </span>
                <span className="truncate text-hive-subtle">{p.action}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
