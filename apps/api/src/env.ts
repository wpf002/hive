import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  API_AUTH_TOKEN: z.string().min(16),
  WORKER_AUTH_TOKEN: z.string().min(16),
  TRADING_LIVE_ENABLED: z.enum(['true', 'false']).default('false'),
});

export const env = Env.parse(process.env);
export type AppEnv = z.infer<typeof Env>;
