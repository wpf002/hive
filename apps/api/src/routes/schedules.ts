import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import cronParser from 'cron-parser';
import { prisma } from '@hive/db';
import { requireAuth, requireRole } from '../auth.js';

const Create = z.object({
  botId: z.string().min(1),
  cron: z.string().min(1),
  enabled: z.boolean().optional(),
});

const Patch = z.object({
  cron: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
});

function nextRunFor(cron: string, from: Date = new Date()): Date {
  return cronParser.parseExpression(cron, { currentDate: from }).next().toDate();
}

function validateCron(cron: string): string | null {
  try {
    cronParser.parseExpression(cron);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

export async function scheduleRoutes(app: FastifyInstance) {
  app.post('/api/schedules', { preHandler: requireRole('admin') }, async (req, reply) => {
    const body = Create.parse(req.body);
    const err = validateCron(body.cron);
    if (err) {
      return reply.code(400).send({ error: { code: 'invalid_cron', message: err } });
    }
    const bot = await prisma.bot.findUnique({ where: { id: body.botId } });
    if (!bot) {
      return reply.code(400).send({ error: { code: 'invalid_bot', message: `botId ${body.botId} not found` } });
    }
    const enabled = body.enabled ?? true;
    const created = await prisma.schedule.create({
      data: {
        botId: body.botId,
        cron: body.cron,
        enabled,
        nextRunAt: enabled ? nextRunFor(body.cron) : null,
      },
    });
    return reply.code(201).send(created);
  });

  app.get('/api/schedules', { preHandler: requireAuth('api') }, async () => {
    return prisma.schedule.findMany({
      orderBy: { createdAt: 'desc' },
      include: { bot: { include: { template: true } } },
    });
  });

  app.get<{ Params: { id: string } }>(
    '/api/schedules/:id',
    { preHandler: requireAuth('api') },
    async (req, reply) => {
      const s = await prisma.schedule.findUnique({
        where: { id: req.params.id },
        include: { bot: { include: { template: true } } },
      });
      if (!s) return reply.code(404).send({ error: { code: 'not_found', message: 'schedule not found' } });
      return s;
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/api/schedules/:id',
    // Schedules auto-dispatch bots — creating/editing them is admin-only.
    { preHandler: requireRole('admin') },
    async (req, reply) => {
      const body = Patch.parse(req.body);
      const existing = await prisma.schedule.findUnique({ where: { id: req.params.id } });
      if (!existing) return reply.code(404).send({ error: { code: 'not_found', message: 'schedule not found' } });

      const nextCron = body.cron ?? existing.cron;
      if (body.cron) {
        const err = validateCron(body.cron);
        if (err) return reply.code(400).send({ error: { code: 'invalid_cron', message: err } });
      }
      const enabled = body.enabled ?? existing.enabled;
      const nextRunAt = enabled ? nextRunFor(nextCron) : null;
      return prisma.schedule.update({
        where: { id: req.params.id },
        data: {
          ...(body.cron !== undefined ? { cron: body.cron } : {}),
          ...(body.enabled !== undefined ? { enabled } : {}),
          nextRunAt,
        },
      });
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/schedules/:id',
    // Removing a schedule mutates the execution fleet — admin-only.
    { preHandler: requireRole('admin') },
    async (req, reply) => {
      await prisma.schedule.delete({ where: { id: req.params.id } });
      return reply.code(204).send();
    },
  );
}
