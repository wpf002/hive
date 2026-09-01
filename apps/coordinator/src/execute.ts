import type { Logger } from 'pino';
import { prisma } from '@hive/db';
import { createEmailProvider } from '@hive/email';
import { env } from './env.js';

/**
 * Executes approved proposals.
 *
 * Two properties matter more than what the executor actually does:
 *
 * 1. A proposal can execute at most once. The claim is a conditional update
 *    from `approved` to `executing`; exactly one executor can win that race,
 *    and a second attempt updates zero rows and walks away. This mirrors the
 *    approve endpoint, which uses the same shape to make double-approval
 *    impossible.
 *
 * 2. The TTL is re-checked at execution time, not just at approval. An approval
 *    that sat in the queue while the world moved on must not fire — the whole
 *    point of `expiresAt` is that a stale decision is a wrong decision.
 *
 * Only `notify` is implemented. Any other verb is recorded as failed rather
 * than silently ignored, because a mission whose action never happens and never
 * complains is worse than one that errors.
 */
export async function runExecutorPass(log: Logger): Promise<number> {
  const now = new Date();

  const claimable = await prisma.proposal.findMany({
    where: { status: 'approved', expiresAt: { gt: now } },
    orderBy: { decidedAt: 'asc' },
    take: 20,
    include: { mission: { select: { id: true, name: true, allowedActions: true, userId: true } } },
  });
  if (claimable.length === 0) return 0;

  let executed = 0;
  for (const p of claimable) {
    // Claim it. Zero rows updated means another pass (or another process) got
    // there first, or it expired in the meantime — either way, not ours.
    const { count } = await prisma.proposal.updateMany({
      where: { id: p.id, status: 'approved', expiresAt: { gt: new Date() } },
      data: { status: 'executing' },
    });
    if (count === 0) continue;

    try {
      // Re-check the action against the mission's current allow-list. Widening
      // is admin-only, but narrowing it after an approval must take effect.
      if (!p.mission.allowedActions.includes(p.action)) {
        throw new Error(`action "${p.action}" is no longer allowed by this mission`);
      }
      if (p.action !== 'notify') {
        throw new Error(`no executor implements action "${p.action}"`);
      }

      await notify(p.mission, p.rationale, p.params as Record<string, unknown>);

      await prisma.proposal.update({
        where: { id: p.id },
        data: { status: 'executed', error: null },
      });
      executed += 1;
      log.info({ missionId: p.missionId, proposalId: p.id, action: p.action }, 'executor: done');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await prisma.proposal.update({
        where: { id: p.id },
        data: { status: 'failed', error: message.slice(0, 500) },
      });
      log.error({ err, missionId: p.missionId, proposalId: p.id }, 'executor: failed');
    }
  }
  return executed;
}

/** The one implemented verb: tell the mission's owner what the swarm concluded. */
async function notify(
  mission: { id: string; name: string; userId: string },
  rationale: string,
  params: Record<string, unknown>,
): Promise<void> {
  const owner = await prisma.user.findUnique({
    where: { id: mission.userId },
    select: { email: true },
  });
  const to = owner?.email ?? env.HIVE_DAILY_REPORT_EMAIL;
  if (!to) throw new Error('no recipient: mission owner has no email and no fallback is set');

  const detail = Object.entries(params)
    .filter(([k]) => k !== 'refuted' && k !== 'independentSources')
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join('\n');

  const text = [
    rationale,
    '',
    `independent sources: ${String(params.independentSources ?? 'unknown')}`,
    detail,
  ].join('\n');

  await createEmailProvider().send({
    to,
    subject: `🐝 ${mission.name} — swarm proposal approved`,
    text,
    html: `<pre style="font-family:ui-monospace,monospace;white-space:pre-wrap">${escapeHtml(text)}</pre>`,
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}
