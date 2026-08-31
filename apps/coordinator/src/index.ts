import Fastify from 'fastify';
import { Redis } from 'ioredis';
import type { LoggerOptions } from 'pino';
import { prisma } from '@hive/db';
import { createHealthz, type HealthChecks } from '@hive/shared';
import { env } from './env.js';
import { runMissionLoop } from './loop.js';
import { expireStaleProposals } from './expiry.js';

const loggerOptions: LoggerOptions = {
  level: env.LOG_LEVEL,
  base: { service: 'coordinator' },
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

// Mission loops each hold a blocking XREADGROUP, so they need their own
// connections. This one is for health probes and loop bookkeeping only.
const redis = new Redis(env.REDIS_URL, { lazyConnect: false });

interface RunningLoop {
  controller: AbortController;
  redis: Redis;
}
const loops = new Map<string, RunningLoop>();

const healthz = createHealthz({
  service: 'coordinator',
  startedAt,
  checkFn: async (): Promise<HealthChecks> => {
    const checks: HealthChecks = {
      service: { ok: true },
      missions: { ok: true, running: loops.size },
      // A coordinator without a key can reconcile but can never decide. Say so
      // in the probe rather than failing silently once a mission starts.
      model: {
        ok: Boolean(env.ANTHROPIC_API_KEY),
        ...(env.ANTHROPIC_API_KEY ? {} : { error: 'ANTHROPIC_API_KEY not set' }),
      },
    };
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

/**
 * Bring the set of running loops in line with the set of running missions.
 * Declarative rather than event-driven on purpose: a coordinator restart
 * re-derives its whole state from the database with no replay needed.
 */
async function reconcile(): Promise<void> {
  const running = await prisma.mission.findMany({
    where: { status: 'running' },
    select: { id: true },
  });
  const wanted = new Set(running.map((m) => m.id));

  for (const id of wanted) {
    if (loops.has(id)) continue;
    const controller = new AbortController();
    // Blocking reads need a dedicated connection with retries disabled.
    const loopRedis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
    loops.set(id, { controller, redis: loopRedis });
    app.log.info({ missionId: id }, 'mission loop started');
    void runMissionLoop(id, loopRedis, controller.signal, app.log as never)
      .catch((err) => app.log.error({ err, missionId: id }, 'mission loop crashed'))
      .finally(() => {
        loopRedis.disconnect();
        // Only clear if this is still the registered loop — a stop/start race
        // must not delete the newer loop's entry.
        if (loops.get(id)?.controller === controller) loops.delete(id);
      });
  }

  for (const [id, loop] of loops) {
    if (!wanted.has(id)) {
      loop.controller.abort();
      app.log.info({ missionId: id }, 'mission loop stopping');
    }
  }
}

const timers: NodeJS.Timeout[] = [];

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  for (const t of timers) clearInterval(t);
  for (const loop of loops.values()) loop.controller.abort();
  await app.close();
  redis.disconnect();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: env.COORDINATOR_PORT, host: '0.0.0.0' });
await reconcile();

timers.push(
  setInterval(() => {
    void reconcile().catch((err) => app.log.error({ err }, 'reconcile failed'));
  }, env.COORDINATOR_RECONCILE_MS),
);

// A pending proposal past its TTL must not sit in the queue looking actionable.
timers.push(
  setInterval(() => {
    void expireStaleProposals(app.log as never).catch((err) =>
      app.log.error({ err }, 'proposal expiry sweep failed'),
    );
  }, 30_000),
);
