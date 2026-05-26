/// <reference path="../../crypto/src/sodium-native.d.ts" />
/**
 * StaticKeyKmsProvider — wraps DEKs under the HIVE_SECRETS_KEY env var.
 *
 * Used in local dev so we don't need cloud KMS to spin up a Hive instance.
 * The "key" is just the 32 hex bytes that the field-level encryption already
 * uses; the provider gives it a stable identifier so rotation logic works.
 *
 * Env vars:
 *   HIVE_SECRETS_KEY            current KEK (64 hex chars, required)
 *   HIVE_KMS_STATIC_KEY_ID      identifier for the current KEK
 *                                (default: 'static:v1')
 *   HIVE_KMS_STATIC_RETIRED_KEYS comma-separated 'keyId=hexKey' pairs that the
 *                                provider can still decrypt with. Used during
 *                                rotation sweeps.
 */
import sodium from 'sodium-native';
import type { EncryptedDek, HiveKmsProvider } from './types.js';

const KEYBYTES = sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES;
const NONCEBYTES = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
const ABYTES = sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES;

function parseHexKey(hex: string, where: string): Buffer {
  const trimmed = hex.trim();
  if (!/^[0-9a-fA-F]+$/.test(trimmed) || trimmed.length !== KEYBYTES * 2) {
    throw new Error(`${where} must be ${KEYBYTES * 2} hex chars (32 bytes); got ${trimmed.length}.`);
  }
  return Buffer.from(trimmed, 'hex');
}

function parseRetired(spec: string | undefined): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  if (!spec) return out;
  for (const entry of spec.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) {
      throw new Error(
        `HIVE_KMS_STATIC_RETIRED_KEYS entry '${trimmed}' is missing '=' between keyId and hex key`,
      );
    }
    const keyId = trimmed.slice(0, eq).trim();
    const hex = trimmed.slice(eq + 1).trim();
    out.set(keyId, parseHexKey(hex, `retired key '${keyId}'`));
  }
  return out;
}

export interface StaticProviderOptions {
  /** Override env-driven current key (for tests / rotation simulation). */
  currentKey?: { keyId: string; key: Buffer };
  /** Extra historical keys reachable for decryption only. */
  retired?: Map<string, Buffer>;
}

export class StaticKeyKmsProvider implements HiveKmsProvider {
  private readonly current: { keyId: string; key: Buffer };
  private readonly retired: Map<string, Buffer>;

  constructor(opts: StaticProviderOptions = {}) {
    if (opts.currentKey) {
      this.current = opts.currentKey;
    } else {
      const hex = process.env.HIVE_SECRETS_KEY;
      if (!hex) {
        throw new Error(
          'HIVE_SECRETS_KEY is not set. The static KMS provider needs it to wrap DEKs.',
        );
      }
      const keyId = (process.env.HIVE_KMS_STATIC_KEY_ID ?? 'static:v1').trim();
      this.current = { keyId, key: parseHexKey(hex, 'HIVE_SECRETS_KEY') };
    }
    this.retired = opts.retired ?? parseRetired(process.env.HIVE_KMS_STATIC_RETIRED_KEYS);
    if (this.retired.has(this.current.keyId)) {
      throw new Error(
        `HIVE_KMS_STATIC_RETIRED_KEYS lists '${this.current.keyId}' which is also the current key id`,
      );
    }
  }

  currentKeyId(): string {
    return this.current.keyId;
  }

  async encryptDek(dek: Buffer): Promise<EncryptedDek> {
    if (dek.length !== KEYBYTES) {
      throw new Error(`encryptDek expected a ${KEYBYTES}-byte DEK, got ${dek.length}`);
    }
    const nonce = Buffer.alloc(NONCEBYTES);
    sodium.randombytes_buf(nonce);
    const ct = Buffer.alloc(dek.length + ABYTES);
    sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(ct, dek, null, null, nonce, this.current.key);
    const payload = Buffer.concat([nonce, ct]);
    return {
      ciphertext: payload.toString('base64'),
      keyId: this.current.keyId,
      algorithm: 'XCHACHA20',
    };
  }

  async decryptDek(encrypted: EncryptedDek): Promise<Buffer> {
    const key =
      encrypted.keyId === this.current.keyId ? this.current.key : this.retired.get(encrypted.keyId);
    if (!key) {
      throw new Error(
        `static KMS provider has no key for keyId '${encrypted.keyId}'. ` +
          `Set HIVE_KMS_STATIC_RETIRED_KEYS to make older keys reachable during rotation.`,
      );
    }
    let payload: Buffer;
    try {
      payload = Buffer.from(encrypted.ciphertext, 'base64');
    } catch {
      throw new Error('encrypted DEK is not valid base64');
    }
    if (payload.length < NONCEBYTES + ABYTES) {
      throw new Error('encrypted DEK payload is too short to be valid');
    }
    const nonce = payload.subarray(0, NONCEBYTES);
    const ct = payload.subarray(NONCEBYTES);
    const dek = Buffer.alloc(ct.length - ABYTES);
    try {
      sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(dek, null, ct, null, nonce, key);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`decryptDek failed under keyId '${encrypted.keyId}': ${msg}`);
    }
    if (dek.length !== KEYBYTES) {
      throw new Error(`unwrapped DEK has wrong length ${dek.length}, expected ${KEYBYTES}`);
    }
    return dek;
  }
}
