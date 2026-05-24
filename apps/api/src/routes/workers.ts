import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, Prisma } from '@hive/db';
import { requireAuth } from '../auth.js';

const Heartbeat = z.object({
  workerId: z.string().min(1),
  poolType: z.string().min(1),
  hostname: z.string().min(1),
  capacity: z.number().int().positive(),
  activeJobs: z.number().int().nonnegative(),
  metadata: z.record(z.unknown()).optional(),
});

const OFFLINE_AFTER_MS = 30_000;

export async function workerRoutes(app: FastifyInstance) {
  app.post('/api/workers/heartbeat', { preHandler: requireAuth('worker') }, async (req) => {
    const body = Heartbeat.parse(req.body);
    const now = new Date();
    const worker = await prisma.worker.upsert({
      where: { id: body.workerId },
      create: {
        id: body.workerId,
        poolType: body.poolType,
        hostname: body.hostname,
        status: 'online',
        capacity: body.capacity,
        activeJobs: body.activeJobs,
        lastSeenAt: now,
        metadata: (body.metadata ?? {}) as Prisma.InputJsonValue,
      },
      update: {
        poolType: body.poolType,
        hostname: body.hostname,
        status: 'online',
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
}
