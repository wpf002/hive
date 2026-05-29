import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { env } from './env.js';
import { findValidSession, SESSION_COOKIE } from './lib/sessions.js';
import { timingSafeEqualStr } from './lib/constant-time.js';

export type AuthScope = 'api' | 'worker' | 'any';
export type Role = 'admin' | 'user';

export interface AuthedUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthedUser;
    /** Set when the request was authed via the static API_AUTH_TOKEN rather than
     * a session. Static-token callers bypass role checks (treated as admin) so
     * CLI/scripts keep working after auth lands. */
    staticAuth?: 'api' | 'worker';
  }
}

function extractBearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h || typeof h !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

function extractSessionCookie(req: FastifyRequest): string | null {
  const cookies = (req as FastifyRequest & { cookies?: Record<string, string | undefined> }).cookies;
  return cookies?.[SESSION_COOKIE] ?? null;
}

async function tryAuthenticate(req: FastifyRequest): Promise<{ user?: AuthedUser; staticAuth?: 'api' | 'worker' }> {
  // 1) Session cookie (preferred for UI traffic).
  const cookieToken = extractSessionCookie(req);
  if (cookieToken) {
    const session = await findValidSession(cookieToken);
    if (session?.user) {
      return {
        user: {
          id: session.user.id,
          email: session.user.email,
          displayName: session.user.displayName,
          role: session.user.role === 'admin' ? 'admin' : 'user',
        },
      };
    }
  }
  // 2) Bearer token (workers + CLI scripts).
  const bearer = extractBearer(req);
  if (bearer) {
    if (timingSafeEqualStr(bearer, env.API_AUTH_TOKEN)) return { staticAuth: 'api' };
    if (timingSafeEqualStr(bearer, env.WORKER_AUTH_TOKEN)) return { staticAuth: 'worker' };
  }
  return {};
}

export function requireAuth(scope: AuthScope): preHandlerAsyncHookHandler {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = await tryAuthenticate(req);
    req.user = auth.user;
    req.staticAuth = auth.staticAuth;
    if (!auth.user && !auth.staticAuth) {
      return reply.code(401).send({
        error: { code: 'unauthorized', message: 'missing session cookie or bearer token' },
      });
    }
    if (scope === 'worker') {
      // Worker routes accept *only* the worker static token.
      if (auth.staticAuth !== 'worker') {
        return reply.code(403).send({
          error: { code: 'forbidden', message: 'worker scope requires WORKER_AUTH_TOKEN' },
        });
      }
      return;
    }
    if (scope === 'api') {
      // Session OR static API_AUTH_TOKEN.
      if (!auth.user && auth.staticAuth !== 'api') {
        return reply.code(403).send({
          error: { code: 'forbidden', message: 'invalid credentials for this scope' },
        });
      }
      return;
    }
    // 'any': either session OR either static token — already covered.
  };
}

export function requireRole(role: Role): preHandlerAsyncHookHandler {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = await tryAuthenticate(req);
    req.user = auth.user;
    req.staticAuth = auth.staticAuth;
    // Static API token is treated as admin-equivalent for CLI / scripts.
    if (auth.staticAuth === 'api') return;
    if (!auth.user) {
      return reply.code(401).send({ error: { code: 'unauthorized', message: 'login required' } });
    }
    if (role === 'admin' && auth.user.role !== 'admin') {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'admin role required' } });
    }
  };
}
