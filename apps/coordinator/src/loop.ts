import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { prisma, Prisma } from '@hive/db';
import {
  Blackboard,
  BoardView,
  clusterByClaim,
  collapseFindings,
  evaluate,
  selectCluster,
  type Proposal,
} from '@hive/swarm';
import { decide } from './decide.js';
import { env } from './env.js';

/**
 * One loop per running mission.
 *
 * Event-triggered, not polled on a fixed cadence: the coordinator blocks on the
 * board and only wakes when something new lands. This is what keeps a
 * 350-agent mission from becoming 350 model calls a minute — most agents are
 * idle most of the time, and the expensive step runs once per genuine change.
 *
 * COORDINATOR_MIN_INTERVAL_MS puts a floor under that: a burst of twenty board
 * writes in two seconds collapses into one decision, not twenty.
 */
export async function runMissionLoop(
  missionId: string,
  redis: Redis,
  signal: AbortSignal,
  log: Logger,
): Promise<void> {
  const board = new Blackboard(redis, missionId);
  await board.ensureGroup('coordinator');

  // Incremental, bounded board view: each wake reads only what landed since
  // the last one, and the window is capped so a mission running for days can't
  // grow this loop's memory without limit.
  const view = new BoardView(board);
  let lastDecisionAt = 0;
  // Set when evidence arrived but the rate floor deferred the decision. Without
  // it, a batch that lands inside the floor is acked, folded into the view, and
  // then never decided if the board happens to go quiet — the evidence would sit
  // there unjudged forever.
  let decisionPending = false;

  while (!signal.aborted) {
    const batch = await board.read('coordinator', ['hypothesis', 'challenge'], {
      count: 64,
      blockMs: 5_000,
    });
    if (signal.aborted) break;
    // A quiet tick still has to run the decision step if the rate floor
    // deferred one earlier; otherwise deferred evidence is never judged.
    if (batch.length === 0 && !decisionPending) continue;

    // Ack first: a decision that throws shouldn't replay the same entries
    // forever. The board itself is the durable record.
    if (batch.length > 0) {
      await board.ackAll(
        'coordinator',
        batch.map((b) => b.ackId),
      );
      decisionPending = true;
    }

    const mission = await prisma.mission.findUnique({ where: { id: missionId } });
    if (!mission || mission.status !== 'running') break;

    await view.refresh();
    const state = view.state;

    // Rate-floor the expensive step. `decisionPending` stays set, so the next
    // wake — board activity or not — picks the deferred decision back up.
    const sinceLast = Date.now() - lastDecisionAt;
    if (sinceLast < env.COORDINATOR_MIN_INTERVAL_MS) continue;

    // 1. collapse duplicate observations before anything counts them
    const distinct = collapseFindings(state.findings);

    // 2. cluster agreeing claims, scored by independent source count
    const clusters = clusterByClaim(state.hypotheses, distinct, state.challenges);
    if (clusters.length === 0) continue;

    decisionPending = false;

    const limits = (mission.limits ?? {}) as Record<string, number>;

    // 3. single model call to turn the board into one decision
    lastDecisionAt = Date.now();
    let decision;
    try {
      decision = await decide({
        missionId,
        objective: mission.objective,
        allowedActions: mission.allowedActions,
        clusters,
        limits,
      });
    } catch (err) {
      log.error({ err, missionId }, 'coordinator decision failed');
      continue;
    }

    // `decide()` can take tens of seconds. Re-check that the mission is still
    // meant to be running before writing anything: an operator who hit Stop
    // during the model call must not find a fresh, approvable proposal waiting
    // for them afterwards.
    if (signal.aborted) break;
    const stillRunning = await prisma.mission.findUnique({
      where: { id: missionId },
      select: { status: true },
    });
    if (stillRunning?.status !== 'running') {
      log.info({ missionId }, 'coordinator: mission stopped mid-decision, discarding');
      break;
    }

    await prisma.mission.update({
      where: { id: missionId },
      data: { lastDecisionAt: new Date() },
    });

    if (!decision.action) {
      log.info(
        { missionId, reason: decision.rationale, claims: clusters.length },
        'coordinator: no action',
      );
      continue;
    }

    // 4. deterministic gates, then the approval queue.
    //
    // The gates are scored against the claim the coordinator actually acted on,
    // not against whichever claim ranks highest. Using clusters[0] here would
    // quietly turn `requires_independent_support` into "does ANY claim on this
    // board have enough sources" and `not_refuted` into "is the top claim
    // clean" — letting a single-source echo or a refuted claim through the one
    // gate built to stop it.
    const chosen = selectCluster(clusters, decision.claim);
    if (!chosen) {
      // Refuse rather than fall back to a default cluster: an unidentifiable
      // claim is exactly the case where the gates cannot do their job.
      log.warn(
        { missionId, action: decision.action, claim: decision.claim },
        'coordinator: decision names no identifiable claim, discarding',
      );
      continue;
    }

    const draft: Proposal = {
      id: randomUUID(),
      missionId,
      action: decision.action,
      params: {
        ...decision.params,
        independentSources: chosen.independentSources,
        refuted: chosen.refuted,
      },
      rationale: decision.rationale,
      status: 'pending',
      expiresAt: new Date(Date.now() + env.PROPOSAL_TTL_MS).toISOString(),
      constraintResults: [],
    };

    const gated = evaluate(draft, {
      now: new Date(),
      counters: await loadCounters(missionId),
      limits,
      allowedActions: mission.allowedActions,
    });

    const row = await prisma.proposal.create({
      data: {
        missionId,
        action: gated.action,
        params: gated.params as Prisma.InputJsonValue,
        rationale: gated.rationale,
        status: gated.status,
        constraintResults: gated.constraintResults as unknown as Prisma.InputJsonValue,
        expiresAt: new Date(gated.expiresAt),
      },
    });

    // Post with the DB id, not the draft uuid, so the terminal's approve/reject
    // buttons address the same row the coordinator wrote.
    await board.post({ type: 'proposal', data: { ...gated, id: row.id } });

    log.info(
      {
        missionId,
        proposalId: row.id,
        action: gated.action,
        status: gated.status,
        claim: chosen.claim,
        independentSources: chosen.independentSources,
        failed: gated.constraintResults.filter((r) => !r.passed).map((r) => r.rule),
      },
      'coordinator: proposal',
    );
  }
}

/**
 * Counters for the constraint pass, over a 24h window. Counts proposals that
 * actually executed — not ones that were merely approved, so a failed executor
 * doesn't silently consume the mission's action budget.
 */
async function loadCounters(missionId: string): Promise<Record<string, number>> {
  const since = new Date(Date.now() - 24 * 60 * 60_000);
  const executed = await prisma.proposal.findMany({
    where: { missionId, status: 'executed', decidedAt: { gte: since } },
    select: { action: true },
  });
  const counters: Record<string, number> = { 'mission:actions': executed.length };
  for (const p of executed) {
    counters[`action:${p.action}`] = (counters[`action:${p.action}`] ?? 0) + 1;
  }
  return counters;
}
