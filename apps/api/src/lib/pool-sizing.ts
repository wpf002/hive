/**
 * The arithmetic behind how wide a mission can be, with no I/O.
 *
 * Separated from the measurement so the sizing rules can be tested directly:
 * the answer differs by two orders of magnitude between pools, and being
 * generous here produces a queue that never drains — a mission that looks like
 * it is working and is not.
 */

/**
 * How many bots a pool can carry on a given cron, as a whole number.
 *
 * One bot on an every-N-minutes cron is 1/N jobs a minute, so the fleet a pool
 * can hold is its throughput times N.
 */
export function maxBotsForPool(jobsPerMinute: number, cronMinutes: number): number {
  return Math.max(1, Math.floor(jobsPerMinute * Math.max(1, cronMinutes)));
}

/**
 * Minutes between runs for a cron, for capacity purposes only.
 *
 * Understanding just the step form is deliberate: it is what the composer
 * produces, and anything else is rare enough that assuming hourly — the
 * conservative direction, since it implies a slower fleet — beats pulling in a
 * full cron interpreter to be exact about a case that does not arise.
 */
export function cronMinutes(cron: string): number {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return 60;
  const step = /^(?:\*|\d+-\d+)\/(\d+)$/.exec(fields[0]);
  if (step) return Number(step[1]);
  if (fields[0] === '*') return 1;
  // A fixed minute with a wildcard hour is hourly; with a fixed hour, daily.
  return fields[1] === '*' ? 60 : 1440;
}
