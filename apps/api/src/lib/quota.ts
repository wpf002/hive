import { prisma } from '@hive/db';
import { effectivePlan, type Plan } from '@hive/shared';

/**
 * What this account has already used, against what it is allowed.
 *
 * Counted from the live rows rather than kept as a running total on the user.
 * A counter drifts — every path that creates or deletes a bot has to remember
 * to move it, and the one that forgets is silent until somebody is either
 * over their limit or unable to reach it. The tables already know.
 */
export interface QuotaUsage {
  plan: Plan;
  bots: number;
  missions: number;
}

export async function quotaFor(userId: string): Promise<QuotaUsage> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      plan: true,
      quotaMaxBots: true,
      quotaMaxMissions: true,
      quotaDailySpendCents: true,
    },
  });
  if (!user) throw new Error(`no such user: ${userId}`);
  const [bots, missions] = await Promise.all([
    prisma.bot.count({ where: { userId } }),
    prisma.mission.count({ where: { userId } }),
  ]);
  return { plan: effectivePlan(user), bots, missions };
}

export interface QuotaRefusal {
  code: 'bot_quota' | 'mission_quota';
  message: string;
}

/**
 * Whether this account may create `newBots` more bots and `newMissions` more
 * missions.
 *
 * The message names the plan's number and the current one, because "quota
 * exceeded" tells someone they cannot do the thing without telling them what
 * would let them.
 */
export function checkHeadroom(
  usage: QuotaUsage,
  want: { bots?: number; missions?: number },
): QuotaRefusal | null {
  const bots = want.bots ?? 0;
  const missions = want.missions ?? 0;
  if (usage.bots + bots > usage.plan.maxBots) {
    return {
      code: 'bot_quota',
      message:
        `Your ${usage.plan.label} plan allows ${usage.plan.maxBots} bots and you have ` +
        `${usage.bots}. This would need ${bots} more. Stop a mission you are no longer ` +
        `watching, or move to a larger plan.`,
    };
  }
  if (usage.missions + missions > usage.plan.maxMissions) {
    return {
      code: 'mission_quota',
      message:
        `Your ${usage.plan.label} plan allows ${usage.plan.maxMissions} missions and you ` +
        `have ${usage.missions}. Delete one you are finished with, or move to a larger plan.`,
    };
  }
  return null;
}
