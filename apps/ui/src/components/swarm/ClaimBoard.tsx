'use client';

import { cn } from '@/lib/cn';
import type { ClaimView } from '@/lib/mission-types';

/**
 * Claims ranked by independent source count, never by how many agents agree.
 *
 * Both numbers are shown side by side on purpose: when `agents` is large and
 * `src` is 1, the swarm is echoing itself, and that's the one thing an operator
 * must be able to see at a glance.
 */
export function ClaimBoard({ claims }: { claims: ClaimView[] }) {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-baseline justify-between border-b border-hive-border px-3 py-2">
        <h2 className="font-mono text-[11px] uppercase tracking-wider text-hive-subtle">
          Claims on the board
        </h2>
        <span className="font-mono text-[10px] text-hive-subtle">ranked by independent sources</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {claims.length === 0 && (
          <p className="px-3 py-4 font-mono text-xs text-hive-subtle">
            No claims yet. Gatherers are still foraging.
          </p>
        )}

        <table className="w-full border-collapse font-mono text-xs">
          <tbody>
            {claims.map((c) => (
              <tr
                key={c.id}
                className={cn(
                  'border-b border-hive-border/60 align-top',
                  c.refuted && 'opacity-50',
                )}
              >
                <td className="w-14 py-1.5 pl-3 pr-1">
                  <span
                    className={cn(
                      'tabular-nums',
                      c.independentSources >= 2 ? 'text-honey-500' : 'text-red-500',
                    )}
                    title={`${c.independentSources} distinct upstream sources back this claim`}
                  >
                    {c.independentSources} src
                  </span>
                </td>
                <td className="w-14 py-1.5 pr-1">
                  <span
                    className="tabular-nums text-hive-subtle"
                    title={`${c.agentCount} agents produced this claim — agent count is not evidence`}
                  >
                    {c.agentCount} agt
                  </span>
                </td>
                <td className="w-12 py-1.5 pr-2 tabular-nums text-hive-subtle">
                  {(c.confidence * 100).toFixed(0)}%
                </td>
                <td className="py-1.5 pr-3 text-hive-text">
                  {c.refuted && <span className="mr-1.5 text-red-500">REFUTED</span>}
                  {c.claim}
                  {c.objections > 0 && !c.refuted && (
                    <span className="ml-1.5 text-burnt-500">
                      {c.objections} objection{c.objections === 1 ? '' : 's'}
                    </span>
                  )}
                  {c.agentCount > 2 && c.independentSources < 2 && (
                    <span className="ml-1.5 text-red-500" title="Many agents, one source">
                      echo
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
