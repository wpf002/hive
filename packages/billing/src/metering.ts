import { prisma } from '@hive/db';
import { effectivePlan } from '@hive/shared';
import { periodBounds } from './period.js';

/**
 * What an account has used, and what it will be billed for.
 *
 * Two different questions with two different answers, which is the whole
 * reason this file exists. "What is my swarm costing me right now" has to be
 * live, computed from usage rows as they land. "What do I owe for March" has
 * to be frozen, because usage rows are operational data — pruned, backfilled,
 * corrected — and a bill that changes when they do is not a bill.
 *
 * So an open period is recomputed on every read, and a closed one is never
 * recomputed at all.
 */

export interface UsageTotals {
  modelCostMicroCents: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  jobsRun: number;
}

/**
 * Measure one account's usage over a window, straight from the source tables.
 *
 * Model spend joins usage back to an owner through the mission it was tagged
 * with. Usage that carries no mission tag — an ai_agent job run directly —
 * is attributed through the bot instead, so the two paths a customer can spend
 * money on both land on their bill rather than only the one.
 */
export async function measureUsage(
  userId: string,
  start: Date,
  end: Date,
): Promise<UsageTotals> {
  const [model, jobs] = await Promise.all([
    prisma.$queryRaw<
      { micro: bigint | null; calls: bigint | null; input: bigint | null; output: bigint | null }[]
    >`
      SELECT SUM(u."costMicroCents")::bigint AS micro,
             COUNT(*)::bigint               AS calls,
             SUM(u."inputTokens")::bigint   AS input,
             SUM(u."outputTokens")::bigint  AS output
        FROM "AiUsage" u
        LEFT JOIN "Mission" m ON u."jobId" = CONCAT('mission:', m.id)
        LEFT JOIN "Job"     j ON u."jobId" = j.id
        LEFT JOIN "Bot"     b ON j."botId" = b.id
       WHERE u."createdAt" >= ${start}
         AND u."createdAt" <  ${end}
         AND COALESCE(m."userId", b."userId") = ${userId}
    `,
    prisma.$queryRaw<{ jobs: bigint | null }[]>`
      SELECT COUNT(*)::bigint AS jobs
        FROM "Job" j
        JOIN "Bot" b ON b.id = j."botId"
       WHERE b."userId" = ${userId}
         AND j."createdAt" >= ${start}
         AND j."createdAt" <  ${end}
    `,
  ]);
  const m = model[0];
  return {
    modelCostMicroCents: Number(m?.micro ?? 0),
    modelCalls: Number(m?.calls ?? 0),
    inputTokens: Number(m?.input ?? 0),
    outputTokens: Number(m?.output ?? 0),
    jobsRun: Number(jobs[0]?.jobs ?? 0),
  };
}

/**
 * The account's current period, refreshed from live usage.
 *
 * Upserted rather than created-if-missing so a period that already closed is
 * left alone: closing is a one-way door, and a late-arriving usage row must
 * not silently reopen a bill somebody has already been sent.
 */
export async function refreshCurrentPeriod(userId: string, now = new Date()) {
  const { start, end } = periodBounds(now);
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { plan: true, quotaMaxBots: true, quotaMaxMissions: true, quotaDailySpendCents: true },
  });
  if (!user) return null;
  const plan = effectivePlan(user);

  const existing = await prisma.usagePeriod.findUnique({
    where: { userId_periodStart: { userId, periodStart: start } },
  });
  if (existing && existing.status !== 'open') return existing;

  const totals = await measureUsage(userId, start, end);
  return prisma.usagePeriod.upsert({
    where: { userId_periodStart: { userId, periodStart: start } },
    create: {
      userId,
      periodStart: start,
      periodEnd: end,
      plan: plan.id,
      planLabel: plan.label,
      modelCostMicroCents: BigInt(totals.modelCostMicroCents),
      modelCalls: totals.modelCalls,
      inputTokens: BigInt(totals.inputTokens),
      outputTokens: BigInt(totals.outputTokens),
      jobsRun: totals.jobsRun,
    },
    update: {
      plan: plan.id,
      planLabel: plan.label,
      modelCostMicroCents: BigInt(totals.modelCostMicroCents),
      modelCalls: totals.modelCalls,
      inputTokens: BigInt(totals.inputTokens),
      outputTokens: BigInt(totals.outputTokens),
      jobsRun: totals.jobsRun,
    },
  });
}

/**
 * Freeze every open period that has ended.
 *
 * Runs on a schedule rather than at a month boundary exactly: a job that must
 * fire at midnight on the first is a job that silently skips a month when the
 * process happens to be restarting. Anything ended and still open gets closed,
 * however late.
 */
export async function closeEndedPeriods(now = new Date()): Promise<number> {
  const due = await prisma.usagePeriod.findMany({
    where: { status: 'open', periodEnd: { lte: now } },
    select: { id: true, userId: true, periodStart: true, periodEnd: true },
  });
  let closed = 0;
  for (const p of due) {
    // One last measurement, then never again.
    const totals = await measureUsage(p.userId, p.periodStart, p.periodEnd);
    // Conditional on still being open, so two schedulers cannot both close it
    // and double-count.
    const res = await prisma.usagePeriod.updateMany({
      where: { id: p.id, status: 'open' },
      data: {
        status: 'closed',
        closedAt: now,
        modelCostMicroCents: BigInt(totals.modelCostMicroCents),
        modelCalls: totals.modelCalls,
        inputTokens: BigInt(totals.inputTokens),
        outputTokens: BigInt(totals.outputTokens),
        jobsRun: totals.jobsRun,
      },
    });
    closed += res.count;
  }
  return closed;
}
