import type { FastifyInstance, FastifyRequest } from 'fastify';
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

function isAdmin(req: FastifyRequest): boolean {
  return req.staticAuth === 'api' || req.user?.role === 'admin';
}

/** Scopes a bot lookup to the requesting user (admins see all). */
function botOwnerFilter(req: FastifyRequest): { userId?: string } {
  if (isAdmin(req)) return {};
  return { userId: req.user?.id ?? 'nobody' };
}

/**
 * A schedule is a standing instruction to execute a bot's config on a worker,
 * so it sits on the same side of the line as POST /api/bots/:id/run — which is
 * admin-only. It was not, and the gap was a full privilege escalation: the
 * scheduler triggers runs using API_AUTH_TOKEN, which auth.ts treats as
 * admin-equivalent, so a non-admin who could write a Schedule row had the
 * scheduler press "run" on their behalf. With templates like "Shell Command
 * Runner (Native)" executing uncontained on the worker host, that was arbitrary
 * code execution for any logged-in user.
 *
 * Reads stay open and ownership-scoped; every mutation is admin-only. The UI
 * already hid these controls from non-admins, so this restores the boundary the
 * product was designed around rather than changing it.
 */
export async function scheduleRoutes(app: FastifyInstance) {
  app.post('/api/schedules', { preHandler: requireRole('admin') }, async (req, reply) => {
    const body = Create.parse(req.body);
    const err = validateCron(body.cron);
    if (err) {
      return reply.code(400).send({ error: { code: 'invalid_cron', message: err } });
    }
    // Verify the bot exists and is owned by this user.
    const bot = await prisma.bot.findFirst({
      where: { id: body.botId, ...botOwnerFilter(req) },
    });
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

  app.get('/api/schedules', { preHandler: requireAuth('api') }, async (req) => {
    return prisma.schedule.findMany({
      where: isAdmin(req) ? {} : { bot: { userId: req.user?.id ?? 'nobody' } },
      orderBy: { createdAt: 'desc' },
      include: { bot: { include: { template: true } } },
    });
  });

  app.get<{ Params: { id: string } }>(
    '/api/schedules/:id',
    { preHandler: requireAuth('api') },
    async (req, reply) => {
      const s = await prisma.schedule.findFirst({
        where: {
          id: req.params.id,
          ...(isAdmin(req) ? {} : { bot: { userId: req.user?.id ?? 'nobody' } }),
        },
        include: { bot: { include: { template: true } } },
      });
      if (!s) return reply.code(404).send({ error: { code: 'not_found', message: 'schedule not found' } });
      return s;
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/api/schedules/:id',
    { preHandler: requireRole('admin') },
    async (req, reply) => {
      const body = Patch.parse(req.body);
      const existing = await prisma.schedule.findFirst({
        where: {
          id: req.params.id,
          ...(isAdmin(req) ? {} : { bot: { userId: req.user?.id ?? 'nobody' } }),
        },
      });
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
    { preHandler: requireRole('admin') },
    async (req, reply) => {
      const existing = await prisma.schedule.findFirst({
        where: {
          id: req.params.id,
          ...(isAdmin(req) ? {} : { bot: { userId: req.user?.id ?? 'nobody' } }),
        },
      });
      if (!existing) {
        return reply.code(404).send({ error: { code: 'not_found', message: 'schedule not found' } });
      }
      await prisma.schedule.delete({ where: { id: req.params.id } });
      return reply.code(204).send();
    },
  );
}
