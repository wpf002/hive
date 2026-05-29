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

async function checkAuth(): Promise<boolean> {
  const cookieStore = cookies();
  const session = cookieStore.get(SESSION_COOKIE)?.value;
  if (!session) return false;
  try {
    const r = await fetch(`${API_BASE}/api/auth/me`, {
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
      cache: 'no-store',
    });
    return r.ok;
  } catch {
    return false;
  }
}

export default async function AppLayout({ children }: { children: ReactNode }) {
  const ok = await checkAuth();
  if (!ok) redirect('/login');
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
