'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { fmtRelative } from '@/lib/format';
import type { PaperWallet, PaperTrade, TradeAudit, Job } from '@/lib/types';

type Tab = 'wallets' | 'trades' | 'audit' | 'watchers';

export default function TradingPage() {
  const [tab, setTab] = useState<Tab>('wallets');
  return (
    <div className="space-y-4 p-6">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">Trading</h1>
          <p className="font-mono text-xs text-hive-subtle">PAPER MODE BY DEFAULT · LIVE REQUIRES TRADING_LIVE_ENABLED=TRUE</p>
        </div>
      </div>

      <div className="flex gap-1 border-b border-hive-border">
        {(['wallets', 'trades', 'audit', 'watchers'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              'rounded-t px-3 py-1.5 font-mono text-xs uppercase transition-colors',
              tab === t ? 'bg-hive-surface text-honey-500' : 'text-hive-subtle hover:bg-hive-muted',
            )}
          >
            {t === 'wallets' ? 'Paper Wallets' : t === 'trades' ? 'Trade History' : t === 'audit' ? 'Audit Log' : 'Watchers'}
          </button>
        ))}
      </div>

      {tab === 'wallets' && <WalletsTab />}
      {tab === 'trades' && <TradesTab />}
      {tab === 'audit' && <AuditTab />}
      {tab === 'watchers' && <WatchersTab />}
    </div>
  );
}

function WalletsTab() {
  const qc = useQueryClient();
  const wallets = useQuery<PaperWallet[]>({
    queryKey: ['trading', 'wallets'],
    queryFn: () => api.get<PaperWallet[]>('/api/paper-wallet'),
    refetchInterval: 5_000,
  });
  const [exchange, setExchange] = useState('binance');
  const [currency, setCurrency] = useState('USDT');
  const [amount, setAmount] = useState('10000');
  const [seeding, setSeeding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function seed() {
    setError(null);
    setSeeding(true);
    try {
      await api.post('/api/paper-wallet/seed', {
        exchange,
        currency,
        amount: parseFloat(amount),
      });
      await qc.invalidateQueries({ queryKey: ['trading', 'wallets'] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSeeding(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-hive-border bg-hive-surface p-4">
        <div className="mb-2 font-mono text-[11px] uppercase text-hive-subtle">Seed / Top up wallet</div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col">
            <span className="font-mono text-[10px] uppercase text-hive-subtle">Exchange</span>
            <select
              value={exchange}
              onChange={(e) => setExchange(e.target.value)}
              className="mt-1 rounded border border-hive-border bg-hive-bg px-2 py-1 font-mono text-xs"
            >
              <option value="binance">binance</option>
              <option value="coinbase">coinbase</option>
              <option value="kraken">kraken</option>
            </select>
          </label>
          <label className="flex flex-col">
            <span className="font-mono text-[10px] uppercase text-hive-subtle">Currency</span>
            <input
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              className="mt-1 w-24 rounded border border-hive-border bg-hive-bg px-2 py-1 font-mono text-xs"
            />
          </label>
          <label className="flex flex-col">
            <span className="font-mono text-[10px] uppercase text-hive-subtle">Amount</span>
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="mt-1 w-32 rounded border border-hive-border bg-hive-bg px-2 py-1 font-mono text-xs"
            />
          </label>
          <button
            type="button"
            onClick={seed}
            disabled={seeding}
            className="rounded bg-honey-500 px-3 py-1.5 text-xs font-semibold text-black hover:bg-honey-400 disabled:opacity-60"
          >
            {seeding ? 'Seeding…' : 'Seed funds'}
          </button>
          {error && <span className="font-mono text-xs text-red-400">{error}</span>}
        </div>
      </div>

      <div className="rounded-lg border border-hive-border bg-hive-surface">
        <table className="w-full text-sm">
          <thead className="text-left font-mono text-[10px] uppercase text-hive-subtle">
            <tr>
              <th className="px-4 py-2">Exchange</th>
              <th className="px-4 py-2">Currency</th>
              <th className="px-4 py-2 text-right">Balance</th>
              <th className="px-4 py-2">Last update</th>
            </tr>
          </thead>
          <tbody>
            {wallets.data?.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-6 text-center font-mono text-xs text-hive-subtle">
                No paper wallets yet — seed one above.
              </td></tr>
            )}
            {wallets.data?.map((w) => (
              <tr key={w.id} className="border-t border-hive-border">
                <td className="px-4 py-2 font-mono text-xs">{w.exchange}</td>
                <td className="px-4 py-2 font-mono text-xs">{w.currency}</td>
                <td className="px-4 py-2 text-right font-mono text-xs">{w.balance}</td>
                <td className="px-4 py-2 font-mono text-xs text-hive-subtle">{fmtRelative(w.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TradesTab() {
  const trades = useQuery<PaperTrade[]>({
    queryKey: ['trading', 'trades'],
    queryFn: () => api.get<PaperTrade[]>('/api/paper-trades?limit=200'),
    refetchInterval: 5_000,
  });

  return (
    <div className="rounded-lg border border-hive-border bg-hive-surface">
      <table className="w-full text-sm">
        <thead className="text-left font-mono text-[10px] uppercase text-hive-subtle">
          <tr>
            <th className="px-4 py-2">Time</th>
            <th className="px-4 py-2">Exchange</th>
            <th className="px-4 py-2">Symbol</th>
            <th className="px-4 py-2">Side</th>
            <th className="px-4 py-2 text-right">Amount</th>
            <th className="px-4 py-2 text-right">Price</th>
            <th className="px-4 py-2">Status</th>
            <th className="px-4 py-2">Job</th>
          </tr>
        </thead>
        <tbody>
          {trades.data?.length === 0 && (
            <tr><td colSpan={8} className="px-4 py-6 text-center font-mono text-xs text-hive-subtle">No paper trades yet.</td></tr>
          )}
          {trades.data?.map((t) => (
            <tr key={t.id} className="border-t border-hive-border">
              <td className="px-4 py-2 font-mono text-[11px] text-hive-subtle">{fmtRelative(t.createdAt)}</td>
              <td className="px-4 py-2 font-mono text-xs">{t.exchange}</td>
              <td className="px-4 py-2 font-mono text-xs">{t.symbol}</td>
              <td className={cn('px-4 py-2 font-mono text-xs uppercase', t.side === 'buy' ? 'text-emerald-400' : 'text-red-400')}>{t.side}</td>
              <td className="px-4 py-2 text-right font-mono text-xs">{t.amount}</td>
              <td className="px-4 py-2 text-right font-mono text-xs">{t.executedPrice ?? t.price ?? '—'}</td>
              <td className="px-4 py-2 font-mono text-xs">{t.status}</td>
              <td className="px-4 py-2 font-mono text-[10px] text-hive-subtle">
                <a href={`/jobs/${t.jobId}`} className="hover:text-honey-500">{t.jobId.slice(0, 10)}</a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AuditTab() {
  const audit = useQuery<TradeAudit[]>({
    queryKey: ['trading', 'audit'],
    queryFn: () => api.get<TradeAudit[]>('/api/trade-audit?limit=200'),
    refetchInterval: 5_000,
  });
  const [open, setOpen] = useState<string | null>(null);

  return (
    <div className="rounded-lg border border-hive-border bg-hive-surface">
      <table className="w-full text-sm">
        <thead className="text-left font-mono text-[10px] uppercase text-hive-subtle">
          <tr>
            <th className="px-4 py-2">Time</th>
            <th className="px-4 py-2">Mode</th>
            <th className="px-4 py-2">Action</th>
            <th className="px-4 py-2">Bot</th>
            <th className="px-4 py-2">Job</th>
            <th className="px-4 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {audit.data?.length === 0 && (
            <tr><td colSpan={6} className="px-4 py-6 text-center font-mono text-xs text-hive-subtle">No audit entries.</td></tr>
          )}
          {audit.data?.map((a) => (
            <>
              <tr key={a.id} className="border-t border-hive-border">
                <td className="px-4 py-2 font-mono text-[11px] text-hive-subtle">{fmtRelative(a.createdAt)}</td>
                <td className="px-4 py-2">
                  <ModeBadge mode={a.mode} />
                </td>
                <td className="px-4 py-2 font-mono text-xs">{a.action}</td>
                <td className="px-4 py-2 font-mono text-[10px] text-hive-subtle">
                  <a href={`/bots/${a.botId}`} className="hover:text-honey-500">{a.botId.slice(0, 10)}</a>
                </td>
                <td className="px-4 py-2 font-mono text-[10px] text-hive-subtle">
                  <a href={`/jobs/${a.jobId}`} className="hover:text-honey-500">{a.jobId.slice(0, 10)}</a>
                </td>
                <td className="px-4 py-2 text-right">
                  <button
                    onClick={() => setOpen(open === a.id ? null : a.id)}
                    className="rounded border border-hive-border px-2 py-0.5 font-mono text-[10px] text-hive-subtle hover:text-honey-500"
                  >
                    {open === a.id ? 'hide' : 'expand'}
                  </button>
                </td>
              </tr>
              {open === a.id && (
                <tr className="border-t border-hive-border bg-black/40">
                  <td colSpan={6} className="px-4 py-3 font-mono text-[11px]">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <div className="text-hive-subtle">payload:</div>
                        <pre className="whitespace-pre-wrap text-emerald-300">{JSON.stringify(a.payload, null, 2)}</pre>
                      </div>
                      <div>
                        <div className="text-hive-subtle">result:</div>
                        <pre className="whitespace-pre-wrap text-amber-200">{JSON.stringify(a.result, null, 2)}</pre>
                      </div>
                    </div>
                  </td>
                </tr>
              )}
            </>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WatchersTab() {
  // Running Arbitrage Watcher jobs — query /api/jobs and filter to template name.
  const jobs = useQuery<Job[]>({
    queryKey: ['trading', 'watchers'],
    queryFn: () => api.get<Job[]>('/api/jobs?status=running&limit=100'),
    refetchInterval: 5_000,
  });
  const watchers = (jobs.data ?? []).filter(
    (j) => j.bot?.template?.name === 'Arbitrage Watcher',
  );
  return (
    <div className="rounded-lg border border-hive-border bg-hive-surface">
      <table className="w-full text-sm">
        <thead className="text-left font-mono text-[10px] uppercase text-hive-subtle">
          <tr>
            <th className="px-4 py-2">Started</th>
            <th className="px-4 py-2">Bot</th>
            <th className="px-4 py-2">Symbol</th>
            <th className="px-4 py-2">Exchanges</th>
            <th className="px-4 py-2">Duration</th>
            <th className="px-4 py-2">Job</th>
          </tr>
        </thead>
        <tbody>
          {watchers.length === 0 && (
            <tr><td colSpan={6} className="px-4 py-6 text-center font-mono text-xs text-hive-subtle">No watchers running.</td></tr>
          )}
          {watchers.map((j) => {
            const cfg = (j.bot?.config ?? {}) as Record<string, unknown>;
            return (
              <tr key={j.id} className="border-t border-hive-border">
                <td className="px-4 py-2 font-mono text-[11px] text-hive-subtle">{j.startedAt ? fmtRelative(j.startedAt) : '—'}</td>
                <td className="px-4 py-2 font-mono text-xs">{j.bot?.name ?? '—'}</td>
                <td className="px-4 py-2 font-mono text-xs">{String(cfg.symbol ?? '—')}</td>
                <td className="px-4 py-2 font-mono text-xs">{Array.isArray(cfg.exchanges) ? (cfg.exchanges as string[]).join(', ') : '—'}</td>
                <td className="px-4 py-2 font-mono text-xs">{String(cfg.durationSeconds ?? '—')}s</td>
                <td className="px-4 py-2 font-mono text-[10px] text-hive-subtle">
                  <a href={`/jobs/${j.id}`} className="hover:text-honey-500">{j.id.slice(0, 10)}</a>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ModeBadge({ mode }: { mode: 'paper' | 'live' }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase',
        mode === 'live'
          ? 'border-red-500/50 bg-red-500/10 text-red-400'
          : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400',
      )}
    >
      {mode}
    </span>
  );
}
