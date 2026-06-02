import '../test-helpers/unit-env.js'; // first — provides HIVE_SECRETS_KEY + static KMS
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectSecretPaths,
  encryptBotConfig,
  decryptBotConfig,
  maskBotConfig,
} from './secrets.js';

const template = {
  configSchema: {
    type: 'object',
    properties: {
      channelId: { type: 'string' },
      apiKey: { type: 'string', 'x-secret': true },
      nested: {
        type: 'object',
        properties: {
          token: { type: 'string', 'x-secret': true },
        },
      },
    },
  },
};

test('collectSecretPaths finds top-level and nested x-secret fields', () => {
  const paths = collectSecretPaths(template.configSchema).sort();
  assert.deepEqual(paths, ['apiKey', 'nested.token']);
});

test('collectSecretPaths returns [] for a schema with no secrets', () => {
  assert.deepEqual(collectSecretPaths({ type: 'object', properties: { x: { type: 'string' } } }), []);
});

test('encryptBotConfig encrypts only secret fields, leaving others intact', async () => {
  const enc = await encryptBotConfig(template, {
    channelId: 'public-123',
    apiKey: 'sk-super-secret',
    nested: { token: 'tok-abc' },
  });
  assert.equal(enc.channelId, 'public-123'); // non-secret untouched
  assert.notEqual(enc.apiKey, 'sk-super-secret'); // secret transformed
  assert.match(String(enc.apiKey), /^hive:enc:/); // envelope wire format
  assert.match(String((enc.nested as Record<string, unknown>).token), /^hive:enc:/);
});

test('encrypt → decrypt round-trips secret fields back to plaintext', async () => {
  const original = { channelId: 'c1', apiKey: 'sk-round-trip', nested: { token: 'tok-round' } };
  const enc = await encryptBotConfig(template, original);
  const dec = await decryptBotConfig(template, enc);
  assert.deepEqual(dec, original);
});

test('encryptBotConfig is idempotent — already-encrypted values are not re-wrapped', async () => {
  const once = await encryptBotConfig(template, { apiKey: 'sk-x' });
  const twice = await encryptBotConfig(template, once);
  assert.equal(once.apiKey, twice.apiKey);
});

test('maskBotConfig never reveals plaintext or raw ciphertext over HTTP', async () => {
  const enc = await encryptBotConfig(template, { channelId: 'c1', apiKey: 'sk-secret-value' });
  const masked = maskBotConfig(template, enc);
  assert.equal(masked.channelId, 'c1');
  assert.equal(masked.apiKey, '****encrypted'); // encrypted → opaque marker
  // Legacy plaintext masks to ****last4 so the UI can distinguish it.
  const maskedPlain = maskBotConfig(template, { apiKey: 'plaintextSECRET' });
  assert.equal(maskedPlain.apiKey, '****CRET');
});
