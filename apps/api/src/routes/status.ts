import type { FastifyInstance } from 'fastify';
import { prisma } from '@hive/db';
import { WORKER_POOLS, POOL_LABELS } from '@hive/shared';

// Heartbeat freshness windows for the public status grid.
const ONLINE_MS = 30_000; // green: a worker checked in within 30s
const RECENT_MS = 2 * 60_000; // yellow: dropped off in the last 2 min
const KNOWN_MS = 5 * 60_000; // beyond this, treat the pool as idle (grey)

type PoolStatus = 'ok' | 'degraded' | 'idle';

/**
 * Public, unauthenticated status payload powering the UI /status page (6c.3).
 * Worker-pool health is derived from the Worker table's heartbeat freshness so
 * we never need to reach individual worker processes. Control-plane sub-service
 * health beyond the API is reported only if its /healthz URL is configured.
 */
export async function statusRoutes(app: FastifyInstance) {
  app.get('/api/status', async () => {
    const now = Date.now();
    const since = new Date(now - KNOWN_MS);

    const recentWorkers = await prisma.worker.findMany({
      where: { lastSeenAt: { gt: since } },
      select: { poolType: true, lastSeenAt: true, status: true },
    });

    const pools = WORKER_POOLS.map((pool) => {
      const mine = recentWorkers.filter((w) => w.poolType === pool);
      const online = mine.filter(
        (w) => w.status !== 'offline' && now - w.lastSeenAt.getTime() < ONLINE_MS,
      ).length;
      const recent = mine.filter((w) => now - w.lastSeenAt.getTime() < RECENT_MS).length;
      let status: PoolStatus;
      if (online > 0) status = 'ok';
      else if (recent > 0) status = 'degraded';
      else status = 'idle';
      return { pool, label: POOL_LABELS[pool], total: mine.length, online, status };
    });

    // Control plane: the API is 'ok' if it's answering this request. Optional
    // env URLs let us probe the other services' /healthz; otherwise 'unknown'.
    const controlPlane = await buildControlPlane();

    // Incidents are operator-recorded AuditLog rows (action='system.incident').
    const incidentRows = await prisma.auditLog.findMany({
      where: { action: 'system.incident', createdAt: { gt: new Date(now - 24 * 60 * 60_000) } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const incidents = incidentRows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      message:
        (r.payload && typeof r.payload === 'object' && 'message' in r.payload
          ? String((r.payload as { message?: unknown }).message ?? '')
          : '') || r.targetId || 'incident',
    }));

    return {
      generatedAt: new Date(now).toISOString(),
      deploy: {
        sha: process.env.HIVE_GIT_SHA ?? process.env.FLY_IMAGE_REF ?? 'dev',
        deployedAt: process.env.HIVE_DEPLOYED_AT ?? null,
      },
      controlPlane,
      pools,
      incidents,
    };
  });
}

async function buildControlPlane(): Promise<Array<{ name: string; status: string }>> {
  const out: Array<{ name: string; status: string }> = [{ name: 'api', status: 'ok' }];
  const probes: Array<[string, string | undefined]> = [
    ['dispatcher', process.env.HIVE_DISPATCHER_URL],
    ['scheduler', process.env.HIVE_SCHEDULER_URL],
    ['session-sweeper', process.env.HIVE_SWEEPER_URL],
  ];
  for (const [name, url] of probes) {
    if (!url) {
      out.push({ name, status: 'unknown' });
      continue;
    }
    try {
      const r = await fetch(`${url.replace(/\/$/, '')}/healthz`, {
        signal: AbortSignal.timeout(3_000),
      });
      const body = (await r.json().catch(() => ({}))) as { status?: string };
      out.push({ name, status: r.ok ? body.status ?? 'ok' : 'degraded' });
    } catch {
      out.push({ name, status: 'unreachable' });
    }
  }
  return out;
}
