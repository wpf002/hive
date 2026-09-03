// @hive/crypto reads HIVE_SECRETS_KEY lazily (on first encrypt/decrypt), so it
// is enough to set it before the first call — no import-order gymnastics needed.
process.env.HIVE_SECRETS_KEY =
  '2222222222222222222222222222222222222222222222222222222222222222';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encrypt, decrypt, isEncrypted, PREFIX } from './index.js';

test('encrypt produces the v1 wire format and isEncrypted recognizes it', () => {
  const ct = encrypt('hello bee');
  assert.ok(ct.startsWith(PREFIX));
  assert.equal(isEncrypted(ct), true);
  assert.equal(isEncrypted('plain text'), false);
  assert.equal(isEncrypted(42), false);
});

test('encrypt → decrypt round-trips, including unicode', () => {
  for (const plain of ['', 'simple', 'secret🐝 with spaces', 'x'.repeat(5000)]) {
    assert.equal(decrypt(encrypt(plain)), plain);
  }
});

test('encryption is non-deterministic (fresh nonce each call)', () => {
  const a = encrypt('same input');
  const b = encrypt('same input');
  assert.notEqual(a, b); // different nonces
  assert.equal(decrypt(a), decrypt(b)); // but both decrypt to the same thing
});

test('decrypt rejects a tampered ciphertext (AEAD auth tag)', () => {
  const ct = encrypt('do not tamper');
  // Flip a character in the base64 body to corrupt the tag/ciphertext.
  //
  // Written carefully because the obvious version is subtly wrong: choosing the
  // replacement by looking at one index and writing it to a different one means
  // that whenever the target character already equals the replacement, nothing
  // is tampered with, decrypt correctly succeeds, and the test fails. That is a
  // roughly one-in-sixty flake on a security assertion — the worst kind, since
  // the reflex on a red build is to re-run it until it goes green.
  //
  // Pick the replacement from the character actually being replaced, so the
  // string always changes.
  const body = ct.slice(PREFIX.length);
  const flipped = (body[0] === 'A' ? 'B' : 'A') + body.slice(1);
  assert.notEqual(flipped, body, 'the test must actually tamper with something');
  assert.throws(() => decrypt(PREFIX + flipped));
});
