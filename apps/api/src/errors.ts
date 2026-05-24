import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { Prisma } from '@hive/db';

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: { code: 'validation_error', message: 'Invalid request', issues: err.issues },
      });
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === 'P2025') {
        return reply.code(404).send({ error: { code: 'not_found', message: 'Resource not found' } });
      }
      return reply.code(400).send({ error: { code: `prisma_${err.code}`, message: err.message } });
    }
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err }, 'request_failed');
    return reply.code(status).send({
      error: { code: err.code ?? 'internal_error', message: err.message ?? 'Internal error' },
    });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: { code: 'not_found', message: `No route ${req.method} ${req.url}` } });
  });
}
