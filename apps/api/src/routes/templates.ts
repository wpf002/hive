import type { FastifyInstance } from 'fastify';
import { prisma } from '@hive/db';
import { requireAuth } from '../auth.js';

export async function templateRoutes(app: FastifyInstance) {
  app.get('/api/templates', { preHandler: requireAuth('api') }, async () => {
    return prisma.botTemplate.findMany({ orderBy: { createdAt: 'asc' } });
  });

  app.get<{ Params: { id: string } }>(
    '/api/templates/:id',
    { preHandler: requireAuth('api') },
    async (req, reply) => {
      const t = await prisma.botTemplate.findUnique({ where: { id: req.params.id } });
      if (!t) return reply.code(404).send({ error: { code: 'not_found', message: 'template not found' } });
      return t;
    },
  );
}
