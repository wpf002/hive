import Fastify from 'fastify';
import type { LoggerOptions } from 'pino';
import cronParser from 'cron-parser';
import { prisma } from '@hive/db';
import { createHealthz, type HealthChecks } from '@hive/shared';
import { env } from './env.js';

const TICK_MS = 30_000;
const RELOAD_MS = 60_000;
const startedAt = Date.now();

const loggerOptions: LoggerOptions = {
  level: env.LOG_LEVEL,
  base: { service: 'scheduler' },
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

const healthz = createHealthz({
  service: 'scheduler',
  startedAt,
  checkFn: async (): Promise<HealthChecks> => {
    const checks: HealthChecks = { service: { ok: true } };
    let dbOk = true;
    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.postgres = { ok: true };
    } catch (e) {
      dbOk = false;
      checks.postgres = { ok: false, error: (e as Error).message };
    }
    // "schedules loaded count > 0 if any active" — degraded only if there ARE
    // active schedules in the DB but our in-memory cache loaded none of them.
    if (dbOk) {
      const activeInDb = await prisma.schedule.count({ where: { enabled: true } });
      const loaded = cache.length;
      checks.schedules = {
        ok: activeInDb === 0 || loaded > 0,
        loaded,
        activeInDb,
      };
    } else {
      checks.schedules = { ok: false, loaded: cache.length };
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

interface CachedSchedule {
  id: string;
  botId: string;
  cron: string;
  enabled: boolean;
  nextRunAt: Date | null;
}

let cache: CachedSchedule[] = [];

async function loadSchedules(): Promise<void> {
  const rows = await prisma.schedule.findMany({ where: { enabled: true } });
  cache = rows.map((r) => ({
    id: r.id,
    botId: r.botId,
    cron: r.cron,
    enabled: r.enabled,
    nextRunAt: r.nextRunAt,
  }));
  app.log.info({ count: cache.length }, 'schedules_loaded');
}

function computeNext(cron: string, from: Date = new Date()): Date {
  const interval = cronParser.parseExpression(cron, { currentDate: from });
  return interval.next().toDate();
}

async function triggerRun(botId: string): Promise<{ ok: boolean; status: number; body: string }> {
  const r = await fetch(`${env.API_BASE_URL.replace(/\/$/, '')}/api/bots/${botId}/run`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.API_AUTH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await r.text();
  return { ok: r.ok, status: r.status, body: text.slice(0, 500) };
}

async function tick(): Promise<void> {
  const now = new Date();
  for (const s of cache) {
    if (!s.enabled) continue;
    if (s.nextRunAt && s.nextRunAt > now) continue;
    try {
      const res = await triggerRun(s.botId);
      const lastRunAt = new Date();
      const nextRunAt = computeNext(s.cron, lastRunAt);
      // updateMany so a concurrently-deleted schedule is a no-op, not a P2025.
      await prisma.schedule.updateMany({
        where: { id: s.id },
        data: { lastRunAt, nextRunAt },
      });
      s.nextRunAt = nextRunAt;
      if (res.ok) {
        app.log.info({ scheduleId: s.id, botId: s.botId, nextRunAt }, 'schedule_fired');
      } else {
        app.log.warn(
          { scheduleId: s.id, botId: s.botId, status: res.status, body: res.body },
          'schedule_fire_failed',
        );
      }
    } catch (err) {
      app.log.error({ err, scheduleId: s.id }, 'schedule_tick_error');
    }
  }
}

async function backfillNextRunAt(): Promise<void> {
  const rows = await prisma.schedule.findMany({ where: { enabled: true, nextRunAt: null } });
  for (const r of rows) {
    try {
      const next = computeNext(r.cron);
      await prisma.schedule.update({ where: { id: r.id }, data: { nextRunAt: next } });
    } catch (err) {
      app.log.warn({ err, id: r.id, cron: r.cron }, 'backfill_nextrun_failed');
    }
  }
}

try {
  await app.listen({ port: env.SCHEDULER_PORT, host: '0.0.0.0' });
  await backfillNextRunAt();
  await loadSchedules();

  setInterval(() => void tick().catch((err) => app.log.error({ err }, 'tick_loop_failed')), TICK_MS);
  setInterval(() => void loadSchedules().catch((err) => app.log.error({ err }, 'reload_failed')), RELOAD_MS);
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
