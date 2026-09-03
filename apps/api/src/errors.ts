import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { Prisma } from '@hive/db';
import { captureError } from '@hive/observability';

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
    if (status >= 500) {
      req.log.error({ err }, 'request_failed');
      // A 5xx is a bug in this service, not a caller mistake, so it goes to
      // error reporting as well as the log. 4xx deliberately does not: a
      // stream of validation failures is a client with a bad request, and
      // reporting those would bury the ones that are actually ours.
      captureError(err, {
        where: `${req.method} ${req.routeOptions?.url ?? req.url}`,
        // The route pattern, not the filled-in URL — ids in an error title
        // fragment it into one issue per request. And never the body or query,
        // which carry credentials on exactly the routes most likely to fail.
        extra: { requestId: req.id, statusCode: status },
      });
    }
    return reply.code(status).send({
      error: { code: err.code ?? 'internal_error', message: err.message ?? 'Internal error' },
    });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: { code: 'not_found', message: `No route ${req.method} ${req.url}` } });
  });
}
