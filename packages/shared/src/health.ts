import { createHash } from 'node:crypto';

/**
 * Shared /healthz shape + 5s ETag cache (Phase 6c.2). Framework-agnostic so the
 * control-plane services and (via re-export) workers all return an identical
 * body. Each service supplies a `checkFn` that probes its own dependencies.
 */

export interface HealthCheck {
  ok: boolean;
  error?: string;
  [extra: string]: unknown;
}

export type HealthChecks = Record<string, HealthCheck>;

export interface HealthSnapshot {
  status: 'ok' | 'degraded';
  service: string;
  version: string;
  region: string;
  uptime_seconds: number;
  checks: HealthChecks;
}

export interface HealthzResult {
  /** 200 healthy, 503 degraded, 304 when the caller's If-None-Match matches. */
  code: 200 | 503 | 304;
  etag: string;
  body: HealthSnapshot | null; // null only when notModified
  notModified: boolean;
}

export function regionLabel(): string {
  return process.env.HIVE_WORKER_REGION ?? process.env.FLY_REGION ?? 'local';
}

export function versionLabel(): string {
  return process.env.HIVE_VERSION ?? process.env.FLY_IMAGE_REF ?? '0.1.0';
}

/**
 * Builds a healthz handler with a short result cache. External monitors poll
 * frequently (every 1 min, sometimes more); caching for `cacheMs` stops each
 * poll from hammering Postgres/Redis. The ETag is derived from status+checks
 * (not uptime) so it stays stable within the cache window and 304s work.
 */
export function createHealthz(opts: {
  service: string;
  startedAt: number;
  checkFn: () => Promise<HealthChecks>;
  cacheMs?: number;
}): (ifNoneMatch?: string | null) => Promise<HealthzResult> {
  const cacheMs = opts.cacheMs ?? 5000;
  let cached: { at: number; snap: HealthSnapshot; etag: string } | null = null;

  return async (ifNoneMatch?: string | null): Promise<HealthzResult> => {
    const now = Date.now();
    if (!cached || now - cached.at >= cacheMs) {
      let checks: HealthChecks;
      try {
        checks = await opts.checkFn();
      } catch (e) {
        checks = { service: { ok: false, error: (e as Error).message } };
      }
      const status: HealthSnapshot['status'] = Object.values(checks).every((c) => c.ok)
        ? 'ok'
        : 'degraded';
      const snap: HealthSnapshot = {
        status,
        service: opts.service,
        version: versionLabel(),
        region: regionLabel(),
        uptime_seconds: Math.floor((now - opts.startedAt) / 1000),
        checks,
      };
      const etag =
        '"' +
        createHash('sha1').update(JSON.stringify({ status, checks })).digest('hex').slice(0, 16) +
        '"';
      cached = { at: now, snap, etag };
    }

    if (ifNoneMatch && ifNoneMatch === cached.etag) {
      return { code: 304, etag: cached.etag, body: null, notModified: true };
    }
    return {
      code: cached.snap.status === 'ok' ? 200 : 503,
      etag: cached.etag,
      body: cached.snap,
      notModified: false,
    };
  };
}
