import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timingSafeEqualStr } from './constant-time.js';

test('timingSafeEqualStr: equal strings compare true', () => {
  assert.equal(timingSafeEqualStr('correct-token', 'correct-token'), true);
  assert.equal(timingSafeEqualStr('', ''), true);
});

test('timingSafeEqualStr: different same-length strings compare false', () => {
  assert.equal(timingSafeEqualStr('abcdef', 'abcdeg'), false);
  assert.equal(timingSafeEqualStr('token-a', 'token-b'), false);
});

test('timingSafeEqualStr: different-length strings compare false (no throw)', () => {
  // crypto.timingSafeEqual throws on length mismatch; the wrapper must guard it.
  assert.equal(timingSafeEqualStr('short', 'a-much-longer-token'), false);
  assert.equal(timingSafeEqualStr('a-much-longer-token', 'short'), false);
});

test('timingSafeEqualStr: handles unicode / multibyte without throwing', () => {
  assert.equal(timingSafeEqualStr('🐝secret', '🐝secret'), true);
  assert.equal(timingSafeEqualStr('🐝secret', '🐝secreX'), false);
});
