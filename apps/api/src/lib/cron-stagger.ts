/**
 * Offset a step-minute cron (every N minutes) by index so a fleet arrives
 * spread out rather than as one volley.
 *
 * Only the step form is rewritten: it is the one the composer produces for live
 * feeds, and it is the only one where an offset is unambiguously harmless.
 * Anything else — a fixed time, a daily job — is returned untouched, because
 * shifting a cron the operator asked for by an arbitrary amount would be a
 * surprise, not an optimisation.
 */
export function staggerCron(cron: string, index: number): string {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return cron;
  const step = /^\*\/(\d+)$/.exec(fields[0]);
  if (!step) return cron;
  const n = Number(step[1]);
  if (!Number.isInteger(n) || n < 2 || n > 59) return cron;
  const offset = index % n;
  if (offset === 0) return cron;
  fields[0] = `${offset}-59/${n}`;
  return fields.join(' ');
}
