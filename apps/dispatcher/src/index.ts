import Fastify from 'fastify';
import { Redis } from 'ioredis';
import type { LoggerOptions } from 'pino';
import { prisma } from '@hive/db';
import { dispatchStreamFor, POOL_STREAM_ANY } from '@hive/worker-base-ts';
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

// Phase 5b: how long after dispatch we wait for a worker to claim a job
// before marking it 'unroutable'. 60s lets a worker reconnect / boot up
// briefly without prematurely failing jobs; tune via HIVE_UNROUTABLE_TIMEOUT_S
// if your fleet takes longer to scale from zero.
const UNROUTABLE_TIMEOUT_S = Number(process.env.HIVE_UNROUTABLE_TIMEOUT_S ?? '60');
// How long between sweeps for queued-but-unclaimed jobs.
const UNROUTABLE_SWEEP_INTERVAL_MS = 15_000;
// "Online" cutoff for worker heartbeats — matches OFFLINE_AFTER_MS in workers.ts.
const WORKER_ONLINE_WINDOW_MS = 30_000;

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

interface ParsedAffinity {
  region?: string;
  zone?: string;
}

function parseAffinity(raw: string | undefined): ParsedAffinity | null {
  if (!raw || raw === 'null') return null;
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj as ParsedAffinity;
  } catch {
    /* fall through */
  }
  return null;
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

        const affinity = parseAffinity(data.affinity);
        const targetStream = dispatchStreamFor(pool, affinity);
        // Phase 5b drops the 'affinity' field from the per-pool stream
        // payload — workers don't need it (they're already in the right
        // stream by construction). Keep schemas tight.
        const outFields: string[] = [];
        for (let i = 0; i < fields.length; i += 2) {
          if (fields[i] === 'affinity') continue;
          outFields.push(fields[i], fields[i + 1]);
        }

        try {
          await producer.xadd(targetStream, '*', ...outFields);
          await producer.xack(DISPATCH_STREAM, GROUP, entryId);
          app.log.info(
            { jobId, pool, entryId, targetStream, affinity },
            'job_routed',
          );
        } catch (err) {
          app.log.error({ err, jobId, pool, entryId }, 'route_failed');
          // Do not ACK — leave for redelivery.
        }
      }
    }
  }
}

/** Phase 5b: scan queued jobs older than UNROUTABLE_TIMEOUT_S. For each, check
 *  whether any online worker can consume it given its affinity. If none, mark
 *  the job status='unroutable' so the operator knows to either spin up a
 *  matching worker or change the bot's affinity. */
async function unroutableSweep(): Promise<void> {
  while (true) {
    try {
      const cutoff = new Date(Date.now() - UNROUTABLE_TIMEOUT_S * 1000);
      const onlineCutoff = new Date(Date.now() - WORKER_ONLINE_WINDOW_MS);
      const candidates = await prisma.job.findMany({
        where: { status: 'queued', createdAt: { lt: cutoff } },
        include: { bot: { include: { template: true } } },
        take: 200,
      });

      for (const job of candidates) {
        const pool = job.bot.template.poolType;
        const affinity = (job.bot.affinityOverride ?? job.bot.template.affinity) as
          | ParsedAffinity
          | null;
        const region = affinity?.region?.trim();
        const zone = affinity?.zone?.trim();

        // Find online workers in the pool that could consume this job.
        // Any worker matches if no affinity is set. Otherwise the worker's
        // region must match, AND (the affinity has no zone OR the worker's
        // zone matches).
        const workers = await prisma.worker.findMany({
          where: {
            poolType: pool,
            status: { not: 'offline' },
            lastSeenAt: { gt: onlineCutoff },
            ...(region ? { region } : {}),
            ...(region && zone ? { zone } : {}),
          },
          select: { id: true },
          take: 1,
        });
        if (workers.length > 0) continue;

        const reason =
          region || zone
            ? `no online worker in pool '${pool}' matches affinity region='${region ?? '(any)'}' zone='${zone ?? '(any)'}'`
            : `no online worker in pool '${pool}' available`;
        await prisma.job.update({
          where: { id: job.id },
          data: {
            status: 'unroutable',
            error: reason,
            finishedAt: new Date(),
          },
        });
        app.log.warn({ jobId: job.id, pool, affinity, reason }, 'job_unroutable');
      }
    } catch (err) {
      app.log.error({ err }, 'unroutable_sweep_failed');
    }
    await new Promise((r) => setTimeout(r, UNROUTABLE_SWEEP_INTERVAL_MS));
  }
}

try {
  await ensureGroup();
  await app.listen({ port: env.DISPATCHER_PORT, host: '0.0.0.0' });
  void consumeLoop().catch((err) => {
    app.log.error({ err }, 'consume_loop_crashed');
    process.exit(1);
  });
  void unroutableSweep().catch((err) => {
    app.log.error({ err }, 'unroutable_sweep_crashed');
    // Don't exit — keep dispatching.
  });
  // Reference the sentinel constant so it's not flagged as unused if some
  // refactor removes one of the call sites. Cheap, intent-bearing.
  void POOL_STREAM_ANY;
} catch (err) {
  app.log.error({ err }, 'failed_to_start');
  process.exit(1);
}

const shutdown = async (sig: string) => {
  app.log.info({ sig }, 'shutdown');
  try { await app.close(); } catch (e) { app.log.error({ err: e }, 'close_failed'); }
  try { producer.disconnect(); consumer.disconnect(); } catch { /* ignore */ }
  await prisma.$disconnect().catch(() => undefined);
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
