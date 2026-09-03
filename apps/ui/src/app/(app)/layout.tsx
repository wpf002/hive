import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { Sidebar } from '@/components/Sidebar';
import { StatusBar } from '@/components/StatusBar';
import { CommandPalette } from '@/components/CommandPalette';
import { LiveTradingBanner } from '@/components/LiveTradingBanner';
import { TopBar } from '@/components/TopBar';

const SESSION_COOKIE = 'hive_session';
// Server-side calls need an absolute API URL (relative '' only works in the
// browser via the proxy). Prefer the server-only API_PROXY_TARGET.
const API_BASE =
  process.env.API_PROXY_TARGET || process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:4000';

/**
 * The operator console: bots, jobs, schedules, workers, templates, trading.
 *
 * Admin-only, because it is not the product. The product is the swarm console
 * at `/` — describe what you want watched and watch it happen. Everything in
 * here is the machinery underneath it, and a customer meeting eleven sidebar
 * items of machinery meets a tool rather than a thing that does a job.
 *
 * Kept rather than deleted: an operator debugging why a customer's feed stopped
 * needs the job log and the worker table, and rebuilding that surface later
 * would cost more than gating it now.
 */
async function currentUser(): Promise<{ role?: string } | null> {
  const cookieStore = cookies();
  const session = cookieStore.get(SESSION_COOKIE)?.value;
  if (!session) return null;
  try {
    const r = await fetch(`${API_BASE}/api/auth/me`, {
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
      cache: 'no-store',
    });
    if (!r.ok) return null;
    return (await r.json()) as { role?: string };
  } catch {
    return null;
  }
}

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  if (!user) redirect('/login');
  // To the console, not to an error: a signed-in customer landing here has not
  // done anything wrong, they have just followed a link meant for an operator.
  if (user.role !== 'admin') redirect('/');
  return (
    <div className="flex h-screen flex-col">
      <LiveTradingBanner />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar />
          <main className="flex-1 overflow-auto">{children}</main>
        </div>
      </div>
      <StatusBar />
      <CommandPalette />
    </div>
  );
}
