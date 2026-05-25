import { cn } from '@/lib/cn';
import type { Pool } from '@/lib/types';

const POOL_COLORS: Record<Pool, string> = {
  scraper:     'bg-honey-500/15 text-honey-500 border-honey-500/30',
  ai_agent:    'bg-burnt-500/15 text-burnt-500 border-burnt-500/30',
  trading:     'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  browser:     'bg-sky-500/15 text-sky-400 border-sky-500/30',
  rpa_desktop: 'bg-fuchsia-500/15 text-fuchsia-400 border-fuchsia-500/30',
  discord:     'bg-indigo-500/15 text-indigo-400 border-indigo-500/30',
  telegram:    'bg-cyan-500/15 text-cyan-400 border-cyan-500/30',
  monitor:     'bg-amber-500/15 text-amber-400 border-amber-500/30',
  mcp_host:    'bg-violet-500/15 text-violet-400 border-violet-500/30',
  ci_agent:    'bg-rose-500/15 text-rose-400 border-rose-500/30',
  task_runner: 'bg-lime-500/15 text-lime-400 border-lime-500/30',
};

const POOL_LABELS: Record<Pool, string> = {
  browser: 'Browser',
  scraper: 'Scraper',
  rpa_desktop: 'Desktop RPA',
  discord: 'Discord',
  telegram: 'Telegram',
  trading: 'Trading',
  monitor: 'Monitor',
  mcp_host: 'MCP Host',
  ci_agent: 'CI Agent',
  task_runner: 'Task Runner',
  ai_agent: 'AI Agent',
};

export function PoolBadge({ pool, className }: { pool: Pool; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wide',
        POOL_COLORS[pool],
        className,
      )}
    >
      {POOL_LABELS[pool] ?? pool}
    </span>
  );
}
