import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { prisma, Prisma } from '@hive/db';
import { Blackboard, contentHash, isoUtc, type Finding } from '@hive/swarm';
import type { Redis } from 'ioredis';
import { normalizeResult } from './normalize.js';
import { env } from '../env.js';

/**
 * Turns completed gatherer jobs into Findings on the mission board.
 *
 * This is the only deterministic role in the swarm — no model call, ever. It
 * exists because a gatherer is just an ordinary Hive bot on a schedule: it
 * knows nothing about missions, and its result lands in Job.result like any
 * other. Something has to carry that across the boundary, and doing it here
 * rather than inside the workers means every existing pool becomes a usable
 * gatherer without touching worker code.
 *
 * Polling rather than pub/sub: Job completion has no durable event, and a
 * missed message would silently drop evidence. A cursor over finishedAt is
 * replayable and survives a coordinator restart, which matters more here than
 * latency — gatherers run on cron, so seconds of lag are irrelevant.
 */
export async function runGathererBridge(
  missionId: string,
  redis: Redis,
  signal: AbortSignal,
  log: Logger,
): Promise<void> {
  const board = new Blackboard(redis, missionId);
  // Start from now: a mission that has just started should not ingest weeks of
  // backfill on its first tick and immediately blow its own budget.
  let cursor = new Date();

  // Rehydrate the board from the database if it is empty.
  //
  // The board is a Redis stream with a MAXLEN trim, and it is the only thing
  // the console reads. The database is the durable record. When those two
  // disagree — Redis restarted, the stream was trimmed or flushed — the
  // mission is silently unrecoverable: dedup correctly refuses to re-post
  // findings it has already stored, so nothing new ever arrives to repopulate
  // it, and the console shows a running mission with no evidence, forever.
  //
  // The fix is to treat the database as the source of truth on startup, which
  // it already is everywhere else.
  await rehydrate(missionId, board, log);

  while (!signal.aborted) {
    await sleep(env.GATHERER_POLL_MS, signal);
    if (signal.aborted) break;

    try {
      const agents = await prisma.missionAgent.findMany({
        where: { missionId, role: 'gatherer', enabled: true },
        include: { bot: { include: { template: { select: { name: true } } } } },
      });
      if (agents.length === 0) continue;

      const bySourceBot = new Map(agents.map((a) => [a.botId, a]));
      const jobs = await prisma.job.findMany({
        where: {
          botId: { in: agents.map((a) => a.botId) },
          status: 'succeeded',
          finishedAt: { gt: cursor },
        },
        orderBy: { finishedAt: 'asc' },
        take: env.GATHERER_BATCH,
        include: { bot: { include: { template: { select: { name: true } } } } },
      });
      if (jobs.length === 0) continue;

      let posted = 0;
      let duplicate = 0;
      for (const job of jobs) {
        const agent = bySourceBot.get(job.botId);
        // A gatherer without a sourceId cannot be deduplicated, and the API
        // refuses to create one — so this is a corrupt row, not a live case.
        if (!agent?.sourceId) continue;

        const finishedAt = job.finishedAt ?? new Date();
        const norm = normalizeResult(job.bot.template.name, job.result, finishedAt);
        if (!norm) continue;

        for (const item of norm.items) {
          const hash = contentHash(item.hashed);
          const finding: Finding = {
            id: randomUUID(),
            missionId,
            agentId: job.botId,
            kind: item.kind,
            payload: item.payload,
            provenance: {
              sourceId: agent.sourceId,
              subject: agent.subject,
              sourceKind: job.bot.template.name,
              observedAt: isoUtc(item.observedAt, new Date(norm.fetchedAt)),
              fetchedAt: norm.fetchedAt,
              contentHash: hash,
              jobId: job.id,
            },
          };

          // The database is the authority on whether this is new. Writing first
          // and posting only on success means the board can never carry a
          // duplicate the DB already rejected — the two views cannot drift.
          try {
            await prisma.finding.create({
              data: {
                id: finding.id,
                missionId,
                agentId: finding.agentId,
                kind: finding.kind,
                payload: finding.payload as Prisma.InputJsonValue,
                sourceId: agent.sourceId,
                subject: agent.subject,
                sourceKind: finding.provenance.sourceKind,
                observedAt: new Date(finding.provenance.observedAt),
                fetchedAt: new Date(finding.provenance.fetchedAt),
                contentHash: hash,
                jobId: job.id,
              },
            });
          } catch (e) {
            if ((e as { code?: string }).code === 'P2002') {
              duplicate += 1;
              continue; // same source, same subject, same bytes — already counted
            }
            throw e;
          }
          await board.post({ type: 'finding', data: finding });
          posted += 1;
        }

        await prisma.missionAgent
          .update({ where: { id: agent.id }, data: { lastSeenAt: finishedAt } })
          .catch(() => {
            /* liveness is cosmetic; never fail ingest for it */
          });
      }

      const last = jobs[jobs.length - 1].finishedAt;
      if (last) cursor = last;

      if (posted > 0 || duplicate > 0) {
        log.info({ missionId, posted, duplicate, jobs: jobs.length }, 'gatherer: ingested');
      }
    } catch (err) {
      log.error({ err, missionId }, 'gatherer bridge failed');
    }
  }
}

/**
 * Repost the mission's stored findings when the board has none.
 *
 * Bounded to the most recent window rather than everything: the stream is
 * trimmed for a reason, and replaying a month of a busy mission would blow
 * past MAXLEN and evict the very evidence it was restoring. Newest wins,
 * because that is what the trim would have kept anyway.
 */
async function rehydrate(missionId: string, board: Blackboard, log: Logger): Promise<void> {
  try {
    const existing = await board.snapshot('-');
    if (existing.findings.length > 0) return;

    const rows = await prisma.finding.findMany({
      where: { missionId },
      orderBy: { createdAt: 'desc' },
      take: 2_000,
    });
    if (rows.length === 0) return;

    // Oldest first on the way back out, so board order matches the order these
    // were originally observed.
    for (const r of rows.reverse()) {
      await board.post({
        type: 'finding',
        data: {
          id: r.id,
          missionId: r.missionId,
          agentId: r.agentId,
          kind: r.kind,
          payload: r.payload as Record<string, unknown>,
          provenance: {
            sourceId: r.sourceId,
            subject: r.subject,
            sourceKind: r.sourceKind,
            observedAt: r.observedAt.toISOString(),
            fetchedAt: r.fetchedAt.toISOString(),
            contentHash: r.contentHash,
            jobId: r.jobId,
          },
        },
      });
    }
    log.info({ missionId, restored: rows.length }, 'gatherer: board rehydrated from database');
  } catch (err) {
    // A failed rehydrate must not stop the mission gathering new evidence.
    log.error({ err, missionId }, 'gatherer: rehydrate failed');
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
