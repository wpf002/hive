import { z } from 'zod';

const Env = z.object({
  REDIS_URL: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  API_BASE_URL: z.string().default('http://localhost:4000'),
  WORKER_AUTH_TOKEN: z.string().min(16),
});

export const env = Env.parse(process.env);
