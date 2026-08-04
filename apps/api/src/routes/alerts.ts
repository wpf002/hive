import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '@hive/db';
import { requireAuth } from '../auth.js';

const ConfigEmail = z.object({ email: z.string().email() });
const ConfigSlack = z.object({ webhookUrl: z.string().url() });

const Create = z.object({
  botId: z.string().optional(),
  channel: z.enum(['email', 'slack']),
  config: z.union([ConfigEmail, ConfigSlack]),
  triggerOn: z.enum(['failed', 'failed,recovered']).default('failed'),
  enabled: z.boolean().optional(),
});

const Patch = z.object({
  enabled: z.boolean().optional(),
  triggerOn: z.enum(['failed', 'failed,recovered']).optional(),
  config: z.union([ConfigEmail, ConfigSlack]).optional(),
});

export async function alertRoutes(app: FastifyInstance) {
  // List the current user's alerts.
  app.get('/api/alerts', { preHandler: requireAuth('api') }, async (req) => {
    const userId = req.user?.id;
    if (!userId) return [];
    return prisma.alert.findMany({
      where: { userId },
      include: { bot: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });
  });

  // Create an alert rule.
  app.post('/api/alerts', { preHandler: requireAuth('api') }, async (req, reply) => {
    const userId = req.user?.id;
    if (!userId) return reply.code(401).send({ error: { code: 'no_session', message: 'session required' } });

    const body = Create.parse(req.body);

    // Verify botId belongs to this user if specified.
    if (body.botId) {
      const isAdmin = req.staticAuth === 'api' || req.user?.role === 'admin';
      const bot = await prisma.bot.findFirst({
        where: { id: body.botId, ...(isAdmin ? {} : { userId }) },
      });
      if (!bot) {
        return reply.code(400).send({ error: { code: 'invalid_bot', message: 'bot not found or not yours' } });
      }
    }

    const alert = await prisma.alert.create({
      data: {
        userId,
        botId: body.botId ?? null,
        channel: body.channel,
        config: body.config,
        triggerOn: body.triggerOn,
        enabled: body.enabled ?? true,
      },
      include: { bot: { select: { id: true, name: true } } },
    });
    return reply.code(201).send(alert);
  });

  app.patch<{ Params: { id: string } }>(
    '/api/alerts/:id',
    { preHandler: requireAuth('api') },
    async (req, reply) => {
      const userId = req.user?.id;
      if (!userId) return reply.code(401).send({ error: { code: 'no_session' } });

      const body = Patch.parse(req.body);
      const existing = await prisma.alert.findFirst({ where: { id: req.params.id, userId } });
      if (!existing) return reply.code(404).send({ error: { code: 'not_found' } });

      return prisma.alert.update({
        where: { id: req.params.id },
        data: {
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          ...(body.triggerOn !== undefined ? { triggerOn: body.triggerOn } : {}),
          ...(body.config !== undefined ? { config: body.config } : {}),
        },
        include: { bot: { select: { id: true, name: true } } },
      });
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/alerts/:id',
    { preHandler: requireAuth('api') },
    async (req, reply) => {
      const userId = req.user?.id;
      if (!userId) return reply.code(401).send({ error: { code: 'no_session' } });
      const existing = await prisma.alert.findFirst({ where: { id: req.params.id, userId } });
      if (!existing) return reply.code(404).send({ error: { code: 'not_found' } });
      await prisma.alert.delete({ where: { id: req.params.id } });
      return reply.code(204).send();
    },
  );
}
