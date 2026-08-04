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
});

export const env = Env.parse(process.env);
