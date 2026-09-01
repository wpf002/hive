'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { BeeMark } from '@/components/BeeMark';
import { useMissionStream } from '@/components/swarm/useMissionStream';
import { FlowField } from '@/components/swarm/FlowField';
import type { MissionListItem, ProposalView } from '@/lib/mission-types';

/**
 * The whole app, on one screen.
 *
 * You type what the swarm should watch; it composes the mission and starts it;
 * the field is what the bots are doing. Everything that used to be a page —
 * bots, templates, schedules, jobs, workers — is machinery underneath this, not
 * a place you have to visit.
 *
 * Chrome is deliberately thin. One line of numbers, and approvals only when
 * there is something to approve.
 */
export function SwarmConsole() {
  const [missionId, setMissionId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);

  // Land on whatever is already running rather than an empty screen.
  useEffect(() => {
    let live = true;
    api
      .get<MissionListItem[]>('/api/missions')
      .then((ms) => {
        if (!live) return;
        const running = ms.find((m) => m.status === 'running') ?? ms[0];
        if (running) setMissionId(running.id);
      })
      .catch(() => {
        /* first run, nothing yet */
      });
    return () => {
      live = false;
    };
  }, []);

  async function compose() {
    const description = prompt.trim();
    if (!description || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ mission: { id: string } }>('/api/missions/compose', {
        description,
      });
      setMissionId(res.mission.id);
      setPrompt('');
      setComposing(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-dvh flex-col bg-[#07070a] text-hive-text">
      <Prompt
        value={prompt}
        onChange={setPrompt}
        onSubmit={compose}
        busy={busy}
        error={error}
        open={composing || !missionId}
        onOpen={() => setComposing(true)}
        onClose={() => setComposing(false)}
        hasMission={!!missionId}
      />
      {missionId ? (
        <Field missionId={missionId} />
      ) : (
        <div className="flex flex-1 items-center justify-center px-6 text-center">
          <p className="max-w-md font-mono text-xs leading-relaxed text-hive-subtle">
            Describe what you want watched. Hive picks the feeds, puts one bot on each, and
            only tells you when something is corroborated by more than one of them.
          </p>
        </div>
      )}
    </div>
  );
}

function Prompt({
  value,
  onChange,
  onSubmit,
  busy,
  error,
  open,
  onOpen,
  onClose,
  hasMission,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  busy: boolean;
  error: string | null;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  hasMission: boolean;
}) {
  return (
    <div className="shrink-0 border-b border-hive-border/60 px-4 py-3">
      <div className="mx-auto flex max-w-3xl items-center gap-2">
        <BeeMark size={20} className="shrink-0" />
        {open ? (
          <>
            <input
              autoFocus
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onSubmit();
                if (e.key === 'Escape' && hasMission) onClose();
              }}
              disabled={busy}
              placeholder="Watch NBA lines and tell me when the line moves against the money…"
              className="min-w-0 flex-1 bg-transparent font-mono text-sm text-hive-text outline-none placeholder:text-hive-subtle/70 disabled:opacity-50"
            />
            <button
              onClick={onSubmit}
              disabled={busy || !value.trim()}
              className="shrink-0 rounded border border-honey-500 px-3 py-1 font-mono text-xs uppercase tracking-[0.12em] text-honey-500 hover:bg-honey-500 hover:text-hive-bg disabled:opacity-30"
            >
              {busy ? 'composing…' : 'go'}
            </button>
          </>
        ) : (
          <button
            onClick={onOpen}
            className="flex-1 text-left font-mono text-sm uppercase tracking-[0.08em] text-hive-subtle/70 hover:text-hive-subtle"
          >
            Watch something else…
          </button>
        )}
      </div>
      {error && (
        <p className="mx-auto mt-1.5 max-w-3xl font-mono text-[11px] text-red-400">{error}</p>
      )}
      {busy && (
        <p className="mx-auto mt-1.5 max-w-3xl font-mono text-[11px] text-hive-subtle">
          picking feeds, putting one bot on each…
        </p>
      )}
    </div>
  );
}

function Field({ missionId }: { missionId: string }) {
  const { snapshot, connected } = useMissionStream(missionId);
  const [pausing, setPausing] = useState(false);

  // Stopping is the one control that always has to be one click away. Every
  // running mission polls its feeds and wakes a model on each genuine board
  // change, so a mission you have stopped watching is still spending.
  async function setStatus(status: 'running' | 'paused') {
    setPausing(true);
    try {
      await api.patch(`/api/missions/${missionId}`, { status });
    } finally {
      setPausing(false);
    }
  }

  if (!snapshot) {
    return (
      <div className="flex flex-1 items-center justify-center font-mono text-xs text-hive-subtle">
        waking the swarm…
      </div>
    );
  }

  const pending = snapshot.proposals.filter((p) => p.status === 'pending');
  const corroborated = snapshot.claims.filter((c) => c.independentSources >= 2 && !c.refuted);
  const top = corroborated[0] ?? snapshot.claims[0];

  return (
    <>
      {/* one line of numbers, not a dashboard */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 px-4 py-1.5 font-mono text-[11px] uppercase tracking-[0.08em] text-hive-subtle">
        <span className="truncate text-hive-text">{snapshot.name}</span>
        <span>
          {snapshot.agents.filter((a) => a.role === 'gatherer').length} feeds
        </span>
        <span>
          {snapshot.distinctFindings} findings
        </span>
        <span>
          <b className="text-honey-500">{corroborated.length}</b> corroborated
        </span>
        {!connected && <span className="text-burnt-500">reconnecting…</span>}
        {snapshot.stalled.pools.length > 0 && (
          <span className="text-red-500">
            {snapshot.stalled.pools.join(', ')} worker offline
          </span>
        )}
        <span className="ml-auto tabular-nums">
          ${(snapshot.cost.todayCents / 100).toFixed(2)} today
        </span>
        {snapshot.status === 'running' ? (
          <button
            onClick={() => setStatus('paused')}
            disabled={pausing}
            className="rounded border border-hive-muted px-2 py-0.5 uppercase tracking-[0.08em] text-hive-subtle hover:border-red-600 hover:text-red-400 disabled:opacity-40"
            title="Stop the feeds and the model calls"
          >
            {pausing ? '…' : 'stop'}
          </button>
        ) : (
          <button
            onClick={() => setStatus('running')}
            disabled={pausing}
            className="rounded border border-honey-500 px-2 py-0.5 uppercase tracking-[0.08em] text-honey-500 hover:bg-honey-500 hover:text-hive-bg disabled:opacity-40"
          >
            {pausing ? '…' : 'resume'}
          </button>
        )}
      </div>

      <div className="relative min-h-0 flex-1">
        <FlowField
          agents={snapshot.agents}
          claims={snapshot.claims}
          findings={snapshot.findings}
          findingsPerMin={snapshot.findingsPerMin}
          decisionPulse={snapshot.lastDecisionAt ? Date.parse(snapshot.lastDecisionAt) : null}
        />
      </div>

      {/* The swarm only speaks when it has something corroborated, or something
          it wants permission for. Silence is the normal state. */}
      <div className="shrink-0 border-t border-hive-border/60 px-4 py-2.5">
        <div className="mx-auto max-w-3xl">
          {pending.length > 0 ? (
            <Approvals missionId={missionId} proposals={pending} />
          ) : top ? (
            <p className="font-mono text-xs leading-relaxed">
              <span
                className={cn(
                  'mr-2 tabular-nums',
                  top.independentSources >= 2 ? 'text-honey-500' : 'text-red-500',
                )}
              >
                {top.independentSources} src
              </span>
              <span className={cn(top.refuted && 'text-hive-subtle line-through')}>{top.claim}</span>
            </p>
          ) : snapshot.status !== 'running' ? (
            <p className="font-mono text-xs text-hive-subtle">
              Stopped. No feeds are polling and no model calls are being made.
            </p>
          ) : snapshot.stalled.pools.length > 0 ? (
            <p className="font-mono text-xs leading-relaxed text-red-400">
              Nothing is running these feeds. The{' '}
              <b>{snapshot.stalled.pools.join(' and ')}</b> worker
              {snapshot.stalled.pools.length > 1 ? 's are' : ' is'} offline
              {snapshot.stalled.queuedJobs > 0
                ? `, so ${snapshot.stalled.queuedJobs} job${snapshot.stalled.queuedJobs > 1 ? 's are' : ' is'} stuck waiting.`
                : '.'}{' '}
              <span className="text-hive-subtle">
                Start it with: pnpm --filter @hive/worker-{snapshot.stalled.pools[0].replace('_', '-')} dev
              </span>
            </p>
          ) : (
            <p className="font-mono text-xs text-hive-subtle">
              Foraging. Nothing corroborated yet.
            </p>
          )}
        </div>
      </div>
    </>
  );
}

function Approvals({ missionId, proposals }: { missionId: string; proposals: ProposalView[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  async function respond(id: string, decision: 'approve' | 'reject') {
    setBusy(id);
    try {
      await api.post(`/api/missions/${missionId}/proposals/${id}/${decision}`);
    } catch {
      /* the row will reappear on the next snapshot if it failed */
    } finally {
      setBusy(null);
    }
  }

  const p = proposals[0];
  const left = Math.max(0, Math.floor((Date.parse(p.expiresAt) - Date.now()) / 1000));

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span className="font-mono text-xs text-hive-text">{p.rationale}</span>
      <span
        className={cn(
          'font-mono text-[11px] tabular-nums',
          left < 30 ? 'text-red-500' : 'text-hive-subtle',
        )}
      >
        {left}s
      </span>
      <span className="ml-auto flex gap-1.5">
        <button
          onClick={() => respond(p.id, 'approve')}
          disabled={busy === p.id}
          className="rounded border border-honey-500 px-2.5 py-0.5 font-mono text-[11px] uppercase tracking-[0.1em] text-honey-500 hover:bg-honey-500 hover:text-hive-bg disabled:opacity-40"
        >
          {p.action}
        </button>
        <button
          onClick={() => respond(p.id, 'reject')}
          disabled={busy === p.id}
          className="rounded border border-hive-muted px-2.5 py-0.5 font-mono text-[11px] uppercase tracking-[0.1em] text-hive-subtle hover:border-red-700 hover:text-red-400 disabled:opacity-40"
        >
          no
        </button>
        {proposals.length > 1 && (
          <span className="self-center font-mono text-[10px] text-hive-subtle">
            +{proposals.length - 1}
          </span>
        )}
      </span>
    </div>
  );
}
