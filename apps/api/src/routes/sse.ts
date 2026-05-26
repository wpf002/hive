import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '@hive/db';
import { env } from '../env.js';
import { createBlockingRedis, STREAMS } from '../redis.js';
import { findValidSession, SESSION_COOKIE } from '../lib/sessions.js';

const HEARTBEAT_MS = 15_000;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

function sseWrite(reply: FastifyReply, event: string, data: unknown) {
  reply.raw.write(`event: ${event}\n`);
  reply.raw.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
}

async function authorize(req: FastifyRequest): Promise<boolean> {
  // 1) Bearer token (header or ?token= query fallback for tooling).
  const header = req.headers.authorization;
  const headerToken = typeof header === 'string' ? /^Bearer\s+(.+)$/i.exec(header.trim())?.[1] : undefined;
  const queryToken = (req.query as Record<string, unknown>)?.token;
  const token = headerToken ?? (typeof queryToken === 'string' ? queryToken : undefined);
  if (token === env.API_AUTH_TOKEN) return true;
  // 2) Session cookie.
  const cookies = (req as FastifyRequest & { cookies?: Record<string, string | undefined> }).cookies;
  const sessionToken = cookies?.[SESSION_COOKIE];
  if (sessionToken) {
    const session = await findValidSession(sessionToken);
    if (session) return true;
  }
  return false;
}

export async function sseRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/api/jobs/:id/stream', async (req, reply) => {
    if (!(await authorize(req))) {
      return reply.code(401).send({ error: { code: 'unauthorized', message: 'missing bearer token' } });
    }

    const jobId = req.params.id;
    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'job not found' } });
    }

    // CORS: @fastify/cors hooks into onSend, but reply.raw.writeHead bypasses
    // that pipeline entirely — so we need to echo the origin ourselves or the
    // browser blocks the streaming response with "Failed to fetch" even though
    // the OPTIONS preflight succeeded.
    const headers: Record<string, string> = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    };
    const origin = req.headers.origin;
    if (origin) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Access-Control-Allow-Credentials'] = 'true';
      headers['Vary'] = 'Origin';
    }
    reply.raw.writeHead(200, headers);
    // Tell Fastify we're streaming raw.
    reply.hijack();

    // 1) Backfill from Postgres.
    const backfill = await prisma.jobLog.findMany({
      where: { jobId },
      orderBy: { timestamp: 'asc' },
      take: 500,
    });
    for (const log of backfill) {
      sseWrite(reply, 'log', {
        ts: log.timestamp.toISOString(),
        level: log.level,
        message: log.message,
        meta: log.meta ?? undefined,
      });
    }
    sseWrite(reply, 'backfill_complete', { count: backfill.length });

    // 2) If already terminal, emit done and close.
    if (TERMINAL.has(job.status)) {
      sseWrite(reply, 'done', { status: job.status });
      reply.raw.end();
      return;
    }

    // 3) Subscribe to live log channel.
    const sub = createBlockingRedis();
    const channel = STREAMS.logs(jobId);

    const heartbeat = setInterval(() => {
      try { reply.raw.write(`: ping\n\n`); } catch { /* connection closed */ }
    }, HEARTBEAT_MS);

    const cleanup = async () => {
      clearInterval(heartbeat);
      try { await sub.unsubscribe(channel); } catch { /* ignore */ }
      try { await sub.quit(); } catch { /* ignore */ }
      try { reply.raw.end(); } catch { /* ignore */ }
    };

    sub.on('message', (_chan, raw) => {
      try {
        const payload = JSON.parse(raw);
        if (payload?.__terminal) {
          sseWrite(reply, 'done', { status: payload.status ?? 'succeeded' });
          void cleanup();
          return;
        }
        sseWrite(reply, 'log', payload);
      } catch (e) {
        req.log.warn({ err: e, raw }, 'sse_parse_failed');
      }
    });

    sub.on('error', (err) => {
      req.log.error({ err }, 'sse_redis_error');
      void cleanup();
    });

    await sub.subscribe(channel);

    req.raw.on('close', () => { void cleanup(); });
  });
}
