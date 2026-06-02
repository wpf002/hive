import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, verifyPasswordDummy } from './passwords.js';

test('hashPassword produces a bcrypt hash that verifies', async () => {
  const hash = await hashPassword('correct horse battery');
  assert.match(hash, /^\$2[aby]\$\d{2}\$/); // bcrypt format
  assert.equal(await verifyPassword('correct horse battery', hash), true);
});

test('verifyPassword rejects the wrong password', async () => {
  const hash = await hashPassword('correct horse battery');
  assert.equal(await verifyPassword('wrong password', hash), false);
});

test('hashPassword enforces the 8-char minimum', async () => {
  await assert.rejects(() => hashPassword('short'), /at least 8 characters/);
});

test('verifyPassword returns false on empty input instead of throwing', async () => {
  assert.equal(await verifyPassword('', '$2b$12$abcdefghijklmnopqrstuv'), false);
  assert.equal(await verifyPassword('something', ''), false);
});

test('verifyPasswordDummy always returns false (enumeration guard)', async () => {
  assert.equal(await verifyPasswordDummy('anything'), false);
  assert.equal(await verifyPasswordDummy(''), false);
});

test('the same password hashed twice yields different hashes (salted)', async () => {
  const a = await hashPassword('repeat-me-please');
  const b = await hashPassword('repeat-me-please');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('repeat-me-please', a), true);
  assert.equal(await verifyPassword('repeat-me-please', b), true);
});
