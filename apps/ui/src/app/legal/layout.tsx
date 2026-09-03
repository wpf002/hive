import type { ReactNode } from 'react';
import Link from 'next/link';
import { BeeMark } from '@/components/BeeMark';

/**
 * Public, unauthenticated: these have to be readable by someone deciding
 * whether to sign up, which is before they have an account.
 */
export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-hive-bg">
      <header className="border-b border-hive-border px-4 py-3">
        <Link href="/" className="flex items-center gap-2 text-honey-500 hover:text-honey-400">
          <BeeMark size={18} />
          <span className="font-mono text-sm font-bold">HIVE</span>
        </Link>
      </header>
      <main className="mx-auto max-w-2xl px-4 py-10 text-sm leading-relaxed text-hive-text">
        {children}
      </main>
      <footer className="mx-auto max-w-2xl px-4 pb-10">
        <nav className="flex gap-4 font-mono text-[11px] uppercase tracking-[0.1em] text-hive-subtle">
          <Link href="/legal/terms" className="hover:text-honey-500">Terms</Link>
          <Link href="/legal/privacy" className="hover:text-honey-500">Privacy</Link>
        </nav>
      </footer>
    </div>
  );
}
