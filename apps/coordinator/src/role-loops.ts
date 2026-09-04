import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { prisma } from '@hive/db';
import {
  Blackboard,
  BoardView,
  collapseFindings,
  type Challenge,
  type Finding,
  type Hypothesis,
} from '@hive/swarm';
import { analyze } from './analyze.js';
import { challenge } from './challenge.js';
import { withinBudget } from './budget.js';
import { env } from './env.js';
import { effectivePlan } from '@hive/shared';

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
  const view = new BoardView(board, env.SWARM_BOARD_WINDOW);
  let lastCallAt = 0;
  // Where the subject rotation resumes. Kept outside the loop so a mission
  // covering more subjects than one pass can hold still sweeps all of them
  // instead of re-analysing the same head of the list forever.
  let subjectCursor = 0;
  // Newest evidence each subject had the last time it was analysed.
  //
  // Without this the rotation re-reads subjects that have not changed, which is
  // most of them most of the time: dedup correctly refuses to re-post identical
  // bytes, so a host that is simply still up produces nothing new for hours
  // while the analyst keeps paying to conclude that again. Measured on a
  // 10-subject mission this was the difference between a call a subject every
  // pass and a call only when something actually moved.
  const analysedThrough = new Map<string, string>();
  // When each subject was last analysed, for the cooldown.
  const analysedAt = new Map<string, number>();
  // Cold start: analyse whatever is already on the board once, before waiting
  // for new evidence.
  //
  // The consumer group only delivers entries it has not seen, so a mission that
  // arrives in a burst and then goes quiet — a feed whose upstream stops
  // changing, which dedup then correctly refuses to re-post — would have its
  // entire body of evidence pass by during startup and never be reconsidered.
  // Every later run is delta-driven; this is the one pass over the whole board.
  let pending = true;

  while (!signal.aborted) {
    const batch = await board.read('analyst', ['finding'], { count: 64, blockMs: 5_000 });
    if (signal.aborted) break;
    if (batch.length === 0 && !pending) continue;
    if (batch.length > 0) {
      await board.ackAll('analyst', batch.map((b) => b.ackId));
      pending = true;
    }

    if (Date.now() - lastCallAt < env.ANALYST_MIN_INTERVAL_MS) continue;

    const mission = await prisma.mission.findUnique({
      where: { id: missionId },
      include: {
        user: {
          select: { id: true, plan: true, quotaDailySpendCents: true },
        },
      },
    });
    if (!mission || mission.status !== 'running') break;

    const budget = await withinBudget(missionId, mission.limits, {
      userId: mission.user.id,
      dailyCapCents: effectivePlan(mission.user).dailySpendCents,
    });
    if (!budget.ok) {
      // Keep gathering, stop thinking. Evidence accumulates and is analysed
      // when the trailing hour reopens, so the mission gets slower rather than
      // blind — and the log says which it is.
      log.warn(
        {
          missionId,
          scope: budget.scope,
          spentCents: Math.round(budget.spentCents),
          capCents: budget.capCents,
        },
        'analyst: hourly budget reached, skipping',
      );
      lastCallAt = Date.now();
      continue;
    }

    await view.refresh();
    // Analyse the collapsed set, not the raw one: an analyst shown the same
    // observation five times will cite five ids for what is one signal, and
    // the independence score would then be counting duplicates.
    const distinct = collapseFindings(view.state.findings);

    // One call per subject, not one call over everything.
    //
    // This is what makes a wide mission work. Corroboration only exists between
    // sources looking at the SAME entity, so a single batch drawn across 200
    // subjects hands the analyst 40 findings about 40 different things and asks
    // it to find agreement — which it cannot, however good it is. Slicing by
    // subject first means every call contains all the sources that saw one
    // entity, and cross-source agreement becomes findable rather than lucky.
    //
    // Cost is bounded by taking a fixed number of subjects per pass and
    // resuming where the last pass stopped, so a mission with 200 subjects
    // costs the same per pass as one with 5 — it just takes more passes to
    // sweep. A mission with no fan-out has exactly one (empty) subject and this
    // reduces to the single call it always made.
    const all = groupBySubject(distinct);
    if (all.length === 0) { pending = false; continue; }

    // Two gates, and both are needed.
    //
    // New evidence: a subject whose feeds are reporting the same thing they
    // reported last time has nothing for the analyst to say that it has not
    // already said. Dedup makes this exact — an unchanged feed posts nothing.
    //
    // Cooldown: "new" is a low bar. A feed on a three-minute cron makes every
    // subject new every three minutes, so without this the analyst re-reasons
    // about a host that is simply still up, forever, at full price. This is the
    // gate that actually sets cost per subject.
    const nowMs = Date.now();
    const bySubject = all.filter(
      (g) =>
        g.newest > (analysedThrough.get(g.subject) ?? '') &&
        nowMs - (analysedAt.get(g.subject) ?? 0) >= env.ANALYST_SUBJECT_COOLDOWN_MS,
    );
    if (bySubject.length === 0) {
      pending = false;
      continue;
    }

    if (subjectCursor >= bySubject.length) subjectCursor = 0;
    const take = Math.min(env.ANALYST_SUBJECTS_PER_PASS, bySubject.length);
    const slice = Array.from(
      { length: take },
      (_, i) => bySubject[(subjectCursor + i) % bySubject.length],
    );
    subjectCursor = (subjectCursor + take) % bySubject.length;

    pending = false;
    lastCallAt = Date.now();

    const agentId = await roleAgentId(missionId, 'analyst');
    let posted = 0;
    for (const group of slice) {
      // Sample evenly across sources rather than taking the most recent N.
      //
      // A busy feed drowns a quiet one: with 41 findings from one book and 10
      // from another, the tail of the list is almost entirely the first, and an
      // analyst that never sees the second book cannot possibly corroborate
      // across them — which is the only kind of claim this system acts on.
      // Taking a round-robin slice guarantees every live source is represented.
      const recent = sampleAcrossSources(group.findings, env.ANALYST_BATCH);
      if (recent.length === 0) continue;
      // Marked before the call, not after: a call that fails or returns nothing
      // still saw this evidence, and retrying it unchanged would just spend the
      // same money on the same answer. New evidence re-opens the subject.
      analysedThrough.set(group.subject, group.newest);
      analysedAt.set(group.subject, Date.now());

      let proposals: Omit<Hypothesis, 'id' | 'agentId'>[];
      try {
        proposals = await analyze({
          missionId,
          objective: mission.objective,
          subject: group.subject,
          findings: recent,
          // Everything already on the board for this subject, so the analyst
          // adds rather than repeats.
          existingClaims: claimsForSubject(view.state.hypotheses, distinct, group.subject),
        });
      } catch (err) {
        log.error({ err, missionId, subject: group.subject }, 'analyst call failed');
        continue;
      }
      if (proposals.length === 0) {
        log.info(
          { missionId, subject: group.subject, considered: recent.length },
          'analyst: no claim',
        );
        continue;
      }

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
        posted += 1;
      }
    }
    if (posted > 0) {
      log.info(
        { missionId, claims: posted, subjects: slice.length, ofSubjects: bySubject.length },
        'analyst: posted',
      );
    }
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
  const view = new BoardView(board, env.SWARM_BOARD_WINDOW);
  let lastCallAt = 0;
  const queue: Hypothesis[] = [];

  while (!signal.aborted) {
    const batch = await board.read('adversary', ['hypothesis'], { count: 32, blockMs: 5_000 });
    if (signal.aborted) break;
    if (batch.length > 0) {
      await board.ackAll('adversary', batch.map((b) => b.ackId));
      for (const b of batch) if (b.event.type === 'hypothesis') queue.push(b.event.data);
      // Drop the oldest when the backlog overflows, and say so.
      //
      // At fan-out scale the analyst can post claims faster than one-per-pass
      // can attack them. An unbounded queue would not fix that — it would just
      // guarantee the adversary spends the mission grinding through claims
      // whose evidence has already aged off the board while every fresh claim
      // waits behind them. Dropping oldest keeps the attack current; the log
      // line is there so an operator can see the role is underprovisioned
      // rather than quietly falling behind.
      if (queue.length > env.ADVERSARY_QUEUE_MAX) {
        const dropped = queue.length - env.ADVERSARY_QUEUE_MAX;
        queue.splice(0, dropped);
        log.warn({ missionId, dropped, max: env.ADVERSARY_QUEUE_MAX }, 'adversary: backlog trimmed');
      }
    }
    if (queue.length === 0) continue;
    if (Date.now() - lastCallAt < env.ADVERSARY_MIN_INTERVAL_MS) continue;

    const mission = await prisma.mission.findUnique({
      where: { id: missionId },
      include: {
        user: {
          select: { id: true, plan: true, quotaDailySpendCents: true },
        },
      },
    });
    if (!mission || mission.status !== 'running') break;

    const budget = await withinBudget(missionId, mission.limits, {
      userId: mission.user.id,
      dailyCapCents: effectivePlan(mission.user).dailySpendCents,
    });
    if (!budget.ok) {
      log.warn(
        {
          missionId,
          scope: budget.scope,
          spentCents: Math.round(budget.spentCents),
          capCents: budget.capCents,
        },
        'adversary: hourly budget reached, skipping',
      );
      lastCallAt = Date.now();
      continue;
    }

    // One claim per pass. Attacking the whole queue at once would let a single
    // model call decide the fate of every claim on the board, which is exactly
    // the concentration this role exists to avoid.
    const target = queue.shift()!;
    lastCallAt = Date.now();

    await view.refresh();
    // Attack the claim against its OWN subject's evidence, not the whole board.
    //
    // Two reasons, and both get worse the wider the mission runs. A claim about
    // one ticker cannot be refuted or supported by observations of two hundred
    // others, so the extra evidence is pure noise the model has to read past.
    // And it is charged for: shipping the entire window on every challenge
    // makes the adversary's prompt grow with the size of the swarm rather than
    // with the size of the claim.
    const evidence = evidenceForClaim(target, view.state.findings);
    let objections: Omit<Challenge, 'id' | 'agentId'>[];
    try {
      objections = await challenge({
        missionId,
        objective: mission.objective,
        hypothesis: target,
        evidence,
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
 * Claims already made about one subject.
 *
 * A hypothesis has no subject of its own — it points at the findings that back
 * it, and those carry the subject. So the mapping goes through the evidence,
 * which is also what keeps the answer honest: a claim built from another
 * subject's findings is not about this one.
 */
function claimsForSubject(
  hypotheses: Hypothesis[],
  findings: Finding[],
  subject: string,
): string[] {
  const ids = new Set(
    findings.filter((f) => (f.provenance.subject ?? '') === subject).map((f) => f.id),
  );
  const claims = hypotheses
    .filter((h) => h.supportingFindingIds.some((id) => ids.has(id)))
    .map((h) => h.claim);
  // Newest last in board order, so the tail is the most recent thinking — which
  // is what to keep when the list has to be trimmed.
  return [...new Set(claims)];
}

/** One subject's evidence, in board order. */
export interface SubjectGroup {
  subject: string;
  findings: Finding[];
  /** Newest observedAt in the group. ISO-8601, so string order is time order. */
  newest: string;
}

/**
 * Split the board by subject, most evidence first.
 *
 * Ordering matters: the rotation resumes by index, so a stable order is what
 * makes "resume where the last pass stopped" mean anything. Subjects with the
 * most evidence lead because they are the ones most likely to have something
 * corroborated across sources, and the cursor guarantees the quiet ones still
 * come round rather than being permanently outranked.
 */
function groupBySubject(findings: Finding[]): SubjectGroup[] {
  const bySubject = new Map<string, Finding[]>();
  for (const f of findings) {
    const subject = f.provenance.subject ?? '';
    const list = bySubject.get(subject) ?? [];
    list.push(f);
    bySubject.set(subject, list);
  }
  return [...bySubject.entries()]
    .map(([subject, list]) => ({
      subject,
      findings: list,
      newest: list.reduce((max, f) => (f.provenance.observedAt > max ? f.provenance.observedAt : max), ''),
    }))
    // Ties broken by name so the rotation order is stable between passes; an
    // order that reshuffles would let the cursor skip subjects at random.
    .sort((a, b) => b.findings.length - a.findings.length || a.subject.localeCompare(b.subject));
}

/**
 * The findings an adversary needs to judge one claim: everything about the
 * subjects that claim was actually built from.
 *
 * Falls back to the whole board when the claim cites nothing we can still see —
 * the claim is unattackable on its merits at that point, and showing the
 * adversary an empty page would produce a confident objection based on no
 * evidence at all, which is worse than an oversized prompt.
 */
function evidenceForClaim(hypothesis: Hypothesis, findings: Finding[]): Finding[] {
  const cited = new Set(hypothesis.supportingFindingIds);
  const subjects = new Set<string>();
  for (const f of findings) {
    if (cited.has(f.id)) subjects.add(f.provenance.subject ?? '');
  }
  if (subjects.size === 0) return findings;
  return findings.filter((f) => subjects.has(f.provenance.subject ?? ''));
}

/**
 * Round-robin across sourceId, newest first within each source, until the
 * budget is spent. Every source that has anything gets a slot before any source
 * gets a second one.
 */
function sampleAcrossSources(findings: Finding[], budget: number): Finding[] {
  const bySource = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = bySource.get(f.provenance.sourceId) ?? [];
    list.push(f);
    bySource.set(f.provenance.sourceId, list);
  }
  // Newest first, so each source contributes its freshest evidence.
  for (const list of bySource.values()) list.reverse();

  const out: Finding[] = [];
  const queues = [...bySource.values()];
  let round = 0;
  while (out.length < budget && queues.some((q) => q.length > round)) {
    for (const q of queues) {
      if (out.length >= budget) break;
      if (q.length > round) out.push(q[round]);
    }
    round += 1;
  }
  return out;
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
