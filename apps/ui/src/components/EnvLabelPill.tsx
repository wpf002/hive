// Phase 5c: surface the deployed environment name (e.g. 'staging', 'production')
// in the top bar so an operator can tell at a glance which env they're driving.
// Set HIVE_ENV_LABEL on the API host; rendered only when present.
const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:4000';

function colorFor(label: string): string {
  const l = label.toLowerCase();
  if (l.includes('prod')) return 'border-red-500/40 bg-red-500/15 text-red-300';
  if (l.includes('stag')) return 'border-amber-500/40 bg-amber-500/15 text-amber-300';
  if (l.includes('dev')) return 'border-sky-500/40 bg-sky-500/15 text-sky-300';
  return 'border-zinc-500/40 bg-zinc-500/15 text-zinc-300';
}

export async function EnvLabelPill() {
  let label: string | null = null;
  try {
    const r = await fetch(`${API_BASE}/api/sysinfo`, { cache: 'no-store' });
    if (r.ok) {
      const j = (await r.json()) as { envLabel?: string | null };
      label = j.envLabel ?? null;
    }
  } catch {
    // API unreachable — render nothing rather than blocking the layout.
  }
  if (!label) return null;
  return (
    <span
      className={`mr-3 rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide ${colorFor(label)}`}
      title={`HIVE_ENV_LABEL=${label}`}
    >
      {label}
    </span>
  );
}
