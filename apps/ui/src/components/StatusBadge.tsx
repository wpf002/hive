import { cn } from '@/lib/cn';
import type { JobStatus } from '@/lib/types';

const STATUS: Record<JobStatus, string> = {
  queued:    'bg-amber-500/15 text-amber-400 border-amber-500/30',
  running:   'bg-burnt-500/15 text-burnt-500 border-burnt-500/30 animate-pulse',
  succeeded: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  failed:    'bg-red-500/15 text-red-400 border-red-500/30',
  cancelled: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30',
};

export function StatusBadge({ status, className }: { status: JobStatus; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wide',
        STATUS[status],
        className,
      )}
    >
      {status}
    </span>
  );
}
