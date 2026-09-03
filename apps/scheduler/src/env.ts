import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  SCHEDULER_PORT: z.coerce.number().int().positive().default(4102),
  API_BASE_URL: z.string().default('http://localhost:4000'),
  API_AUTH_TOKEN: z.string().min(16),
  // Daily bot-effectiveness digest: the scheduler POSTs /api/reports/daily-digest
  // on this cron (UTC). Default 12:00 UTC ≈ 8:00 AM US Eastern (EDT). Set
  // DAILY_DIGEST_ENABLED=false to turn it off.
  DAILY_DIGEST_CRON: z.string().default('0 12 * * *'),
  DAILY_DIGEST_ENABLED: z.enum(['true', 'false']).default('true'),
  // Resend key used by the scheduler to send real-time failure alerts.
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM_EMAIL: z.string().default('Hive <onboarding@resend.dev>'),
  HIVE_EMAIL_PROVIDER: z.string().default('resend'),
  // Warn a user when their swarm's model spend crosses this in 24 hours, in
  // cents. A warning, never a brake: cutting missions off on a threshold guess
  // would break the thing they are paying for. 0 disables it.
  //
  // Default $20/day. A mission covering ten subjects on a ten-minute cooldown
  // runs about $1.40/hour, so this is roughly one such mission left running
  // overnight — high enough not to nag, low enough to catch a runaway before
  // it becomes a month's bill.
  SPEND_ALERT_DAILY_CENTS: z.coerce.number().int().nonnegative().default(2000),
});

export const env = Env.parse(process.env);
