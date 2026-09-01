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
  // Subjects analysed per pass on a fanned-out mission.
  //
  // This is the direct cost multiplier and the one knob worth tuning. A mission
  // with no fan-out has a single (empty) subject and makes one call per pass, so
  // this changes nothing for it. A mission covering S subjects sweeps all of
  // them every ceil(S / this) * ANALYST_MIN_INTERVAL_MS: 100 subjects at 4 per
  // 30s pass is a full sweep every ~12 minutes, for roughly 8 calls a minute.
  // Raising it buys freshness linearly and costs money linearly.
  ANALYST_SUBJECTS_PER_PASS: z.coerce.number().int().positive().default(4),
  // How many board entries a mission loop keeps in view.
  //
  // Size it above subjects x sources x a few observations each, or a fanned-out
  // mission will age a subject's evidence out of the window before its turn in
  // the rotation comes round — which looks exactly like a source going quiet.
  SWARM_BOARD_WINDOW: z.coerce.number().int().positive().default(5_000),
  // Claims waiting for the adversary. Bounded because at fan-out scale the
  // analyst can produce claims faster than one-per-pass can attack them, and an
  // unbounded FIFO would spend the whole mission working through stale claims
  // while every recent one waits behind them.
  ADVERSARY_QUEUE_MAX: z.coerce.number().int().positive().default(200),
  HIVE_ANALYST_MODEL: z.string().default('claude-sonnet-5'),
  HIVE_ADVERSARY_MODEL: z.string().default('claude-sonnet-5'),

  // Ceiling on concurrent model calls across every mission in this process, so
  // ten busy missions cannot open ten times the connections.
  SWARM_MAX_CONCURRENT_MODEL_CALLS: z.coerce.number().int().positive().default(4),

  // Default ceiling on one mission's model spend per trailing hour, in cents.
  //
  // A mission can override it through its own limits under
  // `budget:cents_per_hour`. This is the backstop that makes "run hundreds of
  // bots" a bounded decision: bots are free, thinking is not, and without a cap
  // the only thing standing between a wide mission and a large bill is how
  // often its loops happen to fire.
  MISSION_BUDGET_CENTS_PER_HOUR: z.coerce.number().int().positive().default(100),
  // Floor on the gap between two analyses of the SAME subject.
  //
  // The rotation already skips subjects with no new evidence, but "new" is a
  // low bar: a feed that reports every three minutes makes every subject new
  // every three minutes, so the analyst would re-reason about a host that is
  // simply still up, forever. This says how often a subject is worth
  // re-examining at all, and it is the knob that decides cost per subject:
  // calls per hour is roughly subjects x 3600000 / this.
  ANALYST_SUBJECT_COOLDOWN_MS: z.coerce.number().int().nonnegative().default(10 * 60_000),
  // How often approved proposals are picked up for execution.
  EXECUTOR_POLL_MS: z.coerce.number().int().positive().default(5_000),
  // Fallback recipient when a mission's owner has no email on file.
  HIVE_DAILY_REPORT_EMAIL: z.string().optional(),
});

export const env = Env.parse(process.env);
