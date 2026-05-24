import Fastify from 'fastify';
import { Redis } from 'ioredis';
import type { LoggerOptions } from 'pino';
import { env } from './env.js';

const KNOWN_POOLS = new Set([
  'browser',
  'scraper',
  'rpa_desktop',
  'discord',
  'telegram',
  'trading',
  'monitor',
  'mcp_host',
  'ci_agent',
  'task_runner',
  'ai_agent',
]);

const DISPATCH_STREAM = 'hive:dispatch';
const GROUP = 'hive:dispatcher';
const CONSUMER = `dispatcher-${process.pid}`;

const loggerOptions: LoggerOptions = {
  level: env.LOG_LEVEL,
  base: { service: 'dispatcher' },
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

const producer = new Redis(env.REDIS_URL, { lazyConnect: false });
const consumer = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });

app.get('/healthz', async () => {
  const checks: Record<string, { ok: boolean; error?: string }> = {
    redis: { ok: true },
    service: { ok: true },
  };
  try {
    const pong = await producer.ping();
    checks.redis = { ok: pong === 'PONG' };
  } catch (e) {
    checks.redis = { ok: false, error: (e as Error).message };
  }
  return {
    status: Object.values(checks).every((c) => c.ok) ? 'ok' : 'degraded',
    service: 'dispatcher',
    uptimeMs: Date.now() - startedAt,
    checks,
  };
});

async function ensureGroup() {
  try {
    await producer.xgroup('CREATE', DISPATCH_STREAM, GROUP, '$', 'MKSTREAM');
    app.log.info({ group: GROUP }, 'consumer_group_created');
  } catch (err) {
    if (err instanceof Error && err.message.includes('BUSYGROUP')) {
      app.log.info({ group: GROUP }, 'consumer_group_exists');
    } else {
      throw err;
    }
  }
}

type StreamEntry = [string, string[]];

async function consumeLoop() {
  while (true) {
    const res = (await consumer.xreadgroup(
      'GROUP', GROUP, CONSUMER,
      'COUNT', 32,
      'BLOCK', 5000,
      'STREAMS', DISPATCH_STREAM, '>',
    )) as Array<[string, StreamEntry[]]> | null;

    if (!res) continue;

    for (const [, entries] of res) {
      for (const [entryId, fields] of entries) {
        const data: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) data[fields[i]] = fields[i + 1];
        const pool = data.pool;
        const jobId = data.jobId;

        if (!pool || !KNOWN_POOLS.has(pool)) {
          app.log.warn({ jobId, pool, entryId }, 'unknown_pool_acking');
          await producer.xack(DISPATCH_STREAM, GROUP, entryId);
          continue;
        }

        const targetStream = `hive:pool:${pool}`;
        try {
          await producer.xadd(targetStream, '*', ...(fields as string[]));
          await producer.xack(DISPATCH_STREAM, GROUP, entryId);
          app.log.info({ jobId, pool, entryId, targetStream }, 'job_routed');
        } catch (err) {
          app.log.error({ err, jobId, pool, entryId }, 'route_failed');
          // Do not ACK — leave for redelivery.
        }
      }
    }
  }
}

try {
  await ensureGroup();
  await app.listen({ port: env.DISPATCHER_PORT, host: '0.0.0.0' });
  void consumeLoop().catch((err) => {
    app.log.error({ err }, 'consume_loop_crashed');
    process.exit(1);
  });
} catch (err) {
  app.log.error({ err }, 'failed_to_start');
  process.exit(1);
}

const shutdown = async (sig: string) => {
  app.log.info({ sig }, 'shutdown');
  try { await app.close(); } catch (e) { app.log.error({ err: e }, 'close_failed'); }
  try { producer.disconnect(); consumer.disconnect(); } catch { /* ignore */ }
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
