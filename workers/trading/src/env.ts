import { z } from 'zod';

const Env = z.object({
  REDIS_URL: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  API_BASE_URL: z.string().default('http://localhost:4000'),
  WORKER_AUTH_TOKEN: z.string().min(16),
  // Hard gate: live exchange calls refuse to run unless this is exactly 'true'.
  TRADING_LIVE_ENABLED: z.enum(['true', 'false']).default('false'),
});

export const env = Env.parse(process.env);

export function liveTradingEnabled(): boolean {
  return env.TRADING_LIVE_ENABLED === 'true';
}
