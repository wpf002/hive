'use client';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { NAV } from '@/lib/nav';

/**
 * Mobile navigation: a hamburger button (visible only below `md`) that opens a
 * slide-over drawer with the same nav as the desktop Sidebar. The desktop
 * Sidebar is `hidden md:flex`, so exactly one is shown at any width.
 */
export function MobileNav() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Close the drawer whenever the route changes (after tapping a link).
  useEffect(() => { setOpen(false); }, [pathname]);

  // Prevent background scroll while the drawer is open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  return (
    <div className="md:hidden">
      <button
        onClick={() => setOpen(true)}
        className="rounded p-1.5 text-hive-subtle hover:bg-hive-muted hover:text-hive-text"
        aria-label="Open navigation"
      >
        <Menu className="h-5 w-5" />
      </button>

      {open && (
        <div className="fixed inset-0 z-50 md:hidden">
          {/* backdrop */}
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          {/* drawer */}
          <aside className="absolute left-0 top-0 flex h-full w-64 max-w-[80%] flex-col border-r border-hive-border bg-hive-surface">
            <div className="flex h-12 items-center justify-between border-b border-hive-border px-3">
              <span className="font-mono text-sm font-bold text-honey-500">HIVE</span>
              <button
                onClick={() => setOpen(false)}
                className="rounded p-1 text-hive-subtle hover:bg-hive-muted hover:text-hive-text"
                aria-label="Close navigation"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <nav className="flex-1 space-y-1 overflow-y-auto p-2">
              {NAV.map((item, i) => {
                const Icon = item.icon;
                const active = pathname?.startsWith(item.href);
                // Hairline divider at each lifecycle-group boundary.
                const newGroup = i > 0 && NAV[i - 1].group !== item.group;
                return (
                  <div key={item.href}>
                    {newGroup && <div className="mx-3 my-1.5 border-t border-hive-border" aria-hidden />}
                    <Link href={item.href} onClick={() => setOpen(false)}>
                      <div
                        className={cn(
                          'flex items-center gap-3 rounded px-3 py-2.5 text-sm transition-colors',
                          active
                            ? 'bg-honey-500/10 text-honey-500'
                            : 'text-hive-subtle hover:bg-hive-muted hover:text-hive-text',
                        )}
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        <span className="flex-1 truncate">{item.label}</span>
                      </div>
                    </Link>
                  </div>
                );
              })}
            </nav>
          </aside>
        </div>
      )}
    </div>
  );
}
