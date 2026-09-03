/**
 * Worker status, and what "available" means.
 *
 * A worker sending heartbeats is not the same as a worker that can do work.
 * The browser pool proved the difference expensively: it heartbeated for days
 * with no browser binary installed, so every query that asked "is this pool
 * up?" said yes, the mission composer kept choosing it, and every job it
 * claimed failed. `unhealthy` is a pool reporting that its own runtime
 * dependencies are missing.
 *
 * Availability is defined here rather than as `status !== 'offline'` spelled
 * out at each call site, because that phrasing was already repeated in six
 * places and adding a status meant being right in all six.
 */
export const WORKER_STATUSES = ['online', 'draining', 'unhealthy', 'offline'] as const;
export type WorkerStatus = (typeof WORKER_STATUSES)[number];

/**
 * Statuses that count as a pool being able to serve work.
 *
 * `draining` is included: it is finishing what it has and is a deliberate
 * operator state, not a fault. `unhealthy` and `offline` are not.
 */
export const WORKER_AVAILABLE_STATUSES: WorkerStatus[] = ['online', 'draining'];

/** Prisma `where` fragment for "this worker can serve work". */
export const workerAvailable = { status: { in: WORKER_AVAILABLE_STATUSES } };
