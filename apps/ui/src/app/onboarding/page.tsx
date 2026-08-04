'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';

type Vertical = 'ecommerce' | 'recruiting' | 'agency' | 'trading';

const VERTICALS: { id: Vertical; label: string; emoji: string; description: string; urlLabel?: string; keywordLabel?: string }[] = [
  {
    id: 'ecommerce',
    label: 'E-commerce',
    emoji: '🛒',
    description: 'Monitor your store uptime, SSL expiry, and screenshot competitor pages daily.',
    urlLabel: 'Your store or competitor URL',
  },
  {
    id: 'recruiting',
    label: 'Recruiting',
    emoji: '🧑‍💼',
    description: 'Track job boards, careers pages, and get daily market trend briefs.',
    urlLabel: 'Job board or careers page URL',
    keywordLabel: 'Role to research (e.g. "senior frontend engineer")',
  },
  {
    id: 'agency',
    label: 'Agency',
    emoji: '🏢',
    description: "Monitor a client's site uptime, SSL, and daily homepage screenshots.",
    urlLabel: "Client site URL",
  },
  {
    id: 'trading',
    label: 'Trading',
    emoji: '📈',
    description: 'Daily portfolio snapshots, spread monitoring, and crypto market news.',
    keywordLabel: 'Coin or topic to research (e.g. "Bitcoin")',
  },
];

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState<'pick' | 'configure' | 'done'>('pick');
  const [vertical, setVertical] = useState<Vertical | null>(null);
  const [siteUrl, setSiteUrl] = useState('');
  const [keyword, setKeyword] = useState('');
  const [alertEmail, setAlertEmail] = useState('');
  const [slackWebhook, setSlackWebhook] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ botsCreated: { botName: string }[] } | null>(null);

  const selected = VERTICALS.find((v) => v.id === vertical);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!vertical) return;
    setError(null);
    setBusy(true);
    try {
      const data = await api.post('/api/onboarding', {
        vertical,
        ...(siteUrl ? { siteUrl } : {}),
        ...(keyword ? { keyword } : {}),
        ...(alertEmail ? { email: alertEmail } : {}),
        ...(slackWebhook ? { slackWebhookUrl: slackWebhook } : {}),
      });
      setResult(data as { botsCreated: { botName: string }[] });
      setStep('done');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-hive-bg bg-hex-grid p-4">
      <div className="w-full max-w-lg space-y-6 rounded-lg border border-hive-border bg-hive-surface p-8 shadow-xl">
        <div className="text-center">
          <h1 className="font-mono text-xl font-bold text-honey-500">Welcome to Hive 🐝</h1>
          <p className="mt-1 font-mono text-xs text-hive-subtle">
            {step === 'pick' && "What are you monitoring? We'll set up your first bots automatically."}
            {step === 'configure' && `Configure your ${selected?.label} starter pack`}
            {step === 'done' && 'Your fleet is ready'}
          </p>
        </div>

        {step === 'pick' && (
          <div className="grid grid-cols-2 gap-3">
            {VERTICALS.map((v) => (
              <button
                key={v.id}
                onClick={() => { setVertical(v.id); setStep('configure'); }}
                className="flex flex-col items-start gap-1 rounded-lg border border-hive-border bg-hive-bg p-4 text-left hover:border-honey-500/60 hover:bg-hive-surface transition-colors"
              >
                <span className="text-2xl">{v.emoji}</span>
                <span className="font-mono text-sm font-semibold text-hive-text">{v.label}</span>
                <span className="font-mono text-[11px] text-hive-subtle">{v.description}</span>
              </button>
            ))}
          </div>
        )}

        {step === 'configure' && selected && (
          <form onSubmit={submit} className="space-y-4">
            <div className="rounded border border-honey-500/20 bg-honey-500/5 p-3 font-mono text-xs text-hive-subtle">
              {selected.emoji} <strong className="text-hive-text">{selected.label}</strong> — {selected.description}
            </div>

            {selected.urlLabel && (
              <label className="block">
                <span className="font-mono text-[11px] uppercase text-hive-subtle">{selected.urlLabel}</span>
                <input type="url" value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)}
                  placeholder="https://example.com"
                  className="mt-1 w-full rounded border border-hive-border bg-hive-bg px-2 py-1.5 font-mono text-sm" />
              </label>
            )}
            {selected.keywordLabel && (
              <label className="block">
                <span className="font-mono text-[11px] uppercase text-hive-subtle">{selected.keywordLabel}</span>
                <input type="text" value={keyword} onChange={(e) => setKeyword(e.target.value)}
                  className="mt-1 w-full rounded border border-hive-border bg-hive-bg px-2 py-1.5 font-mono text-sm" />
              </label>
            )}

            <div className="border-t border-hive-border pt-4">
              <p className="mb-2 font-mono text-[11px] uppercase text-hive-subtle">Alert me when a bot fails (optional)</p>
              <label className="block">
                <span className="font-mono text-[11px] text-hive-subtle">Email</span>
                <input type="email" value={alertEmail} onChange={(e) => setAlertEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="mt-1 w-full rounded border border-hive-border bg-hive-bg px-2 py-1.5 font-mono text-sm" />
              </label>
              <label className="mt-2 block">
                <span className="font-mono text-[11px] text-hive-subtle">Slack webhook URL</span>
                <input type="url" value={slackWebhook} onChange={(e) => setSlackWebhook(e.target.value)}
                  placeholder="https://hooks.slack.com/services/..."
                  className="mt-1 w-full rounded border border-hive-border bg-hive-bg px-2 py-1.5 font-mono text-sm" />
              </label>
            </div>

            {error && (
              <div className="rounded border border-red-500/40 bg-red-500/10 p-2 font-mono text-xs text-red-300">{error}</div>
            )}

            <div className="flex gap-2">
              <button type="button" onClick={() => setStep('pick')}
                className="rounded border border-hive-border px-3 py-2 font-mono text-sm text-hive-subtle hover:text-hive-text">
                ← Back
              </button>
              <button type="submit" disabled={busy}
                className="flex-1 rounded bg-honey-500 px-3 py-2 font-semibold text-black hover:bg-honey-400 disabled:opacity-60">
                {busy ? 'Setting up your fleet…' : 'Launch my fleet →'}
              </button>
            </div>
          </form>
        )}

        {step === 'done' && result && (
          <div className="space-y-4">
            <div className="rounded-lg border border-green-500/30 bg-green-500/10 p-4">
              <p className="font-mono text-sm font-semibold text-green-400">
                ✓ {result.botsCreated.length} bots created and scheduled
              </p>
              <ul className="mt-2 space-y-1">
                {result.botsCreated.map((b) => (
                  <li key={b.botName} className="font-mono text-xs text-hive-subtle">• {b.botName}</li>
                ))}
              </ul>
            </div>
            <p className="font-mono text-xs text-hive-subtle">
              Your bots run daily at 7:30 AM ET. You&apos;ll get a digest email at 8:00 AM ET with results.
            </p>
            <button onClick={() => router.push('/dashboard')}
              className="w-full rounded bg-honey-500 px-3 py-2 font-semibold text-black hover:bg-honey-400">
              Go to dashboard →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
