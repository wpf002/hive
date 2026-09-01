import test from 'node:test';
import assert from 'node:assert/strict';
import { collapseFindings, clusterByClaim, scoreIndependence } from './dedup.js';
import type { Challenge, Finding, Hypothesis } from './types.js';

const prov = (
  sourceId: string,
  hash: string,
  observedAt = '2026-01-01T00:00:00.000Z',
  subject = '',
) => ({
  sourceId,
  subject,
  sourceKind: 'http',
  observedAt,
  fetchedAt: '2026-01-01T00:00:01.000Z',
  contentHash: hash.padEnd(64, '0'),
  jobId: 'j1',
});

const finding = (
  id: string,
  sourceId: string,
  hash: string,
  observedAt?: string,
  subject = '',
): Finding => ({
  id,
  missionId: 'm1',
  agentId: `a-${id}`,
  kind: 'price',
  payload: {},
  provenance: prov(sourceId, hash, observedAt, subject),
});

const hyp = (id: string, claim: string, supporting: string[], confidence = 0.8): Hypothesis => ({
  id,
  missionId: 'm1',
  agentId: `a-${id}`,
  claim,
  confidence,
  supportingFindingIds: supporting,
  independentSources: 0,
});

test('identical content from one source collapses to a single finding', () => {
  const out = collapseFindings([
    finding('1', 'espn', 'aa'),
    finding('2', 'espn', 'aa'),
    finding('3', 'espn', 'aa'),
  ]);
  assert.equal(out.length, 1);
});

test('same content from different sources stays separate', () => {
  const out = collapseFindings([finding('1', 'espn', 'aa'), finding('2', 'dk', 'aa')]);
  assert.equal(out.length, 2);
});

test('collapse keeps the earliest observation of identical content', () => {
  const out = collapseFindings([
    finding('late', 'espn', 'aa', '2026-01-01T12:00:00.000Z'),
    finding('early', 'espn', 'aa', '2026-01-01T06:00:00.000Z'),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'early');
});

test('agreeing agents reading one source score as one independent source', () => {
  const findings = [finding('1', 'espn', 'aa'), finding('2', 'espn', 'bb')];
  const hyps = [1, 2, 3].map((n) => hyp(`h${n}`, 'Line is moving toward the favorite', ['1', '2']));
  const [cluster] = clusterByClaim(hyps, findings);
  assert.equal(cluster.members.length, 3);
  assert.equal(cluster.independentSources, 1);
});

test('claims backed by distinct sources outrank a larger single-source cluster', () => {
  const findings = [finding('1', 'espn', 'aa'), finding('2', 'dk', 'bb'), finding('3', 'fd', 'cc')];
  const hyps = [
    hyp('h1', 'Echoed claim', ['1']),
    hyp('h2', 'Echoed claim', ['1']),
    hyp('h3', 'Echoed claim', ['1']),
    hyp('h4', 'Corroborated claim', ['2', '3']),
  ];
  const ranked = clusterByClaim(hyps, findings);
  assert.equal(ranked[0].claim, 'corroborated claim');
  assert.equal(ranked[0].independentSources, 2);
  assert.equal(ranked[1].members.length, 3);
  assert.equal(ranked[1].independentSources, 1);
});

test('a refuting challenge marks its cluster refuted', () => {
  const findings = [finding('1', 'espn', 'aa')];
  const hyps = [hyp('h1', 'Claim', ['1'])];
  const challenges: Challenge[] = [
    { id: 'c1', hypothesisId: 'h1', agentId: 'adv', objection: 'stale quote', severity: 'refutes' },
  ];
  const [cluster] = clusterByClaim(hyps, findings, challenges);
  assert.equal(cluster.refuted, true);
  assert.equal(cluster.objections.length, 1);
});

test('scoreIndependence counts distinct sources, ignoring unknown finding ids', () => {
  const findings = [finding('1', 'espn', 'aa'), finding('2', 'dk', 'bb')];
  const scored = scoreIndependence(hyp('h1', 'Claim', ['1', '2', 'missing']), findings);
  assert.equal(scored.independentSources, 2);
});

// --- selectCluster ---------------------------------------------------------
//
// These lock in the fix for the defect that made the constraint gates
// meaningless: scoring `clusters[0]` instead of the claim actually chosen.

import { selectCluster } from './dedup.js';

const boardOf = () => {
  const findings = [
    finding('1', 'espn', 'aa'),
    finding('2', 'dk', 'bb'),
    finding('3', 'fd', 'cc'),
  ];
  const hyps = [
    // Ranks first: two independent sources.
    hyp('h1', 'Money is on the favorite across both books', ['2', '3']),
    // Three agents, one source — the echo.
    hyp('h2', 'Line is moving toward the favorite', ['1']),
    hyp('h3', 'Line is moving toward the favorite', ['1']),
    hyp('h4', 'Line is moving toward the favorite', ['1']),
    // Refuted.
    hyp('h5', 'Sharp reverse line movement', ['1']),
  ];
  const challenges: Challenge[] = [
    { id: 'c1', hypothesisId: 'h5', agentId: 'adv', objection: 'stale', severity: 'refutes' },
  ];
  return clusterByClaim(hyps, findings, challenges);
};

test('selectCluster returns the claim the decision names, not the top-ranked one', () => {
  const clusters = boardOf();
  assert.equal(clusters[0].independentSources, 2, 'precondition: best-supported claim ranks first');

  const chosen = selectCluster(clusters, 'Line is moving toward the favorite');
  assert.ok(chosen);
  assert.equal(
    chosen.independentSources,
    1,
    'an echoed claim must be scored on its own single source, not the board maximum',
  );
  assert.equal(chosen.members.length, 3);
});

test('selectCluster surfaces refutation of the chosen claim, not of the top claim', () => {
  const clusters = boardOf();
  assert.equal(clusters[0].refuted, false, 'precondition: top claim is clean');

  const chosen = selectCluster(clusters, 'Sharp reverse line movement');
  assert.ok(chosen);
  assert.equal(chosen.refuted, true, 'a refuted claim must not inherit the top claim’s clean bill');
});

test('selectCluster matches regardless of case and punctuation', () => {
  const clusters = boardOf();
  const chosen = selectCluster(clusters, '  LINE is moving, toward the FAVORITE!  ');
  assert.ok(chosen);
  assert.equal(chosen.members.length, 3);
});

test('selectCluster returns null for an unrecognisable claim', () => {
  const clusters = boardOf();
  // The caller must refuse to propose here. Falling back to a default cluster
  // is exactly the bug this function exists to prevent.
  assert.equal(selectCluster(clusters, 'a claim nobody made'), null);
  assert.equal(selectCluster(clusters, null), null);
  assert.equal(selectCluster(clusters, '   '), null);
  assert.equal(selectCluster([], 'anything'), null);
});

// ---- subject fan-out -------------------------------------------------------
// A wide mission's whole value rests on these two properties: that two subjects
// on one source stay separate, and that agreement is only counted within a
// subject. Both fail silently if broken — the mission keeps running and just
// reports numbers that aren't true.

test('identical bytes from two subjects on one source are two findings', () => {
  // 200 monitors on one provider all returning {"status":"ok"} hash the same.
  // Collapsing them would leave one subject standing and erase 199.
  const out = collapseFindings([
    finding('1', 'pingdom', 'aa', undefined, 'api.example.com'),
    finding('2', 'pingdom', 'aa', undefined, 'web.example.com'),
    finding('3', 'pingdom', 'aa', undefined, 'db.example.com'),
  ]);
  assert.equal(out.length, 3);
});

test('identical bytes from one subject on one source still collapse', () => {
  const out = collapseFindings([
    finding('1', 'pingdom', 'aa', undefined, 'api.example.com'),
    finding('2', 'pingdom', 'aa', undefined, 'api.example.com'),
  ]);
  assert.equal(out.length, 1);
});

test('two sources on the same subject corroborate', () => {
  const findings = [
    finding('f1', 'nasdaq', 'aa', undefined, 'AAPL'),
    finding('f2', 'yahoo', 'bb', undefined, 'AAPL'),
  ];
  const scored = scoreIndependence(hyp('h1', 'AAPL is moving', ['f1', 'f2']), findings);
  assert.equal(scored.independentSources, 2);
});

test('two sources on different subjects do not corroborate', () => {
  // The failure a wide mission would otherwise manufacture for free: breadth
  // read as agreement. Each entity was seen exactly once.
  const findings = [
    finding('f1', 'nasdaq', 'aa', undefined, 'AAPL'),
    finding('f2', 'yahoo', 'bb', undefined, 'MSFT'),
  ];
  const scored = scoreIndependence(hyp('h1', 'tech is moving', ['f1', 'f2']), findings);
  assert.equal(scored.independentSources, 1);
});

test('a cross-subject claim scores its best single subject', () => {
  const findings = [
    finding('f1', 'nasdaq', 'aa', undefined, 'AAPL'),
    finding('f2', 'yahoo', 'bb', undefined, 'AAPL'),
    finding('f3', 'nasdaq', 'cc', undefined, 'MSFT'),
  ];
  const scored = scoreIndependence(hyp('h1', 'mixed', ['f1', 'f2', 'f3']), findings);
  assert.equal(scored.independentSources, 2);
});

test('clusters report the subject their support was counted on', () => {
  const findings = [
    finding('f1', 'nasdaq', 'aa', undefined, 'AAPL'),
    finding('f2', 'yahoo', 'bb', undefined, 'AAPL'),
  ];
  const [cluster] = clusterByClaim([hyp('h1', 'AAPL is moving', ['f1', 'f2'])], findings);
  assert.equal(cluster.subject, 'AAPL');
  assert.equal(cluster.independentSources, 2);
});

test('a mission with no fan-out is scored exactly as before', () => {
  const findings = [finding('f1', 'espn', 'aa'), finding('f2', 'draftkings', 'bb')];
  const scored = scoreIndependence(hyp('h1', 'line moved', ['f1', 'f2']), findings);
  assert.equal(scored.independentSources, 2);
});
