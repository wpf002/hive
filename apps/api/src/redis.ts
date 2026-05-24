import { Redis } from 'ioredis';
import { env } from './env.js';

// Main connection — request/response work only. Do NOT reuse for blocking ops.
export const redis = new Redis(env.REDIS_URL, { lazyConnect: false });

// Factory for blocking ops (XREADGROUP / SUBSCRIBE). Caller owns lifecycle.
export function createBlockingRedis(): Redis {
  return new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
}

export const STREAMS = {
  dispatch: 'hive:dispatch',
  pool: (pool: string) => `hive:pool:${pool}`,
  logs: (jobId: string) => `hive:logs:${jobId}`,
  cancel: (jobId: string) => `hive:cancel:${jobId}`,
};
