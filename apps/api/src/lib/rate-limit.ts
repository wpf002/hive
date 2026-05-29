import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { redis } from '../redis.js';

/**
 * Lightweight fixed-window rate limiter backed by Redis (so the limit holds
 * across multiple API instances). Used to blunt brute-force attacks on the
 * auth endpoints. Fails open if Redis is unavailable — availability of login
 * matters more than perfect enforcement, and other layers still apply.
 */
export function rateLimit(opts: {
  /** Logical bucket name, e.g. 'login'. */
  name: string;
  /** Max requests allowed per window. */
  max: number;
  /** Window length in seconds. */
  windowSec: number;
  /** Derive the client key (defaults to source IP). */
  keyFn?: (req: FastifyRequest) => string;
}): preHandlerAsyncHookHandler {
  const keyFn = opts.keyFn ?? ((req) => req.ip);
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const key = `hive:ratelimit:${opts.name}:${keyFn(req)}`;
    try {
      const count = await redis.incr(key);
      if (count === 1) {
        await redis.expire(key, opts.windowSec);
      }
      if (count > opts.max) {
        const ttl = await redis.ttl(key);
        if (ttl > 0) reply.header('Retry-After', String(ttl));
        return reply.code(429).send({
          error: { code: 'rate_limited', message: 'too many requests — try again later' },
        });
      }
    } catch (err) {
      // Fail open: never let a Redis hiccup lock everyone out of login.
      req.log.warn({ err, bucket: opts.name }, 'rate_limit_unavailable');
    }
  };
}
