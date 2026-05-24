import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { env } from './env.js';

export type AuthScope = 'api' | 'worker' | 'any';

function extractBearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h || typeof h !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

export function requireAuth(scope: AuthScope): preHandlerAsyncHookHandler {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const token = extractBearer(req);
    if (!token) {
      return reply.code(401).send({ error: { code: 'unauthorized', message: 'missing bearer token' } });
    }
    const matchesApi = token === env.API_AUTH_TOKEN;
    const matchesWorker = token === env.WORKER_AUTH_TOKEN;
    const ok =
      scope === 'api' ? matchesApi :
      scope === 'worker' ? matchesWorker :
      matchesApi || matchesWorker;
    if (!ok) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'invalid token for this scope' } });
    }
  };
}
