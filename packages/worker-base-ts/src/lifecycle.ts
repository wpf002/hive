import { prisma, Prisma } from '@hive/db';

export const DLQ_STREAM = 'hive:dlq';
export const STREAMS = {
  logs: (jobId: string) => `hive:logs:${jobId}`,
};
export const drainKey = (workerId: string) => `hive:worker:${workerId}:drain`;

// Phase 5b stream layout. Three per-pool streams selectable by affinity:
//   hive:pool:<pool>:any:any         — no affinity (default landing)
//   hive:pool:<pool>:<region>:any    — region-only affinity
//   hive:pool:<pool>:<region>:<zone> — region + zone specific affinity
//
// A worker in (region, zone) subscribes to all three streams that could carry
// work it's eligible for, with a per-stream consumer group keyed on its own
// location so groups don't collide across regions/zones.
export const POOL_STREAM_ANY = 'any';

export function poolStreamFor(pool: string, region: string, zone: string): string {
  return `hive:pool:${pool}:${region}:${zone}`;
}

export function poolGroupFor(pool: string, region: string, zone: string): string {
  return `hive:pool:${pool}:workers:${region}:${zone}`;
}

/** All streams a worker in (workerRegion, workerZone) must consume. */
export function workerEligibleStreams(
  pool: string,
  workerRegion: string,
  workerZone: string,
): Array<{ stream: string; group: string }> {
  const triples: Array<[string, string]> = [[POOL_STREAM_ANY, POOL_STREAM_ANY]];
  if (workerRegion !== POOL_STREAM_ANY) {
    triples.push([workerRegion, POOL_STREAM_ANY]);
    if (workerZone !== POOL_STREAM_ANY) {
      triples.push([workerRegion, workerZone]);
    }
  }
  return triples.map(([region, zone]) => ({
    stream: poolStreamFor(pool, region, zone),
    group: poolGroupFor(pool, region, zone),
  }));
}

/** Dispatcher's target stream selection from a job's effective affinity. */
export function dispatchStreamFor(
  pool: string,
  affinity: { region?: string | null; zone?: string | null } | null | undefined,
): string {
  const region = affinity?.region?.trim() || POOL_STREAM_ANY;
  const zone = affinity?.zone?.trim() || POOL_STREAM_ANY;
  // Zone without region makes no sense — degrade to region-only-any.
  if (region === POOL_STREAM_ANY && zone !== POOL_STREAM_ANY) {
    return poolStreamFor(pool, POOL_STREAM_ANY, POOL_STREAM_ANY);
  }
  return poolStreamFor(pool, region, zone);
}

// Legacy names retained as aliases so any external code keeps compiling.
// Phase 1-4 single-host setups land jobs on `hive:pool:<pool>:any:any` via
// dispatchStreamFor(pool, null) — the same stream legacy workers would have
// listened on if they'd been told about the new naming. Existing workers all
// run in (region='local', zone='default') and consume the 'any:any' stream
// by virtue of workerEligibleStreams() always including it.
export const POOL_GROUP = (pool: string) => poolGroupFor(pool, POOL_STREAM_ANY, POOL_STREAM_ANY);
export const poolStream = (pool: string) => poolStreamFor(pool, POOL_STREAM_ANY, POOL_STREAM_ANY);

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
