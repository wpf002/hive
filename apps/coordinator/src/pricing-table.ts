/**
 * What a model call costs, as arithmetic and nothing else.
 *
 * Kept apart from the recorder so the conversion can be tested without a
 * database — the bug this guards against was a wrong constant, which is exactly
 * the kind of thing that survives when the only way to exercise it is to run
 * the whole service.
 */

// Microcents per million tokens. One cent is 10_000 microcents, so a model at
// $3.00 per million input tokens is 300 cents = 3_000_000 microcents.
//
// This table was an order of magnitude low, which made every spend figure the
// product reported — the run rate on the console included — read as a tenth of
// what was actually being charged. Worth stating the conversion in full here
// rather than trusting the zeroes to line up by eye.
const PER_MILLION_MICROCENTS: Record<string, { in: number; out: number }> = {
  'claude-sonnet-5': { in: 3_000_000, out: 15_000_000 }, // $3 / $15
  'claude-sonnet-4-5': { in: 3_000_000, out: 15_000_000 },
  'claude-opus-5': { in: 15_000_000, out: 75_000_000 }, // $15 / $75
  'claude-haiku-4-5-20251001': { in: 800_000, out: 4_000_000 }, // $0.80 / $4
};
const FALLBACK = { in: 3_000_000, out: 15_000_000 };

export function costMicroCents(model: string, inTok: number, outTok: number): number {
  const p = PER_MILLION_MICROCENTS[model] ?? FALLBACK;
  return Math.round((inTok / 1_000_000) * p.in + (outTok / 1_000_000) * p.out);
}
