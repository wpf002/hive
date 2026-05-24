import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  DISPATCHER_PORT: z.coerce.number().int().positive().default(4100),
  REDIS_URL: z.string().min(1),
});

export const env = Env.parse(process.env);
