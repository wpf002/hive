'use client';
import { useEffect, useState } from 'react';
import { fetchMe, type AuthedUser } from './auth';

/**
 * Current authenticated user, fetched once on mount. `isAdmin` gates UI
 * controls that map to admin-only API routes (running bots, creating/editing
 * bots and schedules) so non-admins don't see buttons that would 403.
 * Static-token sessions count as admin (the server treats them as such).
 */
export function useMe(): { user: AuthedUser | null; loading: boolean; isAdmin: boolean } {
  const [user, setUser] = useState<AuthedUser | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    fetchMe().then((u) => {
      if (active) {
        setUser(u);
        setLoading(false);
      }
    });
    return () => {
      active = false;
    };
  }, []);
  return { user, loading, isAdmin: user?.role === 'admin' || user?.static === true };
}
