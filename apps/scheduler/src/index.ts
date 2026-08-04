import Fastify from 'fastify';
import type { LoggerOptions } from 'pino';
import cronParser from 'cron-parser';
import { prisma } from '@hive/db';
import { createHealthz, type HealthChecks } from '@hive/shared';
import { createEmailProvider } from '@hive/email';
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

// --- real-time failure alerts -----------------------------------------------
// Runs every tick (30s). Finds jobs that finished since the last check and
// fires email / Slack notifications for any matching Alert rules.

let lastAlertCheckAt = new Date();

async function alertTick(): Promise<void> {
  const checkFrom = lastAlertCheckAt;
  lastAlertCheckAt = new Date();

  // Find jobs that just finished (succeeded or failed) since the last check.
  const recentJobs = await prisma.job.findMany({
    where: {
      finishedAt: { gt: checkFrom },
      status: { in: ['failed', 'succeeded'] },
    },
    include: { bot: { select: { id: true, name: true, userId: true } } },
  });

  if (recentJobs.length === 0) return;

  // For each finished job, find enabled alert rules that match.
  for (const job of recentJobs) {
    const userId = job.bot.userId;
    if (!userId) continue; // shared/admin bots don't have user alerts

    const alerts = await prisma.alert.findMany({
      where: {
        userId,
        enabled: true,
        OR: [{ botId: job.bot.id }, { botId: null }],
      },
    });

    for (const alert of alerts) {
      const triggers = alert.triggerOn.split(',');
      const fired = triggers.includes(job.status);
      if (!fired) continue;

      const subject =
        job.status === 'failed'
          ? `🔴 Hive alert — ${job.bot.name} failed`
          : `✅ Hive — ${job.bot.name} recovered`;

      const body = job.status === 'failed'
        ? `Your bot **${job.bot.name}** just failed.\n\nError: ${job.error ?? '(no error message)'}\n\nJob ID: ${job.id}`
        : `Your bot **${job.bot.name}** succeeded after a previous failure.\n\nJob ID: ${job.id}`;

      try {
        if (alert.channel === 'email' && env.RESEND_API_KEY) {
          const cfg = alert.config as { email?: string };
          if (cfg.email) {
            const mailer = createEmailProvider(env as Parameters<typeof createEmailProvider>[0]);
            await mailer.send({
              to: cfg.email,
              subject,
              text: body,
              html: `<pre style="font-family:sans-serif;white-space:pre-wrap">${body}</pre>`,
            });
          }
        } else if (alert.channel === 'slack') {
          const cfg = alert.config as { webhookUrl?: string };
          if (cfg.webhookUrl) {
            await fetch(cfg.webhookUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: `${subject}\n\n${body}` }),
              signal: AbortSignal.timeout(8_000),
            });
          }
        }
        app.log.info({ alertId: alert.id, jobId: job.id, channel: alert.channel, status: job.status }, 'alert_sent');
      } catch (e) {
        app.log.warn({ alertId: alert.id, jobId: job.id, err: (e as Error).message }, 'alert_send_failed');
      }
    }
  }
}

// --- daily digest -----------------------------------------------------------
// The scheduler fires bots; it also nudges the API to build+email the daily
// bot-effectiveness report once a day. All the heavy lifting (aggregation, AI
// lessons-learned, email) lives in the API — here we just POST on a cron.
let nextDigestAt: Date | null = null;

async function triggerDigest(): Promise<void> {
  const r = await fetch(`${env.API_BASE_URL.replace(/\/$/, '')}/api/reports/daily-digest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.API_AUTH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(60_000), // the AI lessons-learned step can take a bit
  });
  const body = (await r.text()).slice(0, 300);
  if (r.ok) app.log.info({ status: r.status }, 'daily_digest_sent');
  else app.log.warn({ status: r.status, body }, 'daily_digest_failed');
}

async function digestTick(): Promise<void> {
  if (env.DAILY_DIGEST_ENABLED !== 'true') return;
  const now = new Date();
  if (!nextDigestAt) {
    nextDigestAt = computeNext(env.DAILY_DIGEST_CRON, now);
    return;
  }
  if (now < nextDigestAt) return;
  // Advance first so a slow/failed send can't double-fire on the next tick.
  nextDigestAt = computeNext(env.DAILY_DIGEST_CRON, now);
  try {
    await triggerDigest();
  } catch (err) {
    app.log.error({ err }, 'daily_digest_tick_error');
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

  nextDigestAt = computeNext(env.DAILY_DIGEST_CRON);
  app.log.info({ nextDigestAt, enabled: env.DAILY_DIGEST_ENABLED }, 'daily_digest_armed');

  setInterval(() => void tick().catch((err) => app.log.error({ err }, 'tick_loop_failed')), TICK_MS);
  setInterval(() => void loadSchedules().catch((err) => app.log.error({ err }, 'reload_failed')), RELOAD_MS);
  setInterval(() => void digestTick().catch((err) => app.log.error({ err }, 'digest_loop_failed')), TICK_MS);
  setInterval(() => void alertTick().catch((err) => app.log.error({ err }, 'alert_loop_failed')), TICK_MS);
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
