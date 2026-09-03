import type { ReactNode } from 'react';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { BeeMark } from '@/components/BeeMark';

/**
 * Account settings, for everyone who has an account.
 *
 * Its own route group because the operator console next door is admin-only
 * now, and a customer still has to be able to change their password. Sharing
 * that layout would have meant either letting customers into the machinery or
 * locking them out of their own settings.
 *
 * Deliberately shell-less — no sidebar, no command palette. This is somewhere
 * you arrive from the console, do one thing, and leave.
 */

const SESSION_COOKIE = 'hive_session';
const API_BASE =
  process.env.API_PROXY_TARGET || process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:4000';

async function authed(): Promise<boolean> {
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

export default async function AccountLayout({ children }: { children: ReactNode }) {
  if (!(await authed())) redirect('/login');
  return (
    <div className="flex min-h-screen flex-col bg-hive-bg">
      <header className="flex shrink-0 items-center gap-3 border-b border-hive-border px-4 py-2.5">
        <Link
          href="/"
          className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.1em] text-hive-subtle transition-colors hover:text-honey-500"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          <BeeMark className="h-4 w-4" />
          <span>Back to swarm</span>
        </Link>
      </header>
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
}
