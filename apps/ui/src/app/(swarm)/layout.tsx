import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SwarmChrome } from '@/components/swarm/SwarmChrome';

const SESSION_COOKIE = 'hive_session';
const API_BASE =
  process.env.API_PROXY_TARGET || process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:4000';

async function currentUser(): Promise<{ role?: string } | null> {
  const session = cookies().get(SESSION_COOKIE)?.value;
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

/**
 * No shell. The console is the app, so there is no sidebar to navigate and no
 * top bar to look at — the screen is the swarm and one line to talk to it.
 */
export default async function SwarmLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  if (!user) redirect('/login');
  // Resolved here rather than fetched again in the client: the layout already
  // has to ask who this is to guard the route, and asking twice would put a
  // second round trip in front of the first paint.
  return <SwarmChrome isAdmin={user.role === 'admin'}>{children}</SwarmChrome>;
}
