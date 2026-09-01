import test from 'node:test';
import assert from 'node:assert/strict';
import { costMicroCents } from './pricing-table.js';

/**
 * These assert the conversion, not the prices — the prices change, but a cent
 * is always 10_000 microcents, and getting that wrong is exactly the bug this
 * file exists to prevent recurring: the table was an order of magnitude low,
 * so every spend figure the product showed was a tenth of the real bill.
 */

test('a million input tokens of Sonnet costs $3.00', () => {
  // $3.00 = 300 cents = 3_000_000 microcents.
  assert.equal(costMicroCents('claude-sonnet-5', 1_000_000, 0), 3_000_000);
});

test('a million output tokens of Sonnet costs $15.00', () => {
  assert.equal(costMicroCents('claude-sonnet-5', 0, 1_000_000), 15_000_000);
});

test('Opus is five times Sonnet on both sides', () => {
  assert.equal(
    costMicroCents('claude-opus-5', 1_000_000, 1_000_000),
    costMicroCents('claude-sonnet-5', 1_000_000, 1_000_000) * 5,
  );
});

test('a typical swarm call lands near two and a third cents', () => {
  // 5k in / 540 out is the measured shape of an analyst call. Whole-cent
  // rounding turned this into 0, which is how a real bill vanished.
  const micro = costMicroCents('claude-sonnet-5', 5_000, 540);
  assert.equal(micro, 23_100);
  assert.ok(micro / 10_000 > 2 && micro / 10_000 < 3, `${micro / 10_000} cents`);
});

test('an unknown model falls back rather than costing nothing', () => {
  assert.ok(costMicroCents('some-future-model', 1_000_000, 0) > 0);
});
