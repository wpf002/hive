import type { FastifyInstance } from 'fastify';
import { prisma } from '@hive/db';
import { requireAuth } from '../auth.js';
import { quotaFor } from '../lib/quota.js';
import { refreshCurrentPeriod } from '@hive/billing';

/**
 * What this account is using, and against what.
 *
 * One screen's worth of the only questions a customer actually asks about
 * billing: what am I spending, on what, how much of my plan is left, and what
 * did previous months come to. Cents are returned as numbers with two decimal
 * places of precision preserved, not rounded to whole cents — rounding per
 * call is exactly how the spend figures were wrong before.
 */
function centsFromMicro(micro: bigint | number): number {
  return Math.round(Number(micro) / 100) / 100;
}

export async function usageRoutes(app: FastifyInstance) {
  app.get('/api/usage', { preHandler: requireAuth('api') }, async (req, reply) => {
    const userId = req.user?.id;
    if (!userId) {
      // A static operator token is not a tenant and has no bill.
      return reply
        .code(400)
        .send({ error: { code: 'no_user', message: 'usage is per-account; use a user session' } });
    }

    const [period, usage] = await Promise.all([
      refreshCurrentPeriod(userId),
      quotaFor(userId),
    ]);

    // Spend over the trailing day, because that is the window the account
    // ceiling is enforced on — showing a monthly total next to a daily limit
    // would invite exactly the wrong arithmetic.
    const dayAgo = new Date(Date.now() - 24 * 3_600_000);
    const today = await prisma.$queryRaw<{ micro: bigint | null }[]>`
      SELECT SUM(u."costMicroCents")::bigint AS micro
        FROM "AiUsage" u
        JOIN "Mission" m ON u."jobId" = CONCAT('mission:', m.id)
       WHERE m."userId" = ${userId} AND u."createdAt" >= ${dayAgo}
    `;
    const todayCents = centsFromMicro(today[0]?.micro ?? 0n);

    return reply.send({
      plan: {
        id: usage.plan.id,
        label: usage.plan.label,
        maxBots: usage.plan.maxBots,
        maxMissions: usage.plan.maxMissions,
        dailySpendCents: usage.plan.dailySpendCents,
        poolShare: usage.plan.poolShare,
      },
      // Headroom rather than raw counts: "6 of 30 bots" is what someone needs
      // to decide whether they can start another mission.
      inUse: {
        bots: usage.bots,
        missions: usage.missions,
        botsRemaining: Math.max(0, usage.plan.maxBots - usage.bots),
        missionsRemaining: Math.max(0, usage.plan.maxMissions - usage.missions),
      },
      today: {
        spendCents: todayCents,
        limitCents: usage.plan.dailySpendCents,
        // The thing that actually happens when it is reached: thinking pauses,
        // gathering does not.
        atLimit: todayCents >= usage.plan.dailySpendCents,
      },
      currentPeriod: period && {
        start: period.periodStart,
        end: period.periodEnd,
        status: period.status,
        spendCents: centsFromMicro(period.modelCostMicroCents),
        modelCalls: period.modelCalls,
        jobsRun: period.jobsRun,
      },
    });
  });

  app.get('/api/usage/history', { preHandler: requireAuth('api') }, async (req, reply) => {
    const userId = req.user?.id;
    if (!userId) {
      return reply
        .code(400)
        .send({ error: { code: 'no_user', message: 'usage is per-account; use a user session' } });
    }
    const periods = await prisma.usagePeriod.findMany({
      where: { userId, status: { not: 'open' } },
      orderBy: { periodStart: 'desc' },
      take: 24,
    });
    return reply.send({
      periods: periods.map((p) => ({
        start: p.periodStart,
        end: p.periodEnd,
        plan: p.planLabel,
        status: p.status,
        spendCents: centsFromMicro(p.modelCostMicroCents),
        modelCalls: p.modelCalls,
        inputTokens: Number(p.inputTokens),
        outputTokens: Number(p.outputTokens),
        jobsRun: p.jobsRun,
        closedAt: p.closedAt,
      })),
    });
  });
}
