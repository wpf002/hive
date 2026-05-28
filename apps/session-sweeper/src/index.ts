/**
 * Session sweeper — periodically DELETEs expired Session rows.
 *
 * Sessions are also lazy-expired on read (findValidSession), so this is purely
 * a housekeeping process: it stops the table from growing forever when users
 * close laptops without logging out.
 */
import Fastify from 'fastify';
import type { LoggerOptions } from 'pino';
import { prisma } from '@hive/db';
import { env } from './env.js';
import { startAuditAlerts } from './audit-alerts.js';

const loggerOptions: LoggerOptions = {
  level: env.LOG_LEVEL,
  base: { service: 'session-sweeper' },
  ...(env.NODE_ENV === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
        },
      }
    : {}),
};

const app = Fastify({ logger: loggerOptions });
const startedAt = Date.now();

interface SweepRecord {
  lastSweepAt: string | null;
  lastDeletedCount: number;
  totalDeleted: number;
  sweepCount: number;
}

const state: SweepRecord = {
  lastSweepAt: null,
  lastDeletedCount: 0,
  totalDeleted: 0,
  sweepCount: 0,
};

app.get('/healthz', async () => ({
  status: 'ok',
  service: 'session-sweeper',
  uptimeMs: Date.now() - startedAt,
  intervalSeconds: env.SESSION_SWEEP_INTERVAL_S,
  ...state,
}));

async function sweep(): Promise<void> {
  try {
    const res = await prisma.session.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    state.lastSweepAt = new Date().toISOString();
    state.lastDeletedCount = res.count;
    state.totalDeleted += res.count;
    state.sweepCount += 1;
    if (res.count > 0) {
      app.log.info({ deleted: res.count, total: state.totalDeleted }, 'sweep_done');
    } else {
      app.log.debug({ deleted: 0 }, 'sweep_done');
    }
  } catch (err) {
    app.log.error({ err }, 'sweep_failed');
  }
}

try {
  await app.listen({ port: env.SESSION_SWEEPER_PORT, host: '0.0.0.0' });
  app.log.info({ port: env.SESSION_SWEEPER_PORT, intervalSeconds: env.SESSION_SWEEP_INTERVAL_S }, 'started');
  void sweep(); // run once at boot so the healthcheck shows a recent run quickly
  setInterval(() => void sweep(), env.SESSION_SWEEP_INTERVAL_S * 1000);
  // Phase 6b: audit alerting (no-op unless HIVE_AUDIT_ALERT_EMAIL is set).
  startAuditAlerts(app.log);
} catch (err) {
  app.log.error({ err }, 'failed_to_start');
  process.exit(1);
}

const shutdown = async (sig: string) => {
  app.log.info({ sig }, 'shutdown');
  try { await app.close(); } catch { /* ignore */ }
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
