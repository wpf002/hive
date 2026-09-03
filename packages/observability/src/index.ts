import type { Logger } from './types.js';
import { noopReporter, type ErrorContext, type Reporter } from './reporter.js';

export type { ErrorContext, Reporter } from './reporter.js';
export type { Logger } from './types.js';

let reporter: Reporter = noopReporter;

/** Report an error from anywhere. Safe before init — it simply does nothing. */
export function captureError(err: unknown, ctx?: ErrorContext): void {
  try {
    reporter.capture(err, ctx);
  } catch {
    // Reporting must never be the thing that breaks. An error in the error
    // path is how a small failure becomes an outage.
  }
}

export interface InitOptions {
  /** Service name, attached to every report. */
  service: string;
  /** Sentry DSN. Unset disables reporting and leaves the handlers in place. */
  dsn?: string;
  environment?: string;
  release?: string;
  /** Where to write the log line for a fatal. The service's own logger. */
  logger: Logger;
  /**
   * Called before the process exits on a fatal, to shut down cleanly. Keep it
   * short — it runs while the process is already in an unknown state.
   */
  onFatal?: () => Promise<void> | void;
}

/**
 * Install error reporting and the process-level handlers.
 *
 * The handlers are the part that matters, and they were missing everywhere.
 * On Node 20 an unhandled promise rejection terminates the process by default:
 * no log line, no report, no context. For the coordinator that means every
 * running mission stops and the only evidence is that the process is gone.
 *
 * So: log it with the service name and the reason, report it, flush, and exit
 * non-zero so a supervisor restarts rather than leaving a half-dead service
 * that still answers its health check. Deliberately not swallowing these — a
 * process that continues after an unhandled rejection is running with state it
 * cannot reason about, and the second failure is always harder to diagnose
 * than the first.
 */
export async function initObservability(opts: InitOptions): Promise<void> {
  if (opts.dsn) {
    const Sentry = await import('@sentry/node');
    Sentry.init({
      dsn: opts.dsn,
      environment: opts.environment ?? process.env.NODE_ENV ?? 'development',
      release: opts.release,
      // Errors only by default. Tracing on a service that makes thousands of
      // model calls an hour is a bill of its own, and nobody has asked for it.
      tracesSampleRate: 0,
      initialScope: { tags: { service: opts.service } },
    });
    reporter = {
      enabled: true,
      capture(err, ctx) {
        Sentry.withScope((scope) => {
          if (ctx?.where) scope.setTag('where', ctx.where);
          if (ctx?.extra) scope.setExtras(ctx.extra);
          Sentry.captureException(err);
        });
      },
      flush: async (timeoutMs) => {
        await Sentry.flush(timeoutMs);
      },
    };
    opts.logger.info({ service: opts.service }, 'error reporting enabled');
  } else {
    opts.logger.info(
      { service: opts.service },
      'error reporting disabled (SENTRY_DSN unset) — fatal handlers still installed',
    );
  }

  const fatal = (kind: string) => async (err: unknown) => {
    // Log first. If everything after this fails, the log line is still the
    // record that it happened.
    opts.logger.fatal({ err, service: opts.service, kind }, 'fatal — exiting');
    captureError(err, { where: kind, extra: { service: opts.service } });
    try {
      await reporter.flush(2_000);
    } catch {
      /* nothing left to do about it */
    }
    try {
      await opts.onFatal?.();
    } catch {
      /* likewise */
    }
    process.exit(1);
  };

  process.on('unhandledRejection', (reason) => void fatal('unhandledRejection')(reason));
  process.on('uncaughtException', (err) => void fatal('uncaughtException')(err));
}

/** Test seam: swap the reporter without going through Sentry. */
export function __setReporterForTests(r: Reporter): void {
  reporter = r;
}
