import { prisma } from '@hive/db';
import { costMicroCents } from './pricing-table.js';

/**
 * Cost accounting for every model call the swarm makes.
 *
 * Recorded in micro-cents internally because a single Sonnet call can round to
 * zero whole cents, and a mission that makes thousands of them would report a
 * spend of $0.00 forever. AiUsage.costCents stays the rounded value the rest of
 * the UI already reads.
 */
/** Never let cost accounting fail a decision — it is bookkeeping, not control flow. */
export async function recordUsage(args: {
  missionId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}): Promise<void> {
  const micro = costMicroCents(args.model, args.inputTokens, args.outputTokens);
  await prisma.aiUsage
    .create({
      data: {
        jobId: `mission:${args.missionId}`,
        provider: 'claude',
        model: args.model,
        inputTokens: args.inputTokens,
        outputTokens: args.outputTokens,
        // Both, on purpose. costCents is what the rest of the product already
        // reads; microcents is what makes the total true. Rounding each call to
        // whole cents threw away most of the bill — a swarm's spend is
        // thousands of sub-cent calls, and every one of them rounded to zero.
        costCents: Math.round(micro / 10_000),
        costMicroCents: micro,
      },
    })
    .catch(() => {
      /* bookkeeping must never break the loop */
    });
}

export { costMicroCents } from './pricing-table.js';
