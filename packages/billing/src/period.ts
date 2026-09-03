/**
 * Which month a charge falls in.
 *
 * Separated from the metering so it can be tested without a database. An
 * off-by-one here moves real money between two invoices, and that is not a
 * thing to find out by running the whole service.
 */

/** UTC month containing `at`, as a half-open [start, end) range. */
export function periodBounds(at: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  return { start, end };
}
