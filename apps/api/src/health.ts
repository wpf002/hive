import type { FastifyInstance } from 'fastify';
import { prisma } from '@hive/db';
import { createHealthz, type HealthChecks } from '@hive/shared';
import { redis } from './redis.js';
import { env } from './env.js';

const startedAt = Date.now();

export function registerHealth(app: FastifyInstance) {
  app.get('/api/sysinfo', async () => ({
    tradingLiveEnabled: env.TRADING_LIVE_ENABLED === 'true',
    signupsEnabled: process.env.SIGNUPS_ENABLED === 'true',
    nodeEnv: env.NODE_ENV,
    // Phase 5c: optional human-readable environment tag. UI renders this as a
    // colored pill in the top bar so an operator can see at a glance whether
    // they're looking at staging vs production.
    envLabel: process.env.HIVE_ENV_LABEL ?? null,
  }));

  const healthz = createHealthz({
    service: 'api',
    startedAt,
    checkFn: async (): Promise<HealthChecks> => {
      const checks: HealthChecks = { service: { ok: true } };
      try {
        await prisma.$queryRaw`SELECT 1`;
        checks.postgres = { ok: true };
      } catch (e) {
        checks.postgres = { ok: false, error: (e as Error).message };
      }
      try {
        const pong = await redis.ping();
        checks.redis = { ok: pong === 'PONG' };
      } catch (e) {
        checks.redis = { ok: false, error: (e as Error).message };
      }
      return checks;
    },
  });

  app.get('/healthz', async (req, reply) => {
    const r = await healthz(req.headers['if-none-match']);
    reply.header('ETag', r.etag);
    reply.header('Cache-Control', 'public, max-age=5');
    if (r.notModified) return reply.code(304).send();
    return reply.code(r.code).send(r.body);
  });
}
