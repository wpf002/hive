import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, Prisma } from '@hive/db';
import { requireAuth } from '../auth.js';

// Field names whose values should be masked on outbound GETs (keep last 4 chars).
// Trading bots store apiSecret + apiKey; Discord/Telegram store botToken.
const SECRET_KEYS = new Set(['apiSecret', 'apiKey', 'botToken']);

function maskValue(v: unknown): unknown {
  if (typeof v !== 'string' || v.length === 0) return v;
  if (v.length <= 4) return '****';
  return '****' + v.slice(-4);
}

function maskConfig(config: unknown): unknown {
  if (config == null || typeof config !== 'object') return config;
  const out: Record<string, unknown> = { ...(config as Record<string, unknown>) };
  for (const k of Object.keys(out)) {
    if (SECRET_KEYS.has(k)) out[k] = maskValue(out[k]);
  }
  return out;
}

function maskBot<T extends { config: unknown }>(bot: T): T {
  return { ...bot, config: maskConfig(bot.config) };
}

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
    const rows = await prisma.bot.findMany({
      orderBy: { createdAt: 'desc' },
      include: { template: true },
    });
    return rows.map(maskBot);
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
      return maskBot(bot);
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
