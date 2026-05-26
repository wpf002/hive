/**
 * Phase 5a rotation smoke. Simulates a master-key rotation in-process by
 * constructing two static providers (the "before" and "after" worlds) and
 * verifying a value encrypted under the old KEK can be rewrapped to the new
 * KEK without re-encrypting the data ciphertext.
 *
 *   pnpm --filter @hive/api smoke:kms-rotation
 *
 * Standalone — does NOT touch Postgres. The full DB-bound rotation runs via
 * `pnpm --filter @hive/api kms:rotate` against a live database.
 */
import { randomBytes } from 'node:crypto';
import { StaticKeyKmsProvider } from '@hive/kms';
import { encryptValue, decryptValue, rewrapV2, keyIdOf } from '../lib/envelope.js';

async function main(): Promise<void> {
  const oldHex = randomBytes(32).toString('hex');
  const newHex = randomBytes(32).toString('hex');

  const oldProvider = new StaticKeyKmsProvider({
    currentKey: { keyId: 'static:v1', key: Buffer.from(oldHex, 'hex') },
  });
  const newProvider = new StaticKeyKmsProvider({
    currentKey: { keyId: 'static:v2', key: Buffer.from(newHex, 'hex') },
    retired: new Map([['static:v1', Buffer.from(oldHex, 'hex')]]),
  });

  const plain = `secret-${randomBytes(4).toString('hex')}`;
  const before = await encryptValue(plain, { kms: oldProvider });
  console.log(`before keyId: ${keyIdOf(before)}`);
  if (keyIdOf(before) !== 'static:v1') throw new Error('expected static:v1');

  const after = await rewrapV2(before, { kms: newProvider });
  console.log(`after  keyId: ${keyIdOf(after)}`);
  if (keyIdOf(after) !== 'static:v2') throw new Error('rewrap did not switch keyId');

  const back = await decryptValue(after, { kms: newProvider });
  if (back !== plain) throw new Error('post-rotation decrypt mismatch');
  console.log('rewrap + decrypt under new key: OK');

  // The data ciphertext (everything after the wrapped DEK) must be unchanged.
  const beforeData = before.split(':').slice(-1)[0];
  const afterData = after.split(':').slice(-1)[0];
  if (beforeData !== afterData) {
    throw new Error('data ciphertext changed during rewrap — should only rewrap the DEK');
  }
  console.log('data ciphertext invariant: OK (only wrapped DEK changed)');

  // The new provider should also be able to decrypt the OLD envelope directly
  // (because it has the old key in its retired set).
  const stillDecodable = await decryptValue(before, { kms: newProvider });
  if (stillDecodable !== plain) throw new Error('retired key path broken');
  console.log('retired-key decrypt path: OK');

  console.log('--- smoke:kms-rotation: OK ---');
}

main().catch((err) => {
  console.error('smoke:kms-rotation FAIL:', err);
  process.exit(1);
});
