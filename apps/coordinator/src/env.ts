import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  COORDINATOR_PORT: z.coerce.number().int().positive().default(4200),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  // Required to run a mission — the coordinator's decision step is a model
  // call. Without it, missions stay parked and the service logs a clear error
  // rather than spinning a loop that can never decide anything.
  ANTHROPIC_API_KEY: z.string().optional(),
  HIVE_COORDINATOR_MODEL: z.string().default('claude-sonnet-5'),
  // How often we reconcile running missions against active loops.
  COORDINATOR_RECONCILE_MS: z.coerce.number().int().positive().default(10_000),
  // Hard TTL on a proposal. A human approval landing after this is refused.
  PROPOSAL_TTL_MS: z.coerce.number().int().positive().default(5 * 60_000),
  // Floor on the gap between two coordinator model calls for one mission.
  // The loop is event-triggered, so a burst of board writes would otherwise
  // mean a burst of model calls; this collapses them into one.
  COORDINATOR_MIN_INTERVAL_MS: z.coerce.number().int().nonnegative().default(15_000),

  // ---- agent runtime ----
  // The gatherer bridge polls for completed jobs. Gatherers run on cron, so
  // seconds of lag are irrelevant and a replayable cursor beats a pub/sub
  // message that can be missed.
  GATHERER_POLL_MS: z.coerce.number().int().positive().default(10_000),
  GATHERER_BATCH: z.coerce.number().int().positive().default(50),

  // Analyst and adversary are model calls, so both are rate-floored the same
  // way the coordinator is: a burst of board writes collapses into one call.
  ANALYST_MIN_INTERVAL_MS: z.coerce.number().int().nonnegative().default(30_000),
  ADVERSARY_MIN_INTERVAL_MS: z.coerce.number().int().nonnegative().default(45_000),
  // Findings per analyst call. Larger batches mean fewer, better-informed calls.
  ANALYST_BATCH: z.coerce.number().int().positive().default(40),
  HIVE_ANALYST_MODEL: z.string().default('claude-sonnet-5'),
  HIVE_ADVERSARY_MODEL: z.string().default('claude-sonnet-5'),

  // Ceiling on concurrent model calls across every mission in this process, so
  // ten busy missions cannot open ten times the connections.
  SWARM_MAX_CONCURRENT_MODEL_CALLS: z.coerce.number().int().positive().default(4),

  // How often approved proposals are picked up for execution.
  EXECUTOR_POLL_MS: z.coerce.number().int().positive().default(5_000),
  // Fallback recipient when a mission's owner has no email on file.
  HIVE_DAILY_REPORT_EMAIL: z.string().optional(),
});

export const env = Env.parse(process.env);
