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
  // Phase 4a: required for field-level encryption of bot secrets.
  // 32 raw bytes = 64 hex chars. @hive/crypto re-validates the format.
  HIVE_SECRETS_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'HIVE_SECRETS_KEY must be 64 hex chars (32 bytes). Generate with `openssl rand -hex 32`.'),
});

export const env = Env.parse(process.env);
export type AppEnv = z.infer<typeof Env>;
