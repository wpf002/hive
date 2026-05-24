'use client';
import { useEffect, useRef, useState } from 'react';
import { api, streamUrl } from '@/lib/api';
import { cn } from '@/lib/cn';

type Line = {
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  meta?: Record<string, unknown> | null;
};

const LEVEL_COLOR: Record<Line['level'], string> = {
  debug: 'text-hive-subtle',
  info: 'text-hive-text',
  warn: 'text-amber-400',
  error: 'text-red-400',
};

function fmtTs(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function parseSse(buf: string): { events: Array<{ event: string; data: string }>; rest: string } {
  const events: Array<{ event: string; data: string }> = [];
  let rest = buf;
  while (true) {
    const idx = rest.indexOf('\n\n');
    if (idx < 0) break;
    const block = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    let event = 'message';
    let data = '';
    for (const raw of block.split('\n')) {
      if (raw.startsWith(':')) continue;
      if (raw.startsWith('event:')) event = raw.slice(6).trim();
      else if (raw.startsWith('data:')) data += (data ? '\n' : '') + raw.slice(5).trimStart();
    }
    events.push({ event, data });
  }
  return { events, rest };
}

export function LiveLogStream({ jobId }: { jobId: string }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    (async () => {
      try {
        const res = await fetch(streamUrl(jobId), {
          headers: { Authorization: `Bearer ${api.token}`, Accept: 'text/event-stream' },
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) {
          setError(`stream failed: HTTP ${res.status}`);
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (!cancelled) {
          const { value, done: rdDone } = await reader.read();
          if (rdDone) break;
          buf += decoder.decode(value, { stream: true });
          const { events, rest } = parseSse(buf);
          buf = rest;
          for (const ev of events) {
            if (ev.event === 'log') {
              try {
                const parsed = JSON.parse(ev.data) as Line;
                setLines((prev) => [...prev, parsed]);
              } catch { /* ignore bad frame */ }
            } else if (ev.event === 'done') {
              try {
                const { status } = JSON.parse(ev.data);
                setDone(status);
              } catch { setDone('done'); }
            }
          }
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => { cancelled = true; ctrl.abort(); };
  }, [jobId]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines.length, done]);

  return (
    <div className="rounded border border-hive-border bg-black/60">
      <div className="flex items-center justify-between border-b border-hive-border px-3 py-1.5">
        <span className="font-mono text-xs text-hive-subtle">live logs · {lines.length} lines</span>
        {done && (
          <span className={cn(
            'rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase',
            done === 'succeeded' ? 'border-emerald-500/30 text-emerald-400' :
            done === 'failed' ? 'border-red-500/30 text-red-400' :
            'border-zinc-500/30 text-zinc-400',
          )}>{done}</span>
        )}
      </div>
      <div ref={scrollRef} className="h-96 overflow-auto p-2 font-mono text-[12px] leading-5">
        {error && <div className="text-red-400">error: {error}</div>}
        {lines.length === 0 && !error && (
          <div className="text-hive-subtle">waiting for logs…</div>
        )}
        {lines.map((l, i) => (
          <div key={i} className={cn('whitespace-pre-wrap', LEVEL_COLOR[l.level])}>
            <span className="text-hive-subtle">{fmtTs(l.ts)}</span>{' '}
            <span className="uppercase opacity-60">[{l.level}]</span>{' '}
            {l.message}
            {l.meta && Object.keys(l.meta).length > 0 && (
              <span className="text-hive-subtle"> {JSON.stringify(l.meta)}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
