'use client';

import { cn } from '@/lib/cn';
import type { MissionSnapshot } from '@/lib/mission-types';

/**
 * The instrument rail. Six dense readouts under the field, each answering one
 * question an operator actually asks, at a glance:
 *
 *   feed          is evidence still arriving, and from where
 *   independence  how much of the board is genuinely corroborated
 *   sources       which feeds are carrying the mission
 *   claims        the ranked board
 *   spend         what this is costing per hour
 *   queue         what is waiting on a human
 *
 * Everything is drawn with inline SVG and tabular numerals rather than a chart
 * library: at this size a library's axes and padding cost more pixels than the
 * data, and the whole point of the rail is density.
 */

const HONEY = '#FFC107';
const BURNT = '#FF6B1A';
const ALARM = '#C4453A';
const DIM = '#3F3F46';

export function PanelRail({ snap }: { snap: MissionSnapshot }) {
  const sources = snap.sources
    .map((s) => [s.sourceId, s.contributions] as const)
    .sort((a, b) => b[1] - a[1]);
  const maxSrc = Math.max(1, ...sources.map(([, n]) => n));

  const corroborated = snap.claims.filter((c) => c.independentSources >= 2 && !c.refuted).length;
  const echoing = snap.claims.filter((c) => c.agentCount > 2 && c.independentSources < 2).length;
  const refuted = snap.claims.filter((c) => c.refuted).length;
  const pending = snap.proposals.filter((p) => p.status === 'pending');
  const dupRate = snap.findings > 0 ? 1 - snap.distinctFindings / snap.findings : 0;

  return (
    <div className="grid grid-cols-2 gap-px bg-hive-border sm:grid-cols-3 xl:grid-cols-6">
      <Panel title="feed">
        <Big value={String(snap.distinctFindings)} sub={`/${snap.findings} raw`} />
        <Row label="duplicate" value={`${(dupRate * 100).toFixed(0)}%`} tone={dupRate > 0.5 ? 'warn' : 'dim'} />
        <Row label="sources" value={String(sources.length)} />
        {snap.fleet.subjects > 0 && <Row label="watching" value={`${snap.fleet.subjects} subjects`} />}
        <Row label="live" value={`${snap.fleet.running}/${snap.fleet.bots} bots`} />
      </Panel>

      <Panel title="independence">
        <Big
          value={String(corroborated)}
          sub={`/${snap.claims.length} claims`}
          tone={corroborated === 0 && snap.claims.length > 0 ? 'warn' : 'good'}
        />
        <Row label="echoing" value={String(echoing)} tone={echoing > 0 ? 'warn' : 'dim'} />
        <Row label="refuted" value={String(refuted)} tone={refuted > 0 ? 'warn' : 'dim'} />
        <Row label="min bar" value="2 src" />
      </Panel>

      <Panel title="sources">
        {sources.length === 0 && <Empty>no gatherers bound</Empty>}
        {sources.slice(0, 6).map(([id, n]) => (
          <div key={id} className="flex items-center gap-1.5 py-px">
            <span className="w-16 shrink-0 truncate text-[10px] text-hive-subtle">{id}</span>
            <div className="h-1.5 flex-1 bg-hive-bg">
              <div
                className="h-full"
                style={{ width: `${(n / maxSrc) * 100}%`, background: HONEY }}
              />
            </div>
            <span className="w-6 shrink-0 text-right text-[10px] tabular-nums text-hive-subtle">{n}</span>
          </div>
        ))}
      </Panel>

      <Panel title="claims" wide>
        {snap.claims.length === 0 && <Empty>board is empty</Empty>}
        {snap.claims.slice(0, 6).map((c) => (
          <div key={c.id} className="flex items-baseline gap-1.5 py-px">
            <span
              className="w-5 shrink-0 text-right text-[10px] tabular-nums"
              style={{ color: c.independentSources >= 2 ? HONEY : ALARM }}
            >
              {c.independentSources}
            </span>
            <span className="w-6 shrink-0 text-[10px] tabular-nums text-hive-subtle">
              {c.agentCount}a
            </span>
            <span
              className={cn('truncate text-[10px]', c.refuted ? 'text-red-500 line-through' : 'text-hive-text')}
            >
              {c.claim}
            </span>
          </div>
        ))}
      </Panel>

      <Panel title="spend">
        <Big value={`$${(snap.cost.todayCents / 100).toFixed(2)}`} sub="24h" />
        <Row label="run rate" value={`$${(snap.cost.runRateCentsPerHour / 100).toFixed(2)}/h`} />
        <Row
          label="last call"
          value={snap.lastDecisionAt ? relTime(snap.lastDecisionAt) : 'never'}
          tone="dim"
        />
        <Row label="model" value="1/change" tone="dim" />
      </Panel>

      <Panel title="approval">
        <Big
          value={String(pending.length)}
          sub="pending"
          tone={pending.length > 0 ? 'live' : 'dim'}
        />
        {pending.slice(0, 3).map((p) => (
          <Row key={p.id} label={p.action} value={`${ttl(p.expiresAt)}s`} tone="warn" />
        ))}
        {pending.length === 0 && (
          <Row
            label="last"
            value={snap.proposals[0]?.status ?? 'none'}
            tone="dim"
          />
        )}
      </Panel>
    </div>
  );
}

function Panel({
  title,
  children,
  wide,
}: {
  title: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={cn('bg-hive-surface px-2 py-1.5', wide && 'col-span-2 sm:col-span-1')}>
      <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.12em] text-hive-subtle">
        {title}
      </div>
      <div className="font-mono">{children}</div>
    </div>
  );
}

function Big({
  value,
  sub,
  tone = 'good',
}: {
  value: string;
  sub?: string;
  tone?: 'good' | 'warn' | 'live' | 'dim';
}) {
  const color =
    tone === 'warn' ? ALARM : tone === 'live' ? '#FAFAFA' : tone === 'dim' ? DIM : HONEY;
  return (
    <div className="flex items-baseline gap-1 leading-none">
      <span className="text-lg tabular-nums" style={{ color }}>
        {value}
      </span>
      {sub && <span className="text-[10px] text-hive-subtle">{sub}</span>}
    </div>
  );
}

function Row({
  label,
  value,
  tone = 'dim',
}: {
  label: string;
  value: string;
  tone?: 'warn' | 'dim';
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-px text-[10px]">
      <span className="truncate text-hive-subtle">{label}</span>
      <span className="tabular-nums" style={{ color: tone === 'warn' ? BURNT : '#A1A1AA' }}>
        {value}
      </span>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="py-1 text-[10px] text-hive-subtle">{children}</div>;
}

function ttl(iso: string): number {
  return Math.max(0, Math.floor((Date.parse(iso) - Date.now()) / 1000));
}

function relTime(iso: string): string {
  const s = Math.floor((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}
