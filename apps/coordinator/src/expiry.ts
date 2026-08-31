import type { Logger } from 'pino';
import { prisma } from '@hive/db';

/**
 * Moves pending proposals past their TTL to `expired`.
 *
 * The approve endpoint re-checks expiry under a transaction, so this sweep is
 * not what makes stale approvals safe — it's what stops the terminal's queue
 * from showing an operator a button that can only fail.
 */
export async function expireStaleProposals(log: Logger): Promise<number> {
  const { count } = await prisma.proposal.updateMany({
    where: { status: 'pending', expiresAt: { lt: new Date() } },
    data: { status: 'expired' },
  });
  if (count > 0) log.info({ count }, 'expired stale proposals');
  return count;
}
