'use client';
import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { BeeMark } from '@/components/BeeMark';

/**
 * Where a verification link lands.
 *
 * Deliberately not behind the session guard: people click these from a mail
 * client that has no session, and asking them to sign in first is how a
 * verification flow gets abandoned halfway.
 */
function Verify() {
  const token = useSearchParams().get('token');
  const [state, setState] = useState<'working' | 'done' | 'failed'>('working');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!token) {
      setState('failed');
      setMessage('That link is missing its token. Try the one in your email again.');
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        await api.post('/api/auth/verify-email', { token });
        if (!cancelled) setState('done');
      } catch (err) {
        if (cancelled) return;
        setState('failed');
        setMessage((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 px-4 text-center">
      <BeeMark size={40} className="mx-auto text-honey-500" />
      {state === 'working' && (
        <p className="font-mono text-sm uppercase tracking-[0.1em] text-hive-subtle">
          Confirming your email…
        </p>
      )}
      {state === 'done' && (
        <>
          <h1 className="font-mono text-sm uppercase tracking-[0.1em] text-honey-500">
            Email confirmed
          </h1>
          <p className="font-mono text-xs leading-relaxed text-hive-subtle">
            Spend warnings and alerts about your swarm will reach you here.
          </p>
          <Link
            href="/"
            className="mx-auto rounded bg-honey-500 px-4 py-2 font-mono text-xs font-semibold uppercase tracking-[0.1em] text-black transition-colors hover:bg-honey-400"
          >
            Go to the console
          </Link>
        </>
      )}
      {state === 'failed' && (
        <>
          <h1 className="font-mono text-sm uppercase tracking-[0.1em] text-red-400">
            That link did not work
          </h1>
          <p className="font-mono text-xs leading-relaxed text-hive-subtle">{message}</p>
          <p className="font-mono text-xs leading-relaxed text-hive-subtle">
            Sign in and ask for a new one from your account menu.
          </p>
          <Link
            href="/login"
            className="mx-auto rounded border border-hive-border px-4 py-2 font-mono text-xs uppercase tracking-[0.1em] text-hive-subtle transition-colors hover:text-honey-500"
          >
            Sign in
          </Link>
        </>
      )}
    </div>
  );
}

export default function VerifyEmailPage() {
  // useSearchParams needs a Suspense boundary in the app router.
  return (
    <Suspense fallback={null}>
      <Verify />
    </Suspense>
  );
}
