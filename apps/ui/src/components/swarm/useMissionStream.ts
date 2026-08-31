'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { MissionSnapshot } from '@/lib/mission-types';

/**
 * Subscribes to the mission's SSE stream. The server sends a full snapshot each
 * tick rather than deltas, so a dropped message can never leave the terminal
 * showing a stale approval countdown.
 */
export function useMissionStream(missionId: string) {
  const [snapshot, setSnapshot] = useState<MissionSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Keeps the last good snapshot visible across a reconnect.
  const lastGood = useRef<MissionSnapshot | null>(null);

  useEffect(() => {
    // EventSource sends cookies same-origin, which is how the rest of the UI
    // authenticates (see lib/api.ts — no bearer token in the bundle).
    const es = new EventSource(`${api.base}/api/missions/${missionId}/stream`, {
      withCredentials: true,
    });

    es.addEventListener('open', () => {
      setConnected(true);
      setError(null);
    });

    es.addEventListener('snapshot', (e) => {
      try {
        const next = JSON.parse((e as MessageEvent).data) as MissionSnapshot;
        lastGood.current = next;
        setSnapshot(next);
        setConnected(true);
      } catch {
        /* a malformed frame shouldn't blank the terminal */
      }
    });

    es.addEventListener('gone', () => {
      // Clear the last snapshot too. Keeping it would leave the terminal
      // rendering a deleted mission as though it were still live, with an
      // approval queue whose buttons can only 404.
      lastGood.current = null;
      setSnapshot(null);
      setConnected(false);
      setError('mission no longer exists');
      es.close();
    });

    es.addEventListener('error', () => {
      setConnected(false);
      // EventSource reconnects on its own; keep the last snapshot on screen.
      if (!lastGood.current) setError('cannot reach the mission stream');
    });

    return () => es.close();
  }, [missionId]);

  return { snapshot, connected, error };
}
