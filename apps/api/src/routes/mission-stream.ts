import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '@hive/db';
import { Blackboard, BoardView, clusterByClaim, collapseFindings } from '@hive/swarm';
import { requireAuth } from '../auth.js';
import { createBlockingRedis } from '../redis.js';
import { isOriginAllowed } from '../lib/cors.js';

/**
 * Live mission state for the terminal.
 *
 * One SSE connection carries the whole picture: agent liveness, the collapsed
 * claim board, the approval queue, and spend. The terminal re-renders from each
 * snapshot rather than applying deltas — a mission board is small enough that
 * correctness is worth more than the bytes saved, and an operator watching an
 * approval countdown must never see a stale view because a delta was dropped.
 */

const HEARTBEAT_MS = 15_000;
const TICK_MS = 1_000;
/** A job still 'running' after this long is stuck, not busy. */
const STUCK_AFTER_MS = 5 * 60_000;
/**
 * How recently an agent must have done something to count as part of the live
 * swarm. Most agents are between jobs at any instant — a gatherer on a 1-minute
 * schedule is mid-flight for a couple of seconds — so liveness has to mean
 * "active lately", not "holding a job right now".
 */
const ACTIVE_WINDOW_MS = 10 * 60_000;

function sseWrite(reply: FastifyReply, event: string, data: unknown) {
  reply.raw.write(`event: ${event}\n`);
  reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
}

export interface AgentView {
  id: string;
  botId: string;
  botName: string;
  role: string;
  pool: string;
  sourceId: string | null;
  /** running | idle | stalled | disabled */
  state: string;
  /** Findings this agent has contributed, for the forage trails in the UI. */
  contributions: number;
}

export interface MissionSnapshot {
  missionId: string;
  name: string;
  status: string;
  objective: string;
  agents: AgentView[];
  findings: number;
  distinctFindings: number;
  claims: {
    id: string;
    claim: string;
    independentSources: number;
    agentCount: number;
    confidence: number;
    refuted: boolean;
    objections: number;
  }[];
  proposals: {
    id: string;
    action: string;
    status: string;
    rationale: string;
    expiresAt: string;
    constraintResults: { rule: string; passed: boolean; detail?: string }[];
  }[];
  cost: { todayCents: number; runRateCentsPerHour: number };
  lastDecisionAt: string | null;
  /**
   * Pools this mission's gatherers need that have no worker online, plus how
   * many of its jobs are stuck queued as a result. A mission whose feeds cannot
   * run must say so — an empty field with no explanation reads as "working".
   */
  stalled: { pools: string[]; queuedJobs: number };
}

async function buildSnapshot(missionId: string, view: BoardView): Promise<MissionSnapshot | null> {
  const mission = await prisma.mission.findUnique({
    where: { id: missionId },
    include: {
      agents: {
        include: {
          bot: {
            select: {
              id: true,
              name: true,
              enabled: true,
              template: { select: { poolType: true } },
              jobs: {
                orderBy: { createdAt: 'desc' },
                take: 1,
                select: { status: true, createdAt: true },
              },
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!mission) return null;

  // Incremental: reads only what landed since the previous tick. A full
  // XRANGE here would re-parse the entire board once a second per open
  // terminal, which is the one place this design could actually fall over.
  await view.refresh();
  const snap = view.state;
  const distinct = collapseFindings(snap.findings);
  const clusters = clusterByClaim(snap.hypotheses, distinct, snap.challenges);

  const contributions = new Map<string, number>();
  for (const f of snap.findings) {
    contributions.set(f.agentId, (contributions.get(f.agentId) ?? 0) + 1);
  }

  const now = Date.now();
  const agents: AgentView[] = mission.agents.map((a) => {
    const latest = a.bot.jobs[0];
    const age = latest ? now - latest.createdAt.getTime() : Infinity;
    const seenAge = a.lastSeenAt ? now - a.lastSeenAt.getTime() : Infinity;
    // 'stalled' means something is wrong, not merely quiet. A bot that finished
    // cleanly and has nothing to do right now is idle — colouring that red
    // would train an operator to ignore the colour that matters.
    let state = 'idle';
    if (!a.enabled || !a.bot.enabled) state = 'disabled';
    else if (latest?.status === 'failed') state = 'stalled';
    else if (latest?.status === 'running') state = age > STUCK_AFTER_MS ? 'stalled' : 'running';
    else if (Math.min(age, seenAge) < ACTIVE_WINDOW_MS) state = 'running';
    return {
      id: a.id,
      botId: a.botId,
      botName: a.bot.name,
      role: a.role,
      pool: a.bot.template.poolType,
      sourceId: a.sourceId,
      state,
      contributions: contributions.get(a.botId) ?? 0,
    };
  });

  const proposals = await prisma.proposal.findMany({
    where: { missionId },
    orderBy: { createdAt: 'desc' },
    take: 25,
  });

  // Spend: the coordinator tags its AiUsage rows with `mission:<id>`, and any
  // ai_agent job run for this mission's bots is attributed too.
  const dayAgo = new Date(now - 24 * 60 * 60_000);
  const hourAgo = new Date(now - 60 * 60_000);
  const [today, lastHour] = await Promise.all([
    prisma.aiUsage.aggregate({
      _sum: { costCents: true },
      where: { jobId: `mission:${missionId}`, createdAt: { gte: dayAgo } },
    }),
    prisma.aiUsage.aggregate({
      _sum: { costCents: true },
      where: { jobId: `mission:${missionId}`, createdAt: { gte: hourAgo } },
    }),
  ]);

  // Which pools this mission needs, and which of those are actually running.
  const neededPools = new Set(mission.agents.map((a) => a.bot.template.poolType));
  const live = await prisma.worker.findMany({
    where: { lastSeenAt: { gt: new Date(now - 30_000) }, status: { not: 'offline' } },
    select: { poolType: true },
    distinct: ['poolType'],
  });
  const livePools = new Set(live.map((w) => w.poolType));
  const stalledPools = [...neededPools].filter((p) => !livePools.has(p));
  const queuedJobs = stalledPools.length
    ? await prisma.job.count({
        where: {
          status: 'queued',
          bot: { missionAgents: { some: { missionId } } },
        },
      })
    : 0;

  return {
    missionId,
    name: mission.name,
    status: mission.status,
    objective: mission.objective,
    agents,
    findings: snap.findings.length,
    distinctFindings: distinct.length,
    claims: clusters.slice(0, 40).map((c) => ({
      id: c.members[0]?.id ?? c.claim,
      claim: c.members[0]?.claim ?? c.claim,
      independentSources: c.independentSources,
      agentCount: c.members.length,
      confidence: c.meanConfidence,
      refuted: c.refuted,
      objections: c.objections.length,
    })),
    proposals: proposals.map((p) => ({
      id: p.id,
      action: p.action,
      status: p.status,
      rationale: p.rationale,
      expiresAt: p.expiresAt.toISOString(),
      constraintResults: (p.constraintResults ?? []) as MissionSnapshot['proposals'][number]['constraintResults'],
    })),
    cost: {
      todayCents: today._sum.costCents ?? 0,
      runRateCentsPerHour: lastHour._sum.costCents ?? 0,
    },
    lastDecisionAt: mission.lastDecisionAt?.toISOString() ?? null,
    stalled: { pools: stalledPools, queuedJobs },
  };
}

export async function missionStreamRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>(
    '/api/missions/:id/stream',
    { preHandler: requireAuth('api') },
    async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const missionId = req.params.id;
      const isAdmin = req.staticAuth === 'api' || req.user?.role === 'admin';
      const mission = await prisma.mission.findFirst({
        where: { id: missionId, ...(isAdmin ? {} : { userId: req.user?.id ?? 'nobody' }) },
        select: { id: true },
      });
      if (!mission) {
        return reply.code(404).send({ error: { code: 'not_found', message: 'mission not found' } });
      }

      // reply.raw.writeHead bypasses @fastify/cors's onSend hook, so echo the
      // origin here or the browser blocks the stream (same as routes/sse.ts).
      const headers: Record<string, string> = {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      };
      const origin = req.headers.origin;
      if (origin && isOriginAllowed(origin)) {
        headers['Access-Control-Allow-Origin'] = origin;
        headers['Access-Control-Allow-Credentials'] = 'true';
        headers.Vary = 'Origin';
      }
      reply.raw.writeHead(200, headers);
      reply.hijack();

      const redis = createBlockingRedis();
      const view = new BoardView(new Blackboard(redis, missionId));
      let closed = false;

      // Guards against overlapping ticks. buildSnapshot does several queries
      // plus a board read; if one runs past a second, a second tick would call
      // view.refresh() concurrently and both would append the same entries.
      let inFlight = false;
      const tick = setInterval(() => {
        if (closed || inFlight) return;
        inFlight = true;
        void buildSnapshot(missionId, view)
          .then((snap) => {
            if (closed) return;
            if (!snap) {
              sseWrite(reply, 'gone', { missionId });
              void cleanup();
              return;
            }
            sseWrite(reply, 'snapshot', snap);
          })
          .catch((err) => req.log.warn({ err, missionId }, 'mission_snapshot_failed'))
          .finally(() => {
            inFlight = false;
          });
      }, TICK_MS);

      const heartbeat = setInterval(() => {
        try {
          reply.raw.write(': ping\n\n');
        } catch {
          /* connection closed */
        }
      }, HEARTBEAT_MS);

      const cleanup = async () => {
        if (closed) return;
        closed = true;
        clearInterval(tick);
        clearInterval(heartbeat);
        try {
          await redis.quit();
        } catch {
          /* ignore */
        }
        try {
          reply.raw.end();
        } catch {
          /* ignore */
        }
      };

      req.raw.on('close', () => void cleanup());

      const first = await buildSnapshot(missionId, view);
      if (first) sseWrite(reply, 'snapshot', first);
    },
  );
}
