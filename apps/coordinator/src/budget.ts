import { prisma } from '@hive/db';
import { env } from './env.js';

/**
 * A hard ceiling on what one mission may spend per hour.
 *
 * The swarm's cost does not scale with the number of bots — gatherers are plain
 * HTTP jobs and cost nothing to run. It scales with how often the model-calling
 * roles fire, which is why a mission can look modest (thirty bots) and still
 * spend real money: at a 30-second floor with four subjects a pass, the analyst
 * alone makes eight calls a minute forever, whether or not anything changed.
 *
 * Rate knobs alone cannot bound that, because the right rate depends on how
 * much evidence is arriving, which nobody knows in advance. So the rate knobs
 * pace the work and this bounds the bill: past the cap, model calls are refused
 * until the trailing hour drops back under it. Gathering continues — evidence
 * keeps accumulating and gets analysed when the window reopens — so the mission
 * degrades by thinking less often rather than by going blind.
 *
 * Read from the mission's own `limits` so it travels with the mission, falling
 * back to the service default.
 */

/**
 * Cost of everything this account's missions have spent over the trailing day,
 * in microcents.
 *
 * The per-mission cap bounds one mission. It says nothing about an account
 * running twenty of them, which is the shape an actual bill takes — twenty
 * missions each politely under their own ceiling, adding up to something
 * nobody agreed to.
 */
export async function accountSpentLastDayMicroCents(userId: string): Promise<number> {
  const since = new Date(Date.now() - 24 * 3_600_000);
  const rows = await prisma.$queryRaw<{ micro: bigint | null }[]>`
    SELECT SUM(u."costMicroCents")::bigint AS micro
      FROM "AiUsage" u
      JOIN "Mission" m ON u."jobId" = CONCAT('mission:', m.id)
     WHERE m."userId" = ${userId}
       AND u."createdAt" >= ${since}
  `;
  return Number(rows[0]?.micro ?? 0);
}

/** Cost of one mission's model calls over the trailing hour, in microcents. */
export async function spentLastHourMicroCents(missionId: string): Promise<number> {
  const since = new Date(Date.now() - 3_600_000);
  const agg = await prisma.aiUsage.aggregate({
    where: { jobId: `mission:${missionId}`, createdAt: { gte: since } },
    _sum: { costMicroCents: true },
  });
  return agg._sum.costMicroCents ?? 0;
}

export function budgetCentsPerHour(limits: unknown): number {
  const raw = (limits as Record<string, unknown> | null)?.['budget:cents_per_hour'];
  const n = typeof raw === 'number' ? raw : Number(raw);
  // A zero or negative cap would silently stop the mission dead, which is worse
  // than an expensive mission: the operator would see a running swarm that
  // never concludes anything and no reason why. Fall back to the default.
  return Number.isFinite(n) && n > 0 ? n : env.MISSION_BUDGET_CENTS_PER_HOUR;
}

/**
 * Whether this mission may make another model call right now.
 *
 * Checked before the call rather than after, because the alternative is finding
 * out you were over budget by going over it.
 */
export async function withinBudget(
  missionId: string,
  limits: unknown,
  owner?: { userId: string; dailyCapCents: number },
): Promise<
  { ok: true } | { ok: false; spentCents: number; capCents: number; scope: 'mission' | 'account' }
> {
  const capCents = budgetCentsPerHour(limits);
  const spent = await spentLastHourMicroCents(missionId);
  const spentCents = spent / 10_000;
  if (spentCents >= capCents) {
    return { ok: false, spentCents, capCents, scope: 'mission' };
  }
  if (owner && owner.dailyCapCents > 0) {
    const accountCents = (await accountSpentLastDayMicroCents(owner.userId)) / 10_000;
    if (accountCents >= owner.dailyCapCents) {
      return {
        ok: false,
        spentCents: accountCents,
        capCents: owner.dailyCapCents,
        scope: 'account',
      };
    }
  }
  return { ok: true };
}
