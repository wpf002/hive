import type { FastifyRequest } from 'fastify';
import { prisma } from '@hive/db';

/**
 * Ownership scoping for read routes.
 *
 * Hive is multi-tenant: a Bot carries a `userId`, and everything downstream of
 * it — Jobs, JobLogs, Artifacts, trades — inherits that ownership through the
 * bot. Admins (and static-token callers) see everything; a `role:'user'`
 * principal sees only what descends from their own bots.
 *
 * These live here rather than being re-derived per route because they were
 * re-derived per route, and several routes simply forgot: jobs, artifacts, the
 * SSE log stream and the trading reads all returned every tenant's data to any
 * logged-in caller. A single shared helper makes the omission visible.
 *
 * Bots with `userId: null` are shared/admin bots and are deliberately NOT
 * visible to non-admins (same rule as routes/bots.ts).
 */

export function isAdmin(req: FastifyRequest): boolean {
  return req.staticAuth === 'api' || req.user?.role === 'admin';
}

/** `where` fragment scoping a Bot query to the caller. */
export function botOwnerFilter(req: FastifyRequest): { userId?: string } {
  if (isAdmin(req)) return {};
  return { userId: req.user?.id ?? 'nobody' };
}

/**
 * `where` fragment scoping a Job query to the caller, via the owning bot.
 * Empty for admins so it can be spread into any Job `where` unconditionally.
 */
export function jobOwnerFilter(req: FastifyRequest): { bot?: { userId: string } } {
  if (isAdmin(req)) return {};
  return { bot: { userId: req.user?.id ?? 'nobody' } };
}

/**
 * Loads a job only if the caller may see it.
 *
 * Returns null both when the job doesn't exist and when it belongs to someone
 * else, so callers 404 in both cases — a 403 would confirm the id is real and
 * turn the endpoint into an existence oracle.
 */
export async function findJobForCaller(
  req: FastifyRequest,
  jobId: string,
): Promise<{ id: string; botId: string } | null> {
  return prisma.job.findFirst({
    where: { id: jobId, ...jobOwnerFilter(req) },
    select: { id: true, botId: true },
  });
}

/** Job ids the caller may see. Used where a query can't join through Bot. */
export async function visibleJobIds(req: FastifyRequest): Promise<string[] | null> {
  if (isAdmin(req)) return null; // null = no restriction
  const rows = await prisma.job.findMany({
    where: jobOwnerFilter(req),
    select: { id: true },
  });
  return rows.map((r) => r.id);
}
