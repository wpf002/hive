import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, Prisma } from '@hive/db';
import { requireAuth } from '../auth.js';

const Create = z.object({
  templateId: z.string().min(1),
  name: z.string().min(1),
  config: z.record(z.unknown()).default({}),
  enabled: z.boolean().optional(),
});

const Patch = z.object({
  name: z.string().min(1).optional(),
  config: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional(),
});

export async function botRoutes(app: FastifyInstance) {
  app.post('/api/bots', { preHandler: requireAuth('api') }, async (req, reply) => {
    const body = Create.parse(req.body);
    const template = await prisma.botTemplate.findUnique({ where: { id: body.templateId } });
    if (!template) {
      return reply.code(400).send({
        error: { code: 'invalid_template', message: `templateId ${body.templateId} not found` },
      });
    }
    // TODO(phase-2): validate body.config against template.configSchema (JSON Schema)
    const bot = await prisma.bot.create({
      data: {
        templateId: body.templateId,
        name: body.name,
        config: body.config as Prisma.InputJsonValue,
        enabled: body.enabled ?? true,
      },
    });
    return reply.code(201).send(bot);
  });

  app.get('/api/bots', { preHandler: requireAuth('api') }, async () => {
    return prisma.bot.findMany({
      orderBy: { createdAt: 'desc' },
      include: { template: true },
    });
  });

  app.get<{ Params: { id: string } }>(
    '/api/bots/:id',
    { preHandler: requireAuth('api') },
    async (req, reply) => {
      const bot = await prisma.bot.findUnique({
        where: { id: req.params.id },
        include: {
          template: true,
          jobs: { orderBy: { createdAt: 'desc' }, take: 10 },
        },
      });
      if (!bot) return reply.code(404).send({ error: { code: 'not_found', message: 'bot not found' } });
      return bot;
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/api/bots/:id',
    { preHandler: requireAuth('api') },
    async (req) => {
      const body = Patch.parse(req.body);
      const data: Prisma.BotUpdateInput = {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.config !== undefined ? { config: body.config as Prisma.InputJsonValue } : {}),
      };
      return prisma.bot.update({ where: { id: req.params.id }, data });
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/bots/:id',
    { preHandler: requireAuth('api') },
    async (req, reply) => {
      await prisma.bot.delete({ where: { id: req.params.id } });
      return reply.code(204).send();
    },
  );
}
