import test from 'node:test';
import assert from 'node:assert/strict';
import { coreRules, evaluate, type ConstraintContext } from './constraints.js';
import type { Proposal } from './types.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');

const ctx = (over: Partial<ConstraintContext> = {}): ConstraintContext => ({
  now: NOW,
  counters: {},
  limits: {},
  allowedActions: ['notify'],
  ...over,
});

const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  id: 'p1',
  missionId: 'm1',
  action: 'notify',
  params: { independentSources: 3 },
  rationale: 'because',
  status: 'pending',
  expiresAt: '2026-01-01T00:05:00.000Z',
  constraintResults: [],
  ...over,
});

test('a clean proposal passes every core rule and stays pending', () => {
  const out = evaluate(proposal(), ctx());
  assert.equal(out.status, 'pending');
  assert.ok(out.constraintResults.every((r) => r.passed));
  assert.equal(out.constraintResults.length, coreRules.length);
});

test('an expired proposal is rejected', () => {
  const out = evaluate(proposal({ expiresAt: '2025-12-31T23:59:00.000Z' }), ctx());
  assert.equal(out.status, 'rejected');
  assert.equal(out.constraintResults.find((r) => r.rule === 'not_expired')?.passed, false);
});

test('an action outside allowedActions is rejected', () => {
  const out = evaluate(proposal({ action: 'place_order' }), ctx());
  assert.equal(out.status, 'rejected');
  assert.equal(out.constraintResults.find((r) => r.rule === 'action_allowed')?.passed, false);
});

test('the mission action budget rejects once the cap is reached', () => {
  const out = evaluate(
    proposal(),
    ctx({ counters: { 'mission:actions': 40 }, limits: { 'mission:actions': 40 } }),
  );
  assert.equal(out.status, 'rejected');
  assert.equal(out.constraintResults.find((r) => r.rule === 'mission_action_budget')?.passed, false);
});

test('single-source support is rejected by the default two-source minimum', () => {
  const out = evaluate(proposal({ params: { independentSources: 1 } }), ctx());
  assert.equal(out.status, 'rejected');
  const rule = out.constraintResults.find((r) => r.rule === 'requires_independent_support');
  assert.equal(rule?.passed, false);
  assert.match(rule?.detail ?? '', /1 independent sources, need 2/);
});

test('a refuted claim never reaches the approval queue', () => {
  const out = evaluate(proposal({ params: { independentSources: 5, refuted: true } }), ctx());
  assert.equal(out.status, 'rejected');
  assert.equal(out.constraintResults.find((r) => r.rule === 'not_refuted')?.passed, false);
});

test('constraint rules are pure — evaluating twice yields the same verdict', () => {
  const p = proposal();
  const c = ctx();
  assert.deepEqual(evaluate(p, c).constraintResults, evaluate(p, c).constraintResults);
});
