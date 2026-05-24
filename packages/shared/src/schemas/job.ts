import { z } from 'zod';
import { WORKER_POOLS } from '../constants/pools';

export const JobStatus = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
export type JobStatus = z.infer<typeof JobStatus>;

export const JobPayload = z.object({
  jobId: z.string(),
  botId: z.string(),
  pool: z.enum(WORKER_POOLS),
  config: z.record(z.unknown()),
  priority: z.number().default(0),
});
export type JobPayload = z.infer<typeof JobPayload>;

export const JobResult = z.object({
  jobId: z.string(),
  status: JobStatus,
  result: z.unknown().optional(),
  error: z.string().optional(),
  durationMs: z.number().optional(),
});
export type JobResult = z.infer<typeof JobResult>;
