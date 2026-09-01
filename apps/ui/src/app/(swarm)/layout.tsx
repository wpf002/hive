import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

const SESSION_COOKIE = 'hive_session';
const API_BASE =
  process.env.API_PROXY_TARGET || process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:4000';

async function checkAuth(): Promise<boolean> {
  const session = cookies().get(SESSION_COOKIE)?.value;
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

/**
 * No shell. The console is the app, so there is no sidebar to navigate and no
 * top bar to look at — the screen is the swarm and one line to talk to it.
 */
export default async function SwarmLayout({ children }: { children: ReactNode }) {
  if (!(await checkAuth())) redirect('/login');
  return <>{children}</>;
}
