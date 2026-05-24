import { prisma, Prisma } from '@hive/db';

export const DLQ_STREAM = 'hive:dlq';
export const STREAMS = {
  logs: (jobId: string) => `hive:logs:${jobId}`,
};
export const POOL_GROUP = (pool: string) => `hive:pool:${pool}:workers`;
export const poolStream = (pool: string) => `hive:pool:${pool}`;
export const drainKey = (workerId: string) => `hive:worker:${workerId}:drain`;

export async function markRunning(jobId: string): Promise<void> {
  await prisma.job.update({
    where: { id: jobId },
    data: { status: 'running', startedAt: new Date() },
  });
}

export async function markSucceeded(jobId: string, result: unknown): Promise<void> {
  await prisma.job.update({
    where: { id: jobId },
    data: {
      status: 'succeeded',
      finishedAt: new Date(),
      result: (result ?? null) as Prisma.InputJsonValue,
    },
  });
}

export async function markFailed(jobId: string, error: string): Promise<void> {
  await prisma.job.update({
    where: { id: jobId },
    data: { status: 'failed', finishedAt: new Date(), error },
  });
}

export async function incrementAttempts(jobId: string): Promise<number> {
  const updated = await prisma.job.update({
    where: { id: jobId },
    data: { attempts: { increment: 1 } },
    select: { attempts: true },
  });
  return updated.attempts;
}
