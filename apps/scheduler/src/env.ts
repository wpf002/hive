import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  SCHEDULER_PORT: z.coerce.number().int().positive().default(4102),
  API_BASE_URL: z.string().default('http://localhost:4000'),
  API_AUTH_TOKEN: z.string().min(16),
});

export const env = Env.parse(process.env);
