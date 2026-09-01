import { prisma } from '@hive/db';

/**
 * Cost accounting for every model call the swarm makes.
 *
 * Recorded in micro-cents internally because a single Sonnet call can round to
 * zero whole cents, and a mission that makes thousands of them would report a
 * spend of $0.00 forever. AiUsage.costCents stays the rounded value the rest of
 * the UI already reads.
 */
const PER_MILLION_MICROCENTS: Record<string, { in: number; out: number }> = {
  'claude-sonnet-5': { in: 300_000, out: 1_500_000 },
  'claude-sonnet-4-5': { in: 300_000, out: 1_500_000 },
  'claude-opus-5': { in: 1_500_000, out: 7_500_000 },
  'claude-haiku-4-5-20251001': { in: 80_000, out: 400_000 },
};
const FALLBACK = { in: 300_000, out: 1_500_000 };

export function costMicroCents(model: string, inTok: number, outTok: number): number {
  const p = PER_MILLION_MICROCENTS[model] ?? FALLBACK;
  return Math.round((inTok / 1_000_000) * p.in + (outTok / 1_000_000) * p.out);
}

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
        costCents: Math.round(micro / 10_000),
      },
    })
    .catch(() => {
      /* bookkeeping must never break the loop */
    });
}
