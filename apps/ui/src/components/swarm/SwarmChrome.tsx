'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';

/**
 * The one piece of chrome the console has: a corner menu.
 *
 * The console is deliberately shell-less — the screen is the swarm — but a
 * customer-facing product still has to let someone change their password and
 * sign out, and those cannot live behind an operator sidebar that customers
 * can no longer reach. A single unobtrusive control in the corner is the
 * smallest thing that does it without turning the page back into a dashboard.
 */
export function SwarmChrome({ isAdmin, children }: { isAdmin: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();

  // Close on an outside click or Escape — a menu that can only be dismissed by
  // choosing something from it is a trap.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function signOut() {
    try {
      await api.post('/api/auth/logout', {});
    } catch {
      // A failed logout call still means the person wants to leave; the cookie
      // is httpOnly so the only way out is the server, but sending them to the
      // login screen is better than stranding them on a dead menu.
    }
    router.push('/login');
    router.refresh();
  }

  const item =
    'block w-full px-3 py-1.5 text-left font-mono text-[11px] uppercase tracking-[0.1em] ' +
    'text-hive-subtle transition-colors hover:bg-hive-muted hover:text-hive-text';

  return (
    <div className="relative flex h-screen flex-col">
      {children}
      <div ref={ref} className="absolute right-3 top-2 z-20">
        <button
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Account menu"
          className={
            'rounded border border-hive-border px-2 py-1 font-mono text-[11px] uppercase ' +
            'tracking-[0.1em] text-hive-subtle transition-all duration-150 hover:text-honey-500 ' +
            'active:scale-[0.96] focus-visible:outline-none focus-visible:ring-1 ' +
            'focus-visible:ring-honey-500/70'
          }
        >
          Account
        </button>
        {open && (
          <div
            role="menu"
            className="absolute right-0 mt-1 w-44 overflow-hidden rounded border border-hive-border bg-hive-surface py-1 shadow-lg"
          >
            <Link href="/account/password" role="menuitem" className={item} onClick={() => setOpen(false)}>
              Change password
            </Link>
            <Link href="/account/alerts" role="menuitem" className={item} onClick={() => setOpen(false)}>
              Alerts
            </Link>
            {isAdmin && (
              <Link href="/dashboard" role="menuitem" className={item} onClick={() => setOpen(false)}>
                Operator console
              </Link>
            )}
            <button role="menuitem" onClick={signOut} className={item}>
              Sign out
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
