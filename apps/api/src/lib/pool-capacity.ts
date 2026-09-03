import { prisma } from '@hive/db';
import { workerAvailable } from '@hive/shared';

/**
 * How much scheduled work a worker pool can actually absorb.
 *
 * "How many bots is too many" has no single answer, because the pools differ by
 * two orders of magnitude. Measured over this instance's own job history:
 *
 *   monitor   0.34s a job, 16 concurrent  ->  ~2800 jobs/minute
 *   scraper   0.20s a job,  8 concurrent  ->  ~2400 jobs/minute
 *   browser   6.51s a job,  4 concurrent  ->    ~37 jobs/minute
 *
 * A fan-out that is trivial on the monitor pool is 75x oversubscribed on the
 * browser pool. Composing against a fixed bot cap would therefore be wrong in
 * both directions at once: needlessly strict for cheap pools, and still far too
 * loose for expensive ones, where the visible result is a queue that never
 * drains and a mission that looks broken.
 *
 * So the ceiling is derived per pool from what this installation has actually
 * observed, rather than from a number someone picked.
 */

/** Fallback seconds-per-job when a pool has no history yet. Deliberately slow:
 *  under-estimating throughput queues jobs, over-estimating drops evidence. */
const UNKNOWN_POOL_SECONDS = 10;
const LOOKBACK_HOURS = 24;
/** Leave headroom — a pool run at exactly 100% has no room for a retry. */
const UTILISATION = 0.7;

export interface PoolCapacity {
  poolType: string;
  concurrency: number;
  secondsPerJob: number;
  /** Sustainable jobs per minute, with headroom. */
  jobsPerMinute: number;
}

/**
 * Measured throughput per pool.
 *
 * Duration is taken at the 90th percentile rather than the mean. The mean hides
 * exactly the case that matters: the browser pool averages 6.5s but its p90 is
 * 30s, and a fleet sized on the average spends most of its time backed up
 * behind the slow tail.
 */
export async function measurePoolCapacity(): Promise<Map<string, PoolCapacity>> {
  const onlineSince = new Date(Date.now() - 30_000);
  const workers = await prisma.worker.groupBy({
    by: ['poolType'],
    where: { lastSeenAt: { gt: onlineSince }, ...workerAvailable },
    _sum: { capacity: true },
  });

  const rows = await prisma.$queryRaw<{ poolType: string; p90: number | null }[]>`
    SELECT t."poolType" AS "poolType",
           percentile_cont(0.9) WITHIN GROUP (
             ORDER BY EXTRACT(EPOCH FROM (j."finishedAt" - j."startedAt"))
           ) AS p90
      FROM "Job" j
      JOIN "Bot" b ON b.id = j."botId"
      JOIN "BotTemplate" t ON t.id = b."templateId"
     WHERE j."finishedAt" IS NOT NULL
       AND j."startedAt" IS NOT NULL
       AND j."createdAt" > NOW() - (${LOOKBACK_HOURS} || ' hours')::interval
     GROUP BY 1
  `;
  const p90 = new Map(rows.map((r) => [r.poolType, Number(r.p90) || 0]));

  const out = new Map<string, PoolCapacity>();
  for (const w of workers) {
    const concurrency = Math.max(1, w._sum.capacity ?? 1);
    const secondsPerJob = Math.max(0.05, p90.get(w.poolType) || UNKNOWN_POOL_SECONDS);
    out.set(w.poolType, {
      poolType: w.poolType,
      concurrency,
      secondsPerJob,
      jobsPerMinute: (concurrency / secondsPerJob) * 60 * UTILISATION,
    });
  }
  return out;
}

export { maxBotsForPool, cronMinutes } from './pool-sizing.js';
