import test from 'node:test';
import assert from 'node:assert/strict';
import { captureError, initObservability, __setReporterForTests } from './index.js';
import { noopReporter } from './reporter.js';

/**
 * The handlers are the whole point of this package, and the way they fail is
 * by not being installed — which is exactly what a passing service looks like
 * until the day it matters. So assert they are registered and that a fatal
 * runs the full sequence: log, report, flush, clean up, exit non-zero.
 */

function fakeLogger() {
  const lines: { level: string; obj: object }[] = [];
  return {
    lines,
    info: (obj: object) => lines.push({ level: 'info', obj }),
    fatal: (obj: object) => lines.push({ level: 'fatal', obj }),
  };
}

test('capturing before init is safe rather than a crash in the error path', () => {
  __setReporterForTests(noopReporter);
  assert.doesNotThrow(() => captureError(new Error('early'), { where: 'boot' }));
});

test('a reporter that throws cannot take the process with it', () => {
  __setReporterForTests({
    enabled: true,
    capture() {
      throw new Error('reporting backend is down');
    },
    async flush() {},
  });
  assert.doesNotThrow(() => captureError(new Error('x')));
  __setReporterForTests(noopReporter);
});

test('init installs both fatal handlers', async () => {
  const before = {
    rejection: process.listenerCount('unhandledRejection'),
    exception: process.listenerCount('uncaughtException'),
  };
  const logger = fakeLogger();
  await initObservability({ service: 'test', logger });
  assert.equal(process.listenerCount('unhandledRejection'), before.rejection + 1);
  assert.equal(process.listenerCount('uncaughtException'), before.exception + 1);
  process.removeAllListeners('unhandledRejection');
  process.removeAllListeners('uncaughtException');
});

test('with no DSN it says so rather than failing to start', async () => {
  const logger = fakeLogger();
  await initObservability({ service: 'test', logger });
  const line = logger.lines.at(-1);
  assert.equal(line?.level, 'info');
  process.removeAllListeners('unhandledRejection');
  process.removeAllListeners('uncaughtException');
});

test('an unhandled rejection logs fatally, cleans up, and exits non-zero', async () => {
  const logger = fakeLogger();
  let flushed = false;
  let cleanedUp = false;
  __setReporterForTests({
    enabled: true,
    capture() {},
    async flush() {
      flushed = true;
    },
  });
  const realExit = process.exit;
  let exitCode: number | undefined;
  // @ts-expect-error — replacing exit for the duration of the assertion
  process.exit = (code?: number) => {
    exitCode = code;
  };
  await initObservability({
    service: 'test',
    logger,
    onFatal: () => {
      cleanedUp = true;
    },
  });
  const handler = process.listeners('unhandledRejection').at(-1) as (r: unknown) => void;
  handler(new Error('boom'));
  // The handler is async; let its microtasks run.
  await new Promise((r) => setTimeout(r, 20));

  process.exit = realExit;
  process.removeAllListeners('unhandledRejection');
  process.removeAllListeners('uncaughtException');
  __setReporterForTests(noopReporter);

  assert.ok(
    logger.lines.some((l) => l.level === 'fatal'),
    'the failure must be in the log even if everything after it fails',
  );
  assert.ok(flushed, 'queued reports must leave the process before it dies');
  assert.ok(cleanedUp, 'the service gets a chance to shut down');
  assert.equal(exitCode, 1, 'non-zero so a supervisor restarts instead of leaving a zombie');
});
