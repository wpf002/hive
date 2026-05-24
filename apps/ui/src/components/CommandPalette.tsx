'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Command } from 'cmdk';
import { api } from '@/lib/api';
import type { Bot, Job } from '@/lib/types';

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const bots = useQuery<Bot[]>({
    queryKey: ['bots'],
    queryFn: () => api.get<Bot[]>('/api/bots'),
    enabled: open,
  });
  const jobs = useQuery<Job[]>({
    queryKey: ['jobs', 'recent'],
    queryFn: () => api.get<Job[]>('/api/jobs?limit=30'),
    enabled: open,
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!open) return null;

  async function runBot(botId: string) {
    try {
      const job = await api.post<Job>(`/api/bots/${botId}/run`, {});
      setOpen(false);
      router.push(`/jobs/${job.id}`);
    } catch (e) {
      console.error('run_failed', e);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-24"
      onClick={() => setOpen(false)}
    >
      <Command
        className="w-full max-w-lg rounded-lg border border-hive-border bg-hive-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        loop
      >
        <Command.Input
          autoFocus
          placeholder="Type a command or search…"
          className="w-full border-b border-hive-border bg-transparent px-4 py-3 text-sm outline-none placeholder:text-hive-subtle"
        />
        <Command.List className="max-h-80 overflow-auto p-2">
          <Command.Empty className="p-3 text-sm text-hive-subtle">No results.</Command.Empty>
          <Command.Group heading="Navigate" className="text-[10px] uppercase tracking-wide text-hive-subtle">
            <Command.Item onSelect={() => { setOpen(false); router.push('/dashboard'); }}>Dashboard</Command.Item>
            <Command.Item onSelect={() => { setOpen(false); router.push('/bots'); }}>Bots</Command.Item>
            <Command.Item onSelect={() => { setOpen(false); router.push('/templates'); }}>Templates</Command.Item>
            <Command.Item onSelect={() => { setOpen(false); router.push('/jobs'); }}>Jobs</Command.Item>
            <Command.Item onSelect={() => { setOpen(false); router.push('/workers'); }}>View Workers</Command.Item>
          </Command.Group>
          {bots.data && bots.data.length > 0 && (
            <Command.Group heading="Run bot…" className="text-[10px] uppercase tracking-wide text-hive-subtle">
              {bots.data.map((b) => (
                <Command.Item key={b.id} value={`run ${b.name}`} onSelect={() => runBot(b.id)}>
                  ▶ {b.name}
                </Command.Item>
              ))}
            </Command.Group>
          )}
          {jobs.data && jobs.data.length > 0 && (
            <Command.Group heading="Go to job…" className="text-[10px] uppercase tracking-wide text-hive-subtle">
              {jobs.data.slice(0, 10).map((j) => (
                <Command.Item
                  key={j.id}
                  value={`job ${j.id} ${j.status}`}
                  onSelect={() => { setOpen(false); router.push(`/jobs/${j.id}`); }}
                >
                  {j.status} — {j.id.slice(0, 8)} — {j.bot?.name ?? j.botId.slice(0, 8)}
                </Command.Item>
              ))}
            </Command.Group>
          )}
        </Command.List>
      </Command>
    </div>
  );
}
