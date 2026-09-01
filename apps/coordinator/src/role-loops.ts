import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { prisma } from '@hive/db';
import { Blackboard, BoardView, collapseFindings, type Challenge, type Hypothesis } from '@hive/swarm';
import { analyze } from './analyze.js';
import { challenge } from './challenge.js';
import { env } from './env.js';

/**
 * The two model-calling board consumers.
 *
 * Both follow the coordinator's shape: block on the board's consumer group,
 * ack immediately so a failure cannot replay forever, and rate-floor the
 * expensive step so a burst of writes collapses into one call. An idle mission
 * therefore costs nothing at all — the loops sit in a blocking read.
 */

/** Analyst: consumes findings, produces hypotheses. */
export async function runAnalystLoop(
  missionId: string,
  redis: Redis,
  signal: AbortSignal,
  log: Logger,
): Promise<void> {
  const board = new Blackboard(redis, missionId);
  await board.ensureGroup('analyst');
  const view = new BoardView(board);
  let lastCallAt = 0;
  let pending = false;

  while (!signal.aborted) {
    const batch = await board.read('analyst', ['finding'], { count: 64, blockMs: 5_000 });
    if (signal.aborted) break;
    if (batch.length === 0 && !pending) continue;
    if (batch.length > 0) {
      await board.ackAll('analyst', batch.map((b) => b.ackId));
      pending = true;
    }

    if (Date.now() - lastCallAt < env.ANALYST_MIN_INTERVAL_MS) continue;

    const mission = await prisma.mission.findUnique({ where: { id: missionId } });
    if (!mission || mission.status !== 'running') break;

    await view.refresh();
    // Analyse the collapsed set, not the raw one: an analyst shown the same
    // observation five times will cite five ids for what is one signal, and
    // the independence score would then be counting duplicates.
    const distinct = collapseFindings(view.state.findings);
    const recent = distinct.slice(-env.ANALYST_BATCH);
    if (recent.length === 0) { pending = false; continue; }

    pending = false;
    lastCallAt = Date.now();

    let proposals: Omit<Hypothesis, 'id' | 'agentId'>[];
    try {
      proposals = await analyze({ missionId, objective: mission.objective, findings: recent });
    } catch (err) {
      log.error({ err, missionId }, 'analyst call failed');
      continue;
    }
    if (proposals.length === 0) {
      log.info({ missionId, considered: recent.length }, 'analyst: no claim');
      continue;
    }

    const agentId = await roleAgentId(missionId, 'analyst');
    for (const p of proposals) {
      const row = await prisma.hypothesis.create({
        data: {
          missionId,
          agentId,
          claim: p.claim,
          confidence: p.confidence,
          supportingFindingIds: p.supportingFindingIds,
        },
      });
      await board.post({
        type: 'hypothesis',
        data: { ...p, id: row.id, agentId } as Hypothesis,
      });
    }
    log.info({ missionId, claims: proposals.length }, 'analyst: posted');
  }
}

/** Adversary: consumes hypotheses, produces challenges. */
export async function runAdversaryLoop(
  missionId: string,
  redis: Redis,
  signal: AbortSignal,
  log: Logger,
): Promise<void> {
  const board = new Blackboard(redis, missionId);
  await board.ensureGroup('adversary');
  const view = new BoardView(board);
  let lastCallAt = 0;
  const queue: Hypothesis[] = [];

  while (!signal.aborted) {
    const batch = await board.read('adversary', ['hypothesis'], { count: 32, blockMs: 5_000 });
    if (signal.aborted) break;
    if (batch.length > 0) {
      await board.ackAll('adversary', batch.map((b) => b.ackId));
      for (const b of batch) if (b.event.type === 'hypothesis') queue.push(b.event.data);
    }
    if (queue.length === 0) continue;
    if (Date.now() - lastCallAt < env.ADVERSARY_MIN_INTERVAL_MS) continue;

    const mission = await prisma.mission.findUnique({ where: { id: missionId } });
    if (!mission || mission.status !== 'running') break;

    // One claim per pass. Attacking the whole queue at once would let a single
    // model call decide the fate of every claim on the board, which is exactly
    // the concentration this role exists to avoid.
    const target = queue.shift()!;
    lastCallAt = Date.now();

    await view.refresh();
    let objections: Omit<Challenge, 'id' | 'agentId'>[];
    try {
      objections = await challenge({
        missionId,
        objective: mission.objective,
        hypothesis: target,
        evidence: view.state.findings,
      });
    } catch (err) {
      log.error({ err, missionId, hypothesisId: target.id }, 'adversary call failed');
      continue;
    }
    if (objections.length === 0) {
      log.info({ missionId, hypothesisId: target.id }, 'adversary: claim survived');
      continue;
    }

    const agentId = await roleAgentId(missionId, 'adversary');
    for (const o of objections) {
      // The hypothesis row must exist — a challenge on a claim the DB never
      // saw would orphan on the cascade.
      const exists = await prisma.hypothesis.findUnique({ where: { id: target.id } });
      if (!exists) continue;
      const row = await prisma.challenge.create({
        data: {
          hypothesisId: target.id,
          agentId,
          objection: o.objection,
          severity: o.severity,
        },
      });
      await board.post({ type: 'challenge', data: { ...o, id: row.id, agentId } as Challenge });
    }
    log.info(
      {
        missionId,
        hypothesisId: target.id,
        objections: objections.length,
        worst: objections.map((o) => o.severity).sort()[0],
      },
      'adversary: objections',
    );
  }
}

/**
 * The bot bound to this role, used as Finding/Hypothesis.agentId so the terminal
 * can attribute work. Falls back to a synthetic id when no bot is bound — the
 * role still runs, it is just not attributable to a specific bot.
 */
async function roleAgentId(missionId: string, role: string): Promise<string> {
  const a = await prisma.missionAgent.findFirst({
    where: { missionId, role, enabled: true },
    select: { botId: true },
  });
  return a?.botId ?? `${role}:${missionId}`;
}
