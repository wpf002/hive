import Fastify from 'fastify';
import { Redis } from 'ioredis';
import type { LoggerOptions } from 'pino';
import { prisma } from '@hive/db';
import { createHealthz, type HealthChecks } from '@hive/shared';
import { env } from './env.js';
import { MissionRuntime } from './mission-runtime.js';
import { expireStaleProposals } from './expiry.js';
import { runExecutorPass } from './execute.js';

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

const loops = new Map<string, MissionRuntime>();

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
    const runtime = new MissionRuntime(id, app.log as never);
    loops.set(id, runtime);
    runtime.start();
  }

  for (const [id, runtime] of loops) {
    if (!wanted.has(id)) {
      runtime.stop();
      loops.delete(id);
    }
  }
}

const timers: NodeJS.Timeout[] = [];

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  for (const t of timers) clearInterval(t);
  for (const runtime of loops.values()) runtime.stop();
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

// Approved proposals are executed here rather than inside a mission loop, so
// an approval still fires while its mission is being restarted.
timers.push(
  setInterval(() => {
    void runExecutorPass(app.log as never).catch((err) =>
      app.log.error({ err }, 'executor pass failed'),
    );
  }, env.EXECUTOR_POLL_MS),
);
