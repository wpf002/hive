import test from 'node:test';
import assert from 'node:assert/strict';
import { PLANS, DEFAULT_PLAN, effectivePlan } from './plans.js';

/**
 * These limits are the only thing standing between one tenant and everyone
 * else's worker pools, so the ways they can quietly stop applying matter more
 * than the numbers themselves.
 */

test('an account with no plan gets the smallest limits, not unlimited', () => {
  const p = effectivePlan({});
  assert.equal(p.id, DEFAULT_PLAN.id);
  assert.ok(p.maxBots > 0 && p.dailySpendCents > 0);
});

test('a renamed or removed plan degrades rather than throwing', () => {
  // A tier deleted during a pricing change must not lock a paying customer out
  // of the product, nor hand them unlimited use.
  const p = effectivePlan({ plan: 'plan-that-no-longer-exists' });
  assert.equal(p.id, DEFAULT_PLAN.id);
});

test('a per-user override wins over the plan', () => {
  const p = effectivePlan({ plan: 'free', quotaMaxBots: 500 });
  assert.equal(p.maxBots, 500);
  // And leaves everything it did not name alone.
  assert.equal(p.dailySpendCents, PLANS.free.dailySpendCents);
});

test('a zero override is honoured, not treated as absent', () => {
  // ?? rather than ||, because 0 is a meaningful limit: it is how you suspend
  // an account without deleting it.
  assert.equal(effectivePlan({ plan: 'pro', quotaMaxBots: 0 }).maxBots, 0);
  assert.equal(effectivePlan({ plan: 'pro', quotaDailySpendCents: 0 }).dailySpendCents, 0);
});

test('no plan can claim more than the whole of a pool', () => {
  for (const p of Object.values(PLANS)) {
    assert.ok(p.poolShare > 0 && p.poolShare <= 1, `${p.id} poolShare out of range`);
  }
});

test('plans are ordered — a larger tier is never smaller on any axis', () => {
  const order = [PLANS.free, PLANS.pro, PLANS.enterprise];
  for (let i = 1; i < order.length; i++) {
    const lo = order[i - 1];
    const hi = order[i];
    assert.ok(hi.maxBots >= lo.maxBots, `${hi.id} has fewer bots than ${lo.id}`);
    assert.ok(hi.maxMissions >= lo.maxMissions, `${hi.id} has fewer missions than ${lo.id}`);
    assert.ok(hi.poolShare >= lo.poolShare, `${hi.id} has a smaller pool share than ${lo.id}`);
    assert.ok(
      hi.dailySpendCents >= lo.dailySpendCents,
      `${hi.id} has a lower spend cap than ${lo.id}`,
    );
  }
});
