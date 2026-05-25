/// <reference path="./sodium-native.d.ts" />
/**
 * @hive/crypto — XChaCha20-Poly1305 AEAD with a single master key.
 *
 * Wire format (string):
 *   hive:enc:v1:<base64(nonce(24) || ciphertext+tag(16))>
 *
 * Cross-language: the Python module `hive_base.crypto` (pynacl) produces and
 * consumes the exact same wire format with the same HIVE_SECRETS_KEY env var.
 */
import sodium from 'sodium-native';

export const PREFIX = 'hive:enc:v1:';

const KEYBYTES = sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES;
const NONCEBYTES = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
const ABYTES = sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES;

function loadKey(): Buffer {
  const hex = process.env.HIVE_SECRETS_KEY;
  if (!hex) {
    throw new Error(
      'HIVE_SECRETS_KEY is not set. Generate one with `openssl rand -hex 32` and add it to .env. Field-level secret encryption refuses to operate without it.',
    );
  }
  const trimmed = hex.trim();
  if (!/^[0-9a-fA-F]+$/.test(trimmed) || trimmed.length !== KEYBYTES * 2) {
    throw new Error(
      `HIVE_SECRETS_KEY must be ${KEYBYTES * 2} hex chars (32 bytes); got ${trimmed.length} chars.`,
    );
  }
  return Buffer.from(trimmed, 'hex');
}

let KEY: Buffer | null = null;
function key(): Buffer {
  if (!KEY) KEY = loadKey();
  return KEY;
}

/** True if a value has the canonical `hive:enc:v1:` prefix. */
export function isEncrypted(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/** Encrypt UTF-8 text. Returns the prefixed wire format. */
export function encrypt(plaintext: string): string {
  if (typeof plaintext !== 'string') {
    throw new Error('encrypt() expects a string');
  }
  const k = key();
  const message = Buffer.from(plaintext, 'utf-8');
  const ciphertext = Buffer.alloc(message.length + ABYTES);
  const nonce = Buffer.alloc(NONCEBYTES);
  sodium.randombytes_buf(nonce);
  sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    ciphertext,
    message,
    null,
    null,
    nonce,
    k,
  );
  const payload = Buffer.concat([nonce, ciphertext]);
  return PREFIX + payload.toString('base64');
}

/** Decrypt a `hive:enc:v1:…` string. Throws on tamper, wrong key, or bad format. */
export function decrypt(value: string): string {
  if (!isEncrypted(value)) {
    throw new Error('decrypt() called on a value missing the hive:enc:v1: prefix');
  }
  const k = key();
  let payload: Buffer;
  try {
    payload = Buffer.from(value.slice(PREFIX.length), 'base64');
  } catch {
    throw new Error('decrypt() received malformed base64');
  }
  if (payload.length < NONCEBYTES + ABYTES) {
    throw new Error('decrypt() payload too short — corrupted');
  }
  const nonce = payload.subarray(0, NONCEBYTES);
  const ciphertext = payload.subarray(NONCEBYTES);
  const message = Buffer.alloc(ciphertext.length - ABYTES);
  try {
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      message,
      null,
      ciphertext,
      null,
      nonce,
      k,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`decryption failed: ${msg}`);
  }
  return message.toString('utf-8');
}

/** Crash early at startup if the env is misconfigured. Pure assertion. */
export function assertKeyLoaded(): void {
  key();
}
