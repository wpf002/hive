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
/**
 * Shared button feel.
 *
 * `transition-colors` alone is not enough — without an active state a click has
 * no acknowledgement at all between press and whatever the server eventually
 * says, which is what makes the controls feel unresponsive rather than slow.
 * The scale nudge fires on press, so the button answers the finger immediately
 * and the network result arrives into an already-acknowledged interaction.
 */
const BTN =
  'rounded border font-mono uppercase tracking-[0.1em] transition-all duration-150 ' +
  'active:scale-[0.96] cursor-pointer select-none ' +
  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-honey-500/70 ' +
  'disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100';

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
              className={cn(
                BTN,
                'shrink-0 border-honey-500 px-3 py-1 text-xs text-honey-500 hover:bg-honey-500 hover:text-hive-bg',
              )}
            >
              {busy ? 'composing…' : 'go'}
            </button>
          </>
        ) : (
          <button
            onClick={onOpen}
            className="flex-1 cursor-pointer text-left font-mono text-sm uppercase tracking-[0.08em] text-hive-subtle/70 transition-colors duration-150 hover:text-hive-subtle"
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
  // Shown instead of the server's status until the next snapshot confirms it.
  // Without this a click waits on a round-trip *and* the next SSE tick before
  // anything changes — up to a second of a button that looks broken.
  const [optimisticStatus, setOptimisticStatus] = useState<string | null>(null);

  // Drop the override once the server reports the same thing, so the button
  // goes back to reflecting reality rather than our guess about it.
  const serverStatus = snapshot?.status;
  useEffect(() => {
    if (optimisticStatus && serverStatus === optimisticStatus) setOptimisticStatus(null);
  }, [serverStatus, optimisticStatus]);

  // Stopping is the one control that always has to be one click away. Every
  // running mission polls its feeds and wakes a model on each genuine board
  // change, so a mission you have stopped watching is still spending.
  async function setStatus(status: 'running' | 'paused') {
    setPausing(true);
    setOptimisticStatus(status);
    try {
      await api.patch(`/api/missions/${missionId}`, { status });
    } catch {
      setOptimisticStatus(null); // let the real status reassert itself
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

  const status = optimisticStatus ?? snapshot.status;
  const pending = snapshot.proposals.filter((p) => p.status === 'pending');
  const corroborated = snapshot.claims.filter((c) => c.independentSources >= 2 && !c.refuted);
  const top = corroborated[0] ?? snapshot.claims[0];

  return (
    <>
      {/* one line of numbers, not a dashboard */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 px-4 py-1.5 font-mono text-[11px] uppercase tracking-[0.08em] text-hive-subtle">
        <span className="truncate text-hive-text">{snapshot.name}</span>
        {/* The swarm's shape, in the order it actually matters: how many bots
            are working, how much ground they cover, and from how many places
            the evidence comes. Bot count alone is the number that means the
            least — a hundred bots on one feed is still one feed. */}
        <span>
          {snapshot.fleet.running}/{snapshot.fleet.bots} bots
        </span>
        {snapshot.fleet.subjects > 0 && (
          <span>
            {snapshot.fleet.subjects} watching
          </span>
        )}
        <span>
          {snapshot.sources.length} sources
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
        {status === 'running' ? (
          <button
            onClick={() => setStatus('paused')}
            disabled={pausing}
            className={cn(
              BTN,
              'border-hive-muted px-2 py-0.5 text-[11px] text-hive-subtle hover:border-red-600 hover:text-red-400',
            )}
            title="Stop the feeds and the model calls"
          >
            {pausing ? '…' : 'stop'}
          </button>
        ) : (
          <button
            onClick={() => setStatus('running')}
            disabled={pausing}
            className={cn(
              BTN,
              'border-honey-500 px-2 py-0.5 text-[11px] text-honey-500 hover:bg-honey-500 hover:text-hive-bg',
            )}
          >
            {pausing ? '…' : 'resume'}
          </button>
        )}
      </div>

      <div className="relative min-h-0 flex-1">
        <FlowField
          sources={snapshot.sources}
          claims={snapshot.claims}
          findings={snapshot.findings}
          findingsPerMin={snapshot.findingsPerMin}
          decisionPulse={snapshot.lastDecisionAt ? Date.parse(snapshot.lastDecisionAt) : null}
        />
      </div>

      {/* The swarm only speaks when it has something corroborated, or something
          it wants permission for. Silence is the normal state. */}
      <div className="max-h-24 shrink-0 overflow-hidden border-t border-hive-border/60 px-4 py-2.5">
        <div className="mx-auto max-w-3xl">
          {pending.length > 0 ? (
            <Approvals missionId={missionId} proposals={pending} />
          ) : top ? (
            <p className="line-clamp-2 font-mono text-xs leading-relaxed" title={top.claim}>
              <span
                className={cn(
                  'mr-2',
                  top.refuted
                    ? 'text-red-500'
                    : top.independentSources >= 2
                      ? 'text-honey-500'
                      : 'text-red-500',
                )}
              >
                {corroborationLabel(top.independentSources, top.refuted, top.subject)}
              </span>
              <span className={cn(top.refuted && 'text-hive-subtle line-through')}>{top.claim}</span>
            </p>
          ) : status !== 'running' ? (
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

/**
 * "2 src" told you nothing unless you already knew the model. The number that
 * matters is how many independent feeds agree, so say that.
 *
 * The subject is named because on a wide mission "2 sources agree" is only half
 * the sentence — agree about which of the two hundred things being watched?
 */
function corroborationLabel(sources: number, refuted: boolean, subject: string): string {
  const on = subject ? ` on ${subject}` : '';
  if (refuted) return 'Refuted —';
  if (sources === 0) return 'Unverified —';
  if (sources === 1) return `Only 1 source${on} —`;
  return `${sources} sources agree${on} —`;
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
          className={cn(
            BTN,
            'border-honey-500 px-2.5 py-0.5 text-[11px] text-honey-500 hover:bg-honey-500 hover:text-hive-bg',
          )}
        >
          {p.action}
        </button>
        <button
          onClick={() => respond(p.id, 'reject')}
          disabled={busy === p.id}
          className={cn(
            BTN,
            'border-hive-muted px-2.5 py-0.5 text-[11px] text-hive-subtle hover:border-red-700 hover:text-red-400',
          )}
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
