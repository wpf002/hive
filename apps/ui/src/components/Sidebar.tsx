'use client';
import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu } from 'lucide-react';
import { cn } from '@/lib/cn';
import { NAV } from '@/lib/nav';

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const pathname = usePathname();
  return (
    // Desktop only — on small screens the MobileNav slide-over replaces this.
    <aside className={cn(
      'hidden flex-col border-r border-hive-border bg-hive-surface transition-all md:flex',
      collapsed ? 'w-14' : 'w-56',
    )}>
      <div className="flex h-12 items-center gap-2 border-b border-hive-border px-3">
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="rounded p-1 text-hive-subtle hover:bg-hive-muted hover:text-hive-text"
          aria-label="Toggle sidebar"
        >
          <Menu className="h-4 w-4" />
        </button>
        {!collapsed && (
          <span className="font-mono text-sm font-bold text-honey-500">HIVE</span>
        )}
      </div>
      <nav className="flex-1 space-y-1 p-2">
        {NAV.map((item) => {
          const Icon = item.icon;
          const active = pathname?.startsWith(item.href);
          return (
            <Link key={item.href} href={item.href}>
              <div
                className={cn(
                  'flex items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors',
                  active
                    ? 'bg-honey-500/10 text-honey-500'
                    : 'text-hive-subtle hover:bg-hive-muted hover:text-hive-text',
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {!collapsed && <span className="flex-1 truncate">{item.label}</span>}
              </div>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
