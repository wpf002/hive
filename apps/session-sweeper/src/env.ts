import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  SESSION_SWEEPER_PORT: z.coerce.number().int().positive().default(4103),
  DATABASE_URL: z.string().min(1),
  // 1h in seconds — overridable for tests.
  SESSION_SWEEP_INTERVAL_S: z.coerce.number().int().positive().default(3600),
});

export const env = Env.parse(process.env);
