import { createServer, type Server } from 'node:http';
import type { Redis } from 'ioredis';
import { createHealthz, type HealthChecks } from '@hive/shared';
import type { Heartbeat } from './heartbeat.js';

const HEARTBEAT_FRESH_MS = 30_000;

/**
 * Optional lightweight /healthz HTTP server for a worker (Phase 6c.2). Enabled
 * only when HIVE_WORKER_HEALTHZ_PORT is set — workers are stream consumers, not
 * HTTP services, so this is opt-in and doesn't change default behavior. Reports
 * the same JSON shape as the control-plane services: heartbeat freshness +
 * redis reachability.
 */
export function startWorkerHealthz(opts: {
  port: number;
  poolType: string;
  startedAt: number;
  heartbeat: Heartbeat;
  getRedis: () => Redis | undefined;
}): Server {
  const healthz = createHealthz({
    service: `worker-${opts.poolType}`,
    startedAt: opts.startedAt,
    checkFn: async (): Promise<HealthChecks> => {
      const checks: HealthChecks = { service: { ok: true } };
      const last = opts.heartbeat.getLastSuccessAt();
      const ageMs = last === 0 ? Infinity : Date.now() - last;
      checks.heartbeat = {
        ok: last > 0 && ageMs < HEARTBEAT_FRESH_MS,
        ageSeconds: ageMs === Infinity ? null : Math.floor(ageMs / 1000),
      };
      try {
        const pong = await opts.getRedis()?.ping();
        checks.redis = { ok: pong === 'PONG' };
      } catch (e) {
        checks.redis = { ok: false, error: (e as Error).message };
      }
      return checks;
    },
  });

  const server = createServer((req, res) => {
    if (!req.url || !req.url.startsWith('/healthz')) {
      res.writeHead(404).end();
      return;
    }
    void healthz(req.headers['if-none-match'] ?? null)
      .then((out) => {
        res.setHeader('ETag', out.etag);
        res.setHeader('Cache-Control', 'public, max-age=5');
        if (out.notModified) {
          res.writeHead(304).end();
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(out.code).end(JSON.stringify(out.body));
      })
      .catch(() => {
        res.writeHead(500).end();
      });
  });
  server.listen(opts.port, '0.0.0.0');
  return server;
}
