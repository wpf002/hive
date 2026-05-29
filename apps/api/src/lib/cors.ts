import { env } from '../env.js';

// Browser origins permitted to make credentialed (cookie-bearing) requests.
// Because we send credentials, we must NEVER reflect an arbitrary Origin — that
// would let any website read authenticated responses. The allowlist is built
// from HIVE_PUBLIC_APP_URL + HIVE_CORS_ORIGINS, plus localhost in development.
function normalize(origin: string): string {
  return origin.trim().replace(/\/$/, '');
}

const allowed = new Set<string>();
allowed.add(normalize(env.HIVE_PUBLIC_APP_URL));
for (const extra of (env.HIVE_CORS_ORIGINS ?? '').split(',')) {
  const o = normalize(extra);
  if (o) allowed.add(o);
}
if (env.NODE_ENV !== 'production') {
  // Convenience for local dev across the usual UI/API ports.
  for (const port of ['3000', '3001', '4000']) {
    allowed.add(`http://localhost:${port}`);
    allowed.add(`http://127.0.0.1:${port}`);
  }
}

/**
 * True when the given Origin header value may receive a credentialed CORS
 * response. A missing origin (same-origin navigations, server-to-server, curl)
 * is allowed — those requests are not subject to the browser SOP.
 */
export function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  return allowed.has(normalize(origin));
}

export const allowedOrigins = (): string[] => [...allowed];
