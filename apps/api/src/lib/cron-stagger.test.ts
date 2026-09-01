import test from 'node:test';
import assert from 'node:assert/strict';
import cronParser from 'cron-parser';
import { staggerCron } from './cron-stagger.js';

/**
 * The failure this guards: 200 bots on the same every-5-minutes cron queue 200
 * jobs on one second, then nothing for five minutes. The pools spike, the field
 * pulses, and the mission looks broken while doing exactly the work it was
 * asked to.
 */

test('a step cron is offset by index, wrapping at the step', () => {
  assert.equal(staggerCron('*/5 * * * *', 0), '*/5 * * * *');
  assert.equal(staggerCron('*/5 * * * *', 1), '1-59/5 * * * *');
  assert.equal(staggerCron('*/5 * * * *', 4), '4-59/5 * * * *');
  assert.equal(staggerCron('*/5 * * * *', 5), '*/5 * * * *');
});

test('every offset it produces is a cron the scheduler can parse', () => {
  for (let i = 0; i < 12; i++) {
    const cron = staggerCron('*/5 * * * *', i);
    assert.doesNotThrow(() => cronParser.parseExpression(cron), cron);
  }
});

test('a fleet spreads evenly across the interval rather than firing at once', () => {
  // 200 bots on a 5-minute step should land on 5 distinct starting minutes,
  // not one.
  const minutes = new Set(
    Array.from({ length: 200 }, (_, i) =>
      cronParser.parseExpression(staggerCron('*/5 * * * *', i)).next().toDate().getMinutes() % 5,
    ),
  );
  assert.equal(minutes.size, 5);
});

test('crons that are not a minute step are returned untouched', () => {
  // Shifting a time the operator actually chose would be a surprise, not an
  // optimisation.
  assert.equal(staggerCron('0 9 * * *', 3), '0 9 * * *');
  assert.equal(staggerCron('30 * * * *', 3), '30 * * * *');
  assert.equal(staggerCron('* * * * *', 3), '* * * * *');
  assert.equal(staggerCron('not a cron', 3), 'not a cron');
});
