import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, contentHash, isoUtc, stripVolatile } from './provenance.js';

test('key order does not change the hash', () => {
  assert.equal(contentHash({ a: 1, b: 2 }), contentHash({ b: 2, a: 1 }));
});

test('array order does change the hash', () => {
  assert.notEqual(contentHash([1, 2]), contentHash([2, 1]));
});

test('nested objects are canonicalized at every level', () => {
  assert.equal(
    canonicalJson({ z: { b: 1, a: 2 }, y: [{ d: 1, c: 2 }] }),
    '{"y":[{"c":2,"d":1}],"z":{"a":2,"b":1}}',
  );
});

test('undefined properties drop out, null is preserved', () => {
  assert.equal(canonicalJson({ a: undefined, b: null }), '{"b":null}');
  assert.equal(contentHash({ a: 1, b: undefined }), contentHash({ a: 1 }));
});

test('a hash is always 64 lowercase hex characters', () => {
  for (const v of [null, 1, 'x', { a: 1 }, [1, 2], { deep: { deeper: [1] } }]) {
    assert.match(contentHash(v), /^[0-9a-f]{64}$/);
  }
});

test('a changed value changes the hash', () => {
  assert.notEqual(contentHash({ score: 10 }), contentHash({ score: 11 }));
});

// The failure this exists to prevent: a per-run field in the hash makes every
// observation unique, so dedup silently stops working while looking healthy.
test('jobId can never reach the hash', () => {
  const a = stripVolatile({ score: 10, jobId: 'job-1' }, []);
  const b = stripVolatile({ score: 10, jobId: 'job-2' }, []);
  assert.deepEqual(a, b);
  assert.equal(contentHash(a), contentHash(b));
});

test('declared volatile fields are stripped alongside the always-stripped set', () => {
  const a = stripVolatile({ ok: true, latencyMs: 68, fetchedAt: 'x' }, ['latencyMs']);
  const b = stripVolatile({ ok: true, latencyMs: 9142, fetchedAt: 'y' }, ['latencyMs']);
  assert.deepEqual(a, { ok: true });
  assert.equal(contentHash(a), contentHash(b), 'a measured latency must not defeat dedup');
});

test('isoUtc always produces a Z-suffixed string zod .datetime() accepts', () => {
  const fallback = new Date('2026-01-01T00:00:00.000Z');
  // Python emits +00:00, which zod's .datetime() rejects.
  assert.equal(isoUtc('2026-08-31T12:00:00.123456+00:00', fallback), '2026-08-31T12:00:00.123Z');
  assert.equal(isoUtc(undefined, fallback), '2026-01-01T00:00:00.000Z');
  assert.equal(isoUtc('not a date', fallback), '2026-01-01T00:00:00.000Z');
  assert.match(isoUtc(new Date('2026-03-04T05:06:07Z'), fallback), /Z$/);
});
