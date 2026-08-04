import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma, Prisma } from '@hive/db';
import { requireAuth, requireRole } from '../auth.js';
import { encryptBotConfig, maskBotConfig } from '../lib/secrets.js';

type TemplateForSecrets = { configSchema: unknown };

interface BotWithTemplate {
  config: unknown;
  template: TemplateForSecrets;
}

function maskBot<T extends BotWithTemplate>(bot: T): T {
  return { ...bot, config: maskBotConfig(bot.template, bot.config) };
}

/** Returns true if the request carries admin-equivalent credentials. */
function isAdmin(req: FastifyRequest): boolean {
  return req.staticAuth === 'api' || req.user?.role === 'admin';
}

/**
 * Prisma `where` clause that limits Bot reads to the requesting user's bots.
 * Admins (and static-token callers) see everything.
 */
function botOwnerFilter(req: FastifyRequest): { userId?: string } {
  if (isAdmin(req)) return {};
  return { userId: req.user?.id ?? 'nobody' };
}

// Phase 5b: optional dispatch-time placement.
const AffinitySchema = z
  .object({
    region: z.string().min(1).optional(),
    zone: z.string().min(1).optional(),
  })
  .nullable()
  .optional();

const Create = z.object({
  templateId: z.string().min(1),
  name: z.string().min(1),
  config: z.record(z.unknown()).default({}),
  enabled: z.boolean().optional(),
  affinityOverride: AffinitySchema,
});

const Patch = z.object({
  name: z.string().min(1).optional(),
  config: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional(),
  affinityOverride: AffinitySchema,
});

export async function botRoutes(app: FastifyInstance) {
  // Any authenticated user can create a bot — it's scoped to them.
  // Admins create shared bots (userId = null).
  app.post('/api/bots', { preHandler: requireAuth('api') }, async (req, reply) => {
    const body = Create.parse(req.body);
    const template = await prisma.botTemplate.findUnique({ where: { id: body.templateId } });
    if (!template) {
      return reply.code(400).send({
        error: { code: 'invalid_template', message: `templateId ${body.templateId} not found` },
      });
    }
    const encryptedConfig = await encryptBotConfig(template, body.config);
    const bot = await prisma.bot.create({
      data: {
        templateId: body.templateId,
        name: body.name,
        config: encryptedConfig as Prisma.InputJsonValue,
        enabled: body.enabled ?? true,
        // Non-admins own their bots; admins create shared bots (userId = null).
        userId: isAdmin(req) ? null : (req.user?.id ?? null),
        affinityOverride:
          body.affinityOverride === undefined || body.affinityOverride === null
            ? Prisma.JsonNull
            : (body.affinityOverride as Prisma.InputJsonValue),
      },
      include: { template: true },
    });
    return reply.code(201).send(maskBot(bot));
  });

  // Users see only their own bots; admins see all.
  app.get('/api/bots', { preHandler: requireAuth('api') }, async (req) => {
    const rows = await prisma.bot.findMany({
      where: botOwnerFilter(req),
      orderBy: { createdAt: 'desc' },
      include: { template: true },
    });
    return rows.map(maskBot);
  });

  app.get<{ Params: { id: string } }>(
    '/api/bots/:id',
    { preHandler: requireAuth('api') },
    async (req, reply) => {
      const bot = await prisma.bot.findFirst({
        where: { id: req.params.id, ...botOwnerFilter(req) },
        include: {
          template: true,
          jobs: { orderBy: { createdAt: 'desc' }, take: 10 },
        },
      });
      if (!bot) return reply.code(404).send({ error: { code: 'not_found', message: 'bot not found' } });
      return maskBot(bot);
    },
  );

  // Users can edit/delete their own bots; admins can edit/delete anything.
  app.patch<{ Params: { id: string } }>(
    '/api/bots/:id',
    { preHandler: requireAuth('api') },
    async (req, reply) => {
      const body = Patch.parse(req.body);
      const existing = await prisma.bot.findFirst({
        where: { id: req.params.id, ...botOwnerFilter(req) },
        include: { template: true },
      });
      if (!existing) {
        return reply.code(404).send({ error: { code: 'not_found', message: 'bot not found' } });
      }
      const data: Prisma.BotUpdateInput = {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.affinityOverride !== undefined
          ? {
              affinityOverride:
                body.affinityOverride === null
                  ? Prisma.JsonNull
                  : (body.affinityOverride as Prisma.InputJsonValue),
            }
          : {}),
      };
      if (body.config !== undefined) {
        const merged = { ...(existing.config as Record<string, unknown>), ...body.config };
        data.config = (await encryptBotConfig(existing.template, merged)) as Prisma.InputJsonValue;
      }
      const updated = await prisma.bot.update({
        where: { id: req.params.id },
        data,
        include: { template: true },
      });
      return maskBot(updated);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/bots/:id',
    { preHandler: requireAuth('api') },
    async (req, reply) => {
      const existing = await prisma.bot.findFirst({
        where: { id: req.params.id, ...botOwnerFilter(req) },
      });
      if (!existing) {
        return reply.code(404).send({ error: { code: 'not_found', message: 'bot not found' } });
      }
      await prisma.bot.delete({ where: { id: req.params.id } });
      return reply.code(204).send();
    },
  );
}
