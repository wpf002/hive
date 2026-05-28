// Public status page (Phase 6c.3). No auth. Server-rendered, cached 30s.
const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:4000';

export const revalidate = 30;

interface StatusPayload {
  generatedAt: string;
  deploy: { sha: string; deployedAt: string | null };
  controlPlane: Array<{ name: string; status: string }>;
  pools: Array<{ pool: string; label: string; total: number; online: number; status: string }>;
  incidents: Array<{ id: string; createdAt: string; message: string }>;
}

function dotClass(status: string): string {
  switch (status) {
    case 'ok':
      return 'bg-emerald-400';
    case 'degraded':
      return 'bg-amber-400';
    case 'unreachable':
      return 'bg-red-500';
    default: // idle / unknown
      return 'bg-zinc-500';
  }
}

async function load(): Promise<StatusPayload | null> {
  try {
    const r = await fetch(`${API_BASE}/api/status`, { next: { revalidate: 30 } });
    if (!r.ok) return null;
    return (await r.json()) as StatusPayload;
  } catch {
    return null;
  }
}

export default async function StatusPage() {
  const data = await load();

  return (
    <div className="h-screen overflow-y-auto bg-hive-bg bg-hex-grid">
      <div className="mx-auto max-w-3xl space-y-8 p-6">
        <header className="flex items-center gap-3">
          <svg width="32" height="32" viewBox="0 0 24 24" aria-hidden className="text-honey-500">
            <path fill="currentColor" d="M12 2 21 7v10l-9 5-9-5V7l9-5Zm0 4.2L7 9.1v5.8l5 2.9 5-2.9V9.1l-5-2.9Z" />
          </svg>
          <div>
            <h1 className="font-mono text-xl font-bold text-honey-500">Hive Status</h1>
            <p className="font-mono text-[11px] text-hive-subtle">
              {data ? `Updated ${new Date(data.generatedAt).toLocaleString()}` : 'Status unavailable'}
            </p>
          </div>
        </header>

        {!data ? (
          <div className="rounded border border-red-500/40 bg-red-500/10 p-4 font-mono text-sm text-red-300">
            The API is unreachable. The platform may be down — check back shortly.
          </div>
        ) : (
          <>
            <section>
              <h2 className="mb-2 font-mono text-[11px] uppercase tracking-wide text-hive-subtle">
                Control plane
              </h2>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {data.controlPlane.map((s) => (
                  <div
                    key={s.name}
                    className="flex items-center gap-2 rounded border border-hive-border bg-hive-surface p-2"
                  >
                    <span className={`h-2.5 w-2.5 rounded-full ${dotClass(s.status)}`} />
                    <div className="min-w-0">
                      <div className="truncate font-mono text-xs text-hive-text">{s.name}</div>
                      <div className="font-mono text-[10px] text-hive-subtle">{s.status}</div>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section>
              <h2 className="mb-2 font-mono text-[11px] uppercase tracking-wide text-hive-subtle">
                Worker pools
              </h2>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {data.pools.map((p) => (
                  <div
                    key={p.pool}
                    className="flex items-center gap-2 rounded border border-hive-border bg-hive-surface p-2"
                  >
                    <span className={`h-2.5 w-2.5 rounded-full ${dotClass(p.status)}`} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-xs text-hive-text">{p.label}</div>
                      <div className="font-mono text-[10px] text-hive-subtle">
                        {p.online}/{p.total} online
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section>
              <h2 className="mb-2 font-mono text-[11px] uppercase tracking-wide text-hive-subtle">
                Incidents (last 24h)
              </h2>
              {data.incidents.length === 0 ? (
                <p className="font-mono text-xs text-hive-subtle">No incidents reported. ✓</p>
              ) : (
                <ul className="space-y-1">
                  {data.incidents.map((i) => (
                    <li
                      key={i.id}
                      className="rounded border border-amber-500/30 bg-amber-500/5 p-2 font-mono text-xs text-hive-text"
                    >
                      <span className="text-hive-subtle">
                        {new Date(i.createdAt).toLocaleString()} —{' '}
                      </span>
                      {i.message}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <footer className="border-t border-hive-border pt-3 font-mono text-[10px] text-hive-subtle">
              Deploy {data.deploy.sha}
              {data.deploy.deployedAt ? ` · ${new Date(data.deploy.deployedAt).toLocaleString()}` : ''}
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
