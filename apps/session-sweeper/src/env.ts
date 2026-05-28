import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  SESSION_SWEEPER_PORT: z.coerce.number().int().positive().default(4103),
  DATABASE_URL: z.string().min(1),
  // 1h in seconds — overridable for tests.
  SESSION_SWEEP_INTERVAL_S: z.coerce.number().int().positive().default(3600),
  // Phase 6b: audit alerting. When HIVE_AUDIT_ALERT_EMAIL is set, this service
  // polls recent AuditLog rows and emails on critical events. Redis backs the
  // dedupe set so an alert fires once even across restarts / multiple replicas.
  HIVE_AUDIT_ALERT_EMAIL: z.string().email().optional(),
  REDIS_URL: z.string().optional(),
  HIVE_EMAIL_PROVIDER: z.enum(['log', 'resend']).default('log'),
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM_EMAIL: z.string().optional(),
  // How often the audit-alert poll runs, and how far back it looks.
  AUDIT_ALERT_POLL_INTERVAL_S: z.coerce.number().int().positive().default(60),
});

export const env = Env.parse(process.env);
