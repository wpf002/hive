/**
 * Where an error goes when nobody is watching the logs.
 *
 * Sentry when a DSN is configured, and a no-op that only logs otherwise. The
 * no-op is the point: every service calls the same code whether or not error
 * reporting is set up, so wiring it in is one environment variable rather than
 * a code change per service, and a missing DSN in development never turns into
 * a crash on boot.
 */

export interface ErrorContext {
  /** Where it happened, e.g. 'mission-loop' or 'POST /api/missions'. */
  where?: string;
  /** Anything that helps identify the case. Never put secrets here. */
  extra?: Record<string, unknown>;
}

export interface Reporter {
  capture(err: unknown, ctx?: ErrorContext): void;
  /** Wait for queued reports to leave the process. Called before exiting. */
  flush(timeoutMs: number): Promise<void>;
  readonly enabled: boolean;
}

export const noopReporter: Reporter = {
  capture() {},
  async flush() {},
  enabled: false,
};
