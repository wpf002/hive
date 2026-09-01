import test from 'node:test';
import assert from 'node:assert/strict';
import { maxBotsForPool, cronMinutes } from './pool-sizing.js';

/**
 * The sizing arithmetic behind "how many bots is too many". Kept pure and
 * tested because the answer differs by two orders of magnitude between pools,
 * and getting it wrong in the generous direction produces a queue that never
 * drains — a mission that looks like it is working and is not.
 */

test('cron minutes are read from the step, including a staggered one', () => {
  assert.equal(cronMinutes('*/5 * * * *'), 5);
  assert.equal(cronMinutes('3-59/5 * * * *'), 5);
  assert.equal(cronMinutes('* * * * *'), 1);
});

test('non-step crons fall back to the slow, conservative reading', () => {
  // Assuming slower implies a smaller fleet, which is the safe direction.
  assert.equal(cronMinutes('30 * * * *'), 60);
  assert.equal(cronMinutes('0 9 * * *'), 1440);
  assert.equal(cronMinutes('nonsense'), 60);
});

test('a slow pool carries far fewer bots than a fast one at the same cron', () => {
  // Measured on this instance: browser is 4 concurrent at ~30s p90, monitor is
  // 16 concurrent at ~0.5s. Same cron, two orders of magnitude apart.
  const browser = (4 / 30) * 60 * 0.7;
  const monitor = (16 / 0.5) * 60 * 0.7;
  assert.ok(maxBotsForPool(monitor, 5) > maxBotsForPool(browser, 5) * 50);
});

test('a slower cron proportionally raises the fleet a pool can hold', () => {
  assert.equal(maxBotsForPool(10, 10), maxBotsForPool(10, 5) * 2);
});

test('the floor is one bot, never zero', () => {
  // Zero would refuse to compose anything at all rather than composing something
  // small, which is a worse answer than a slow mission.
  assert.equal(maxBotsForPool(0.001, 1), 1);
});
