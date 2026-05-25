import type { FastifyInstance } from 'fastify';
import { prisma } from '@hive/db';
import { redis } from './redis.js';
import { env } from './env.js';

const startedAt = Date.now();

export function registerHealth(app: FastifyInstance) {
  app.get('/api/sysinfo', async () => ({
    tradingLiveEnabled: env.TRADING_LIVE_ENABLED === 'true',
    signupsEnabled: process.env.SIGNUPS_ENABLED === 'true',
    nodeEnv: env.NODE_ENV,
  }));

  app.get('/healthz', async () => {
    const checks: Record<string, { ok: boolean; error?: string }> = {
      postgres: { ok: true },
      redis: { ok: true },
      service: { ok: true },
    };

    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch (e) {
      checks.postgres = { ok: false, error: (e as Error).message };
    }
    try {
      const pong = await redis.ping();
      checks.redis = { ok: pong === 'PONG' };
    } catch (e) {
      checks.redis = { ok: false, error: (e as Error).message };
    }

    const allOk = Object.values(checks).every((c) => c.ok);
    return {
      status: allOk ? 'ok' : 'degraded',
      service: 'api',
      uptimeMs: Date.now() - startedAt,
      checks,
    };
  });
}
