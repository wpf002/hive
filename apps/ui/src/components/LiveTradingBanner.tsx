// Server component — banner is fetched at request time on the server. JS can't
// flip it off because the markup is already rendered before hydration runs.
const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:4000';

export async function LiveTradingBanner() {
  let enabled = false;
  try {
    const r = await fetch(`${API_BASE}/api/sysinfo`, { cache: 'no-store' });
    if (r.ok) {
      const j = (await r.json()) as { tradingLiveEnabled?: boolean };
      enabled = !!j.tradingLiveEnabled;
    }
  } catch {
    // API unreachable at SSR time — leave banner off rather than block render.
  }
  if (!enabled) return null;
  return (
    <div className="border-b-2 border-red-500/60 bg-red-500/20 px-4 py-2 text-center font-mono text-xs font-bold uppercase text-red-300">
      ⚠️ TRADING LIVE MODE ENABLED — orders will hit real exchanges
    </div>
  );
}
