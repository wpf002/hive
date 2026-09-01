'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useMe } from '@/lib/useMe';
import { useMissionStream } from '@/components/swarm/useMissionStream';
import { FlowField } from '@/components/swarm/FlowField';
import { PanelRail } from '@/components/swarm/PanelRail';
import { ClaimBoard } from '@/components/swarm/ClaimBoard';
import { ProposalQueue } from '@/components/swarm/ProposalQueue';

/**
 * Mission terminal. One screen, live, dense: the swarm field on top and the
 * two things an operator acts on — the claim board and the approval queue —
 * along the bottom.
 */
export default function MissionTerminalPage({ params }: { params: { id: string } }) {
  const { snapshot, connected, error } = useMissionStream(params.id);
  const { isAdmin } = useMe();

  const decisionPulse = useMemo(
    () => (snapshot?.lastDecisionAt ? Date.parse(snapshot.lastDecisionAt) : null),
    [snapshot?.lastDecisionAt],
  );

  async function setStatus(status: 'running' | 'paused') {
    await api.patch(`/api/missions/${params.id}`, { status });
  }

  if (error && !snapshot) {
    return (
      <div className="p-6">
        <p className="font-mono text-sm text-red-400">{error}</p>
        <Link href="/missions" className="mt-2 inline-block font-mono text-xs text-honey-500">
          ← back to missions
        </Link>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="p-6 font-mono text-sm text-hive-subtle">
        Connecting to mission {params.id.slice(0, 8)}…
      </div>
    );
  }

  const live = snapshot.agents.filter((a) => a.state === 'running').length;
  const stalled = snapshot.agents.filter((a) => a.state === 'stalled').length;
  const pending = snapshot.proposals.filter((p) => p.status === 'pending').length;
  const sources = new Set(snapshot.agents.map((a) => a.sourceId).filter(Boolean)).size;
  const echoing = snapshot.claims.filter((c) => c.agentCount > 2 && c.independentSources < 2).length;

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] flex-col">
      {/* status line */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-hive-border bg-hive-surface px-3 py-2 font-mono text-[11px] text-hive-subtle">
        <Link href="/missions" className="flex items-center gap-1 hover:text-honey-500">
          <ArrowLeft className="h-3 w-3" />
        </Link>
        <span className="text-hive-text">{snapshot.name}</span>
        <span
          className={cn(
            'uppercase',
            snapshot.status === 'running' ? 'text-honey-500' : 'text-hive-subtle',
          )}
        >
          {snapshot.status}
        </span>
        <span>
          agents <b className="text-hive-text">{snapshot.agents.length}</b> · live{' '}
          <b className="text-honey-500">{live}</b>
        </span>
        {stalled > 0 && <span className="text-red-500">stalled {stalled}</span>}
        <span>
          sources <b className="text-hive-text">{sources}</b>
        </span>
        <span title="distinct findings after collapsing duplicate observations">
          findings <b className="text-hive-text">{snapshot.distinctFindings}</b>
          <span className="text-hive-subtle">/{snapshot.findings}</span>
        </span>
        <span>
          claims <b className="text-hive-text">{snapshot.claims.length}</b>
        </span>
        {echoing > 0 && (
          <span className="text-red-500" title="claims with many agents but only one source">
            {echoing} echoing
          </span>
        )}
        {pending > 0 && (
          <span className="animate-pulse font-semibold text-hive-text">
            {pending} awaiting approval
          </span>
        )}
        {!connected && <span className="text-burnt-500">reconnecting…</span>}

        <span className="ml-auto flex items-center gap-3">
          <span>
            ${(snapshot.cost.todayCents / 100).toFixed(2)} today · $
            {(snapshot.cost.runRateCentsPerHour / 100).toFixed(2)}/hr
          </span>
          {isAdmin && (
            <button
              onClick={() => setStatus(snapshot.status === 'running' ? 'paused' : 'running')}
              className="rounded border border-hive-muted px-2 py-0.5 text-hive-subtle hover:border-honey-500 hover:text-honey-500"
            >
              {snapshot.status === 'running' ? 'Pause' : 'Run'}
            </button>
          )}
        </span>
      </div>

      {/* The field takes the room — it is the instrument, not an illustration.
          `relative` + an absolutely-positioned canvas is load-bearing: a canvas
          sized with h-full inside a flex child with no definite height resolves
          to 0x0, which renders nothing at all. */}
      <div className="relative min-h-0 flex-1 bg-[#07070a]">
        <FlowField
          agents={snapshot.agents}
          claims={snapshot.claims}
          findings={snapshot.findings}
          findingsPerMin={snapshot.findingsPerMin}
          decisionPulse={decisionPulse}
        />
      </div>

      {/* instrument rail */}
      <div className="shrink-0 border-t border-hive-border">
        <PanelRail snap={snapshot} />
      </div>

      {/* board + queue */}
      <div className="grid h-[26%] min-h-[150px] shrink-0 grid-cols-1 border-t border-hive-border bg-hive-surface lg:grid-cols-3">
        <div className="col-span-1 min-h-0 border-hive-border lg:col-span-2 lg:border-r">
          <ClaimBoard claims={snapshot.claims} />
        </div>
        <div className="col-span-1 min-h-0 border-t border-hive-border lg:border-t-0">
          <ProposalQueue
            missionId={params.id}
            proposals={snapshot.proposals}
            canApprove={isAdmin}
          />
        </div>
      </div>
    </div>
  );
}
