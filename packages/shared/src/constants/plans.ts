/**
 * What an account is allowed to do.
 *
 * Every limit here exists because the resource behind it is shared and finite.
 * Worker pools are the clearest case: throughput is measured for the whole
 * installation, so without a per-tenant share the first customer to describe
 * two hundred subjects takes the pool and everybody else's feeds sit queued
 * behind them. That is not a fairness nicety — it is one customer being able
 * to break the product for the rest by using it as intended.
 *
 * Spend is the other one. Missions spend money autonomously, so an account
 * with no ceiling is an unbounded liability that only stops when somebody
 * notices.
 */
export interface Plan {
  id: string;
  label: string;
  /** Gatherer bots this account may have across all missions. */
  maxBots: number;
  /** Missions that may exist at once, running or not. */
  maxMissions: number;
  /**
   * Share of any one worker pool's measured throughput this account may claim,
   * 0–1. Not a queue priority — a hard ceiling applied when a mission is sized,
   * so the limit is visible at the moment someone asks for too much rather than
   * as unexplained slowness later.
   */
  poolShare: number;
  /**
   * Model spend per rolling day, in cents. The coordinator refuses model calls
   * past it; gathering continues, so a mission that hits the ceiling goes quiet
   * rather than blind, and resumes on its own as the window rolls forward.
   */
  dailySpendCents: number;
}

export const PLANS: Record<string, Plan> = {
  free: {
    id: 'free',
    label: 'Free',
    // Enough to watch one thing across a few sources and see the product work.
    maxBots: 30,
    maxMissions: 2,
    poolShare: 0.1,
    dailySpendCents: 200, // $2/day
  },
  pro: {
    id: 'pro',
    label: 'Pro',
    maxBots: 300,
    maxMissions: 20,
    poolShare: 0.4,
    dailySpendCents: 5_000, // $50/day
  },
  enterprise: {
    id: 'enterprise',
    label: 'Enterprise',
    maxBots: 2_000,
    maxMissions: 200,
    poolShare: 1,
    dailySpendCents: 100_000, // $1,000/day
  },
};

export const DEFAULT_PLAN = PLANS.free;

/** The limits that actually apply to an account: its plan, with any overrides. */
export function effectivePlan(user: {
  plan?: string | null;
  quotaMaxBots?: number | null;
  quotaMaxMissions?: number | null;
  quotaDailySpendCents?: number | null;
}): Plan {
  // An unknown plan name falls back rather than throwing. A renamed tier
  // should degrade an account to the smallest limits, not lock it out of a
  // product it is paying for.
  const base = PLANS[user.plan ?? ''] ?? DEFAULT_PLAN;
  return {
    ...base,
    maxBots: user.quotaMaxBots ?? base.maxBots,
    maxMissions: user.quotaMaxMissions ?? base.maxMissions,
    dailySpendCents: user.quotaDailySpendCents ?? base.dailySpendCents,
  };
}
