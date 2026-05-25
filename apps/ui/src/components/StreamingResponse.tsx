'use client';
import { useEffect, useRef, useState } from 'react';
import { api, streamUrl } from '@/lib/api';

interface Props {
  jobId: string;
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

export function StreamingResponse({ jobId }: Props) {
  const [text, setText] = useState('');
  const [done, setDone] = useState(false);
  const seenChunks = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    (async () => {
      try {
        const res = await fetch(streamUrl(jobId), {
          headers: { Authorization: `Bearer ${api.token}`, Accept: 'text/event-stream' },
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) return;
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
                const parsed = JSON.parse(ev.data) as { message?: string; meta?: { text?: string } | null };
                if (parsed?.message === 'ai.chunk' && parsed.meta?.text) {
                  seenChunks.current = true;
                  setText((t) => t + parsed.meta!.text!);
                }
              } catch { /* ignore */ }
            } else if (ev.event === 'done') {
              setDone(true);
            }
          }
        }
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; ctrl.abort(); };
  }, [jobId]);

  // Only render when chunks actually flowed (i.e. stream=true).
  if (!seenChunks.current && !text) return null;
  return (
    <div className="rounded border border-honey-500/40 bg-honey-500/5">
      <div className="flex items-center justify-between border-b border-honey-500/30 px-3 py-1.5">
        <span className="font-mono text-xs text-honey-500">
          {done ? 'Streamed response · complete' : 'Streamed response · receiving…'}
        </span>
        <span className="font-mono text-[10px] text-hive-subtle">{text.length} chars</span>
      </div>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap p-3 text-sm">{text || '…'}</pre>
    </div>
  );
}
