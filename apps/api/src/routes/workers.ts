import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, Prisma } from '@hive/db';
import { requireAuth } from '../auth.js';
import { redis } from '../redis.js';

const Heartbeat = z.object({
  workerId: z.string().min(1),
  poolType: z.string().min(1),
  hostname: z.string().min(1),
  capacity: z.number().int().positive(),
  activeJobs: z.number().int().nonnegative(),
  metadata: z.record(z.unknown()).optional(),
});

const OFFLINE_AFTER_MS = 30_000;
const DRAIN_TTL_S = 300;

function drainKey(workerId: string): string {
  return `hive:worker:${workerId}:drain`;
}

function statusFromMetadata(meta: Record<string, unknown> | undefined): 'online' | 'draining' {
  const v = meta?.status;
  return v === 'draining' ? 'draining' : 'online';
}

export async function workerRoutes(app: FastifyInstance) {
  app.post('/api/workers/heartbeat', { preHandler: requireAuth('worker') }, async (req) => {
    const body = Heartbeat.parse(req.body);
    const now = new Date();
    const status = statusFromMetadata(body.metadata);
    const worker = await prisma.worker.upsert({
      where: { id: body.workerId },
      create: {
        id: body.workerId,
        poolType: body.poolType,
        hostname: body.hostname,
        status,
        capacity: body.capacity,
        activeJobs: body.activeJobs,
        lastSeenAt: now,
        metadata: (body.metadata ?? {}) as Prisma.InputJsonValue,
      },
      update: {
        poolType: body.poolType,
        hostname: body.hostname,
        status,
        capacity: body.capacity,
        activeJobs: body.activeJobs,
        lastSeenAt: now,
        metadata: (body.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });
    return worker;
  });

  app.get('/api/workers', { preHandler: requireAuth('api') }, async () => {
    const cutoff = new Date(Date.now() - OFFLINE_AFTER_MS);
    await prisma.worker.updateMany({
      where: { status: { not: 'offline' }, lastSeenAt: { lt: cutoff } },
      data: { status: 'offline' },
    });
    return prisma.worker.findMany({ orderBy: [{ poolType: 'asc' }, { hostname: 'asc' }] });
  });

  app.post<{ Params: { id: string } }>(
    '/api/workers/:id/drain',
    { preHandler: requireAuth('api') },
    async (req, reply) => {
      const worker = await prisma.worker.findUnique({ where: { id: req.params.id } });
      if (!worker) {
        return reply.code(404).send({ error: { code: 'not_found', message: 'worker not found' } });
      }
      await redis.set(drainKey(req.params.id), '1', 'EX', DRAIN_TTL_S);
      return { ok: true, workerId: req.params.id, ttlSeconds: DRAIN_TTL_S };
    },
  );
}
