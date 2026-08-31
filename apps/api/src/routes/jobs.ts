import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, Prisma } from '@hive/db';
import { requireAuth, requireRole } from '../auth.js';
import { redis, STREAMS } from '../redis.js';
import { writeAuditLog } from '../lib/audit.js';
import { decryptBotConfig, maskBotConfig } from '../lib/secrets.js';
import { jobOwnerFilter } from '../lib/ownership.js';

/** Matches OFFLINE_AFTER_MS in routes/workers.ts and the dispatcher. */
const WORKER_ONLINE_WINDOW_MS = 30_000;

const RunBody = z.object({
  overrideConfig: z.record(z.unknown()).optional(),
  priority: z.number().int().optional(),
});

const ListQuery = z.object({
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'unroutable']).optional(),
  botId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * Masks any secret still sitting in a job's persisted payload.
 *
 * New jobs are written masked (see /run and /requeue below), but rows created
 * before that fix can hold cleartext override secrets, and this endpoint is the
 * thing that served them. Masking on read as well means the fix covers history
 * without a migration.
 */
function maskJob<T extends { payload: unknown; bot?: { template: { configSchema: unknown } } }>(
  job: T,
): T {
  const template = job.bot?.template;
  const payload = job.payload;
  if (!template || !payload || typeof payload !== 'object' || Array.isArray(payload)) return job;
  const p = payload as Record<string, unknown>;
  if (!p.config || typeof p.config !== 'object') return job;
  return { ...job, payload: { ...p, config: maskBotConfig(template, p.config) } };
}

export async function jobRoutes(app: FastifyInstance) {
  app.post<{ Params: { id: string } }>(
    '/api/bots/:id/run',
    // Running a bot dispatches code to a worker — admin-only.
    { preHandler: requireRole('admin') },
    async (req, reply) => {
      const body = RunBody.parse(req.body ?? {});
      const bot = await prisma.bot.findUnique({
        where: { id: req.params.id },
        include: { template: true },
      });
      if (!bot) return reply.code(404).send({ error: { code: 'not_found', message: 'bot not found' } });
      if (!bot.enabled) {
        return reply.code(400).send({ error: { code: 'bot_disabled', message: 'bot is disabled' } });
      }
      // Phase 4c — singleton pools refuse parallel dispatch.
      // A worker advertises `metadata.singleton: true` in its heartbeat; if
      // any such worker for this pool already has an active job, we 429 with
      // a retry hint instead of queueing forever behind it.
      // Liveness comes from lastSeenAt, not the status column: nothing writes
      // 'offline' promptly (the sweeper deletes stale rows on a long timer),
      // so a worker that died mid-job would otherwise look busy forever and
      // 429 every subsequent run on a singleton pool.
      const busyWorker = await prisma.worker.findFirst({
        where: {
          poolType: bot.template.poolType,
          activeJobs: { gt: 0 },
          status: { not: 'offline' },
          lastSeenAt: { gt: new Date(Date.now() - WORKER_ONLINE_WINDOW_MS) },
        },
      });
      if (
        busyWorker &&
        typeof busyWorker.metadata === 'object' &&
        busyWorker.metadata !== null &&
        (busyWorker.metadata as Record<string, unknown>).singleton === true
      ) {
        reply.header('Retry-After', '30');
        return reply.code(429).send({
          error: {
            code: 'pool_busy',
            message: `pool '${bot.template.poolType}' is single-tenant and busy (worker ${busyWorker.id}); retry shortly`,
            retryAfterMs: 30_000,
          },
        });
      }
      // Decrypt any x-secret fields, then merge override values on top. Any
      // secret supplied in the override is treated as cleartext (workers always
      // see cleartext over the dispatch stream — encrypted dispatch payloads
      // are Phase 5).
      const decrypted = await decryptBotConfig(bot.template, bot.config);
      const config = { ...decrypted, ...(body.overrideConfig ?? {}) };
      // Persisted payload preserves whatever the bot has stored; the cleartext
      // copy lives only on the dispatch stream + in worker memory.
      //
      // bot.config is already encrypted at rest, but overrideConfig arrives as
      // cleartext (see above), so merging it in unmasked would write a live
      // secret into Job.payload — which is served over HTTP. Mask the merged
      // result so a secret can never be read back out of a job record.
      const storedPayload = maskBotConfig(bot.template, {
        ...(bot.config as Record<string, unknown>),
        ...(body.overrideConfig ?? {}),
      });
      const job = await prisma.job.create({
        data: {
          botId: bot.id,
          status: 'queued',
          priority: body.priority ?? 0,
          payload: {
            config: storedPayload,
            templateName: bot.template.name,
            pool: bot.template.poolType,
          } as Prisma.InputJsonValue,
        },
      });
      // Phase 5b: bot's effective affinity (override OR template default).
      const effectiveAffinity = (bot.affinityOverride ?? bot.template.affinity) as
        | { region?: string; zone?: string }
        | null;
      await redis.xadd(
        STREAMS.dispatch,
        '*',
        'jobId', job.id,
        'botId', bot.id,
        'pool', bot.template.poolType,
        'templateName', bot.template.name,
        'config', JSON.stringify(config),
        'priority', String(job.priority),
        'affinity', JSON.stringify(effectiveAffinity ?? null),
      );
      return reply.code(201).send(job);
    },
  );

  app.get('/api/jobs', { preHandler: requireAuth('api') }, async (req) => {
    const q = ListQuery.parse(req.query);
    const rows = await prisma.job.findMany({
      where: { status: q.status, botId: q.botId, ...jobOwnerFilter(req) },
      orderBy: { createdAt: 'desc' },
      take: q.limit,
      include: { bot: { include: { template: true } } },
    });
    return rows.map(maskJob);
  });

  app.get<{ Params: { id: string } }>(
    '/api/jobs/:id',
    { preHandler: requireAuth('api') },
    async (req, reply) => {
      const job = await prisma.job.findFirst({
        where: { id: req.params.id, ...jobOwnerFilter(req) },
        include: {
          bot: { include: { template: true } },
          logs: { orderBy: { timestamp: 'asc' }, take: 1000 },
        },
      });
      // 404 rather than 403 for someone else's job: a 403 would confirm the id
      // exists and turn this into an existence oracle.
      if (!job) return reply.code(404).send({ error: { code: 'not_found', message: 'job not found' } });
      return maskJob(job);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/jobs/:id/cancel',
    // Controlling job execution (stopping a running job) is admin-only.
    { preHandler: requireRole('admin') },
    async (req, reply) => {
      const job = await prisma.job.findUnique({ where: { id: req.params.id } });
      if (!job) return reply.code(404).send({ error: { code: 'not_found', message: 'job not found' } });
      if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') {
        return reply.code(409).send({
          error: { code: 'job_terminal', message: `job already ${job.status}` },
        });
      }
      const updated = await prisma.job.update({
        where: { id: job.id },
        data: { status: 'cancelled', finishedAt: new Date() },
      });
      await redis.publish(STREAMS.cancel(job.id), JSON.stringify({ jobId: job.id }));
      return updated;
    },
  );

  // The DLQ is a Redis stream with no owner column — it mixes every tenant's
  // failures and their error strings, and can't be filtered per caller. It's an
  // operations view, so it's admin-only rather than partially scoped.
  app.get('/api/jobs/dlq', { preHandler: requireRole('admin') }, async () => {
    const entries = (await redis.xrange('hive:dlq', '-', '+', 'COUNT', 200)) as Array<[string, string[]]>;
    const items = entries.map(([id, fields]) => {
      const map: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) map[fields[i]] = fields[i + 1];
      return {
        entryId: id,
        jobId: map.jobId,
        botId: map.botId,
        pool: map.pool,
        templateName: map.templateName,
        error: map.error,
        failedAt: map.failedAt,
        workerId: map.workerId,
      };
    });
    return items.reverse();
  });

  app.post<{ Params: { id: string } }>(
    '/api/jobs/:id/requeue',
    { preHandler: requireRole('admin') },
    async (req, reply) => {
      const job = await prisma.job.findUnique({
        where: { id: req.params.id },
        include: { bot: { include: { template: true } } },
      });
      if (!job) return reply.code(404).send({ error: { code: 'not_found', message: 'job not found' } });
      if (job.status !== 'failed') {
        return reply.code(409).send({ error: { code: 'not_failed', message: `job is ${job.status}, only failed jobs can be requeued` } });
      }
      await writeAuditLog(req, {
        userId: req.user?.id ?? null,
        action: 'job.requeue',
        targetType: 'job',
        targetId: job.id,
        payload: { botId: job.botId, pool: job.bot.template.poolType },
      });
      // Requeue uses the bot's CURRENT config, not the job's original payload,
      // so a fix to the bot config takes effect on requeue.
      const decrypted = await decryptBotConfig(job.bot.template, job.bot.config);
      const storedConfig = maskBotConfig(job.bot.template, job.bot.config);
      const updated = await prisma.job.update({
        where: { id: job.id },
        data: {
          status: 'queued',
          attempts: 0,
          error: null,
          result: Prisma.DbNull,
          startedAt: null,
          finishedAt: null,
          payload: {
            config: storedConfig,
            templateName: job.bot.template.name,
            pool: job.bot.template.poolType,
          } as Prisma.InputJsonValue,
        },
      });
      const effectiveAffinity = (job.bot.affinityOverride ?? job.bot.template.affinity) as
        | { region?: string; zone?: string }
        | null;
      await redis.xadd(
        STREAMS.dispatch,
        '*',
        'jobId', job.id,
        'botId', job.botId,
        'pool', job.bot.template.poolType,
        'templateName', job.bot.template.name,
        'config', JSON.stringify(decrypted),
        'priority', String(job.priority),
        'affinity', JSON.stringify(effectiveAffinity ?? null),
      );
      return updated;
    },
  );
}
