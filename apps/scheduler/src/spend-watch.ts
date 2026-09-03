import { prisma } from '@hive/db';
import { createEmailProvider } from '@hive/email';
import { captureError } from '@hive/observability';
import type { Logger } from 'pino';
import { env } from './env.js';

/**
 * Tell someone when the swarm is spending more than expected.
 *
 * Missions spend real money on their own — that is the product — so the failure
 * mode is not a crash, it is a bill. Nothing watched that number until now: the
 * only spend control was a per-mission hourly cap, which bounds one mission and
 * says nothing about an account running twenty of them, and nobody finds out
 * either way until they read the console.
 *
 * Deliberately an alert and not a brake. Cutting a customer's missions off on a
 * threshold guess would break the thing they are paying for; enforcement
 * belongs with quotas and billing, where the limit is something they agreed to.
 * This exists so nobody is surprised.
 */

/** Per-user spend over a window, in whole cents. */
async function spendByUserCents(sinceMs: number): Promise<Map<string, number>> {
  const since = new Date(Date.now() - sinceMs);
  // AiUsage tags mission spend as `mission:<id>`, so the join back to an owner
  // goes through the mission. Usage with no mission tag (an ai_agent job, say)
  // is not attributable to a user here and is counted separately by the digest.
  const rows = await prisma.$queryRaw<{ userId: string; micro: bigint }[]>`
    SELECT m."userId" AS "userId", SUM(u."costMicroCents")::bigint AS micro
      FROM "AiUsage" u
      JOIN "Mission" m ON u."jobId" = CONCAT('mission:', m.id)
     WHERE u."createdAt" >= ${since}
     GROUP BY m."userId"
  `;
  return new Map(rows.map((r) => [r.userId, Number(r.micro) / 10_000]));
}

/**
 * When each user was last warned, so a sustained overspend produces one message
 * a day rather than one every tick. In memory on purpose: a restart re-warning
 * once is harmless, and a table for it would outlive its usefulness.
 */
const lastWarnedAt = new Map<string, number>();
const WARN_EVERY_MS = 24 * 60 * 60_000;

export async function spendWatchTick(log: Logger): Promise<void> {
  const capCents = env.SPEND_ALERT_DAILY_CENTS;
  if (capCents <= 0) return;

  let spend: Map<string, number>;
  try {
    spend = await spendByUserCents(24 * 60 * 60_000);
  } catch (err) {
    log.error({ err }, 'spend_watch_query_failed');
    captureError(err, { where: 'spend-watch' });
    return;
  }

  for (const [userId, cents] of spend) {
    if (cents < capCents) continue;
    const last = lastWarnedAt.get(userId) ?? 0;
    if (Date.now() - last < WARN_EVERY_MS) continue;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, displayName: true },
    });
    if (!user) continue;

    const dollars = (cents / 100).toFixed(2);
    const capDollars = (capCents / 100).toFixed(2);
    const subject = `Hive: $${dollars} spent in the last 24 hours`;
    const body = [
      `Your swarm has spent $${dollars} on model calls in the last 24 hours,`,
      `which is over the $${capDollars} you set as a warning threshold.`,
      '',
      'Nothing has been stopped. Missions keep running.',
      '',
      'If that is more than you expected, the usual cause is a mission covering',
      'more subjects than intended — spend scales with how many things are being',
      'watched and how often each is re-examined, not with the number of bots.',
      'Stopping a mission from the console halts its spend immediately.',
    ].join('\n');

    // Marked before sending: a mailer that fails after delivering would
    // otherwise re-send on every tick.
    lastWarnedAt.set(userId, Date.now());
    log.warn({ userId, cents, capCents }, 'spend_over_threshold');

    if (!env.RESEND_API_KEY) {
      // Still worth the log line — an operator reading logs learns it, and the
      // absence of a mailer should not silently swallow the finding.
      continue;
    }
    try {
      const mailer = createEmailProvider(env as Parameters<typeof createEmailProvider>[0]);
      await mailer.send({
        to: user.email,
        subject,
        text: body,
        html: `<pre style="font-family:sans-serif;white-space:pre-wrap">${body}</pre>`,
      });
    } catch (err) {
      log.error({ err, userId }, 'spend_alert_send_failed');
      captureError(err, { where: 'spend-watch-email', extra: { userId } });
    }
  }
}
