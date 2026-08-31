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
});

export const env = Env.parse(process.env);
