'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/api';
import { fetchMe, type AuthedUser } from '@/lib/auth';
import { cn } from '@/lib/cn';

export function UserMenu() {
  const router = useRouter();
  const [user, setUser] = useState<AuthedUser | null>(null);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchMe().then(setUser);
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, []);

  async function logout() {
    try {
      await api.post('/api/auth/logout');
    } catch { /* ignore */ }
    router.push('/login');
    router.refresh();
  }

  if (!user) {
    return (
      <Link href="/login" className="font-mono text-xs text-honey-500 hover:underline">
        Sign in
      </Link>
    );
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded border border-hive-border bg-hive-surface px-2 py-1 font-mono text-[11px] hover:border-honey-500/40"
      >
        <span className="text-hive-text">{user.displayName}</span>
        <span className={cn(
          'rounded border px-1 text-[9px] uppercase',
          user.role === 'admin'
            ? 'border-honey-500/50 text-honey-500'
            : 'border-hive-border text-hive-subtle',
        )}>{user.role}</span>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-52 rounded border border-hive-border bg-hive-surface shadow-xl">
          <div className="border-b border-hive-border px-3 py-2 font-mono text-[10px] uppercase text-hive-subtle">
            {user.email}
          </div>
          {user.role === 'admin' && (
            <Link
              href="/admin/users"
              onClick={() => setOpen(false)}
              className="block px-3 py-1.5 font-mono text-xs hover:bg-hive-muted"
            >
              Admin · Users
            </Link>
          )}
          <Link
            href="/account/password"
            onClick={() => setOpen(false)}
            className="block px-3 py-1.5 font-mono text-xs hover:bg-hive-muted"
          >
            Change password
          </Link>
          <button
            onClick={logout}
            className="block w-full px-3 py-1.5 text-left font-mono text-xs text-red-400 hover:bg-red-500/10"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
