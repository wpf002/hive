/**
 * Envelope encryption for Bot.config secrets and other small values.
 *
 * v2 wire format (string):
 *   hive:enc:v2:<b64url(keyId)>:<b64(wrappedDek)>:<b64(nonce || ct+tag)>
 *
 *   - <keyId> is base64url-encoded so AWS KMS key ARNs (which contain ':')
 *     don't collide with the field separator. base64url uses [A-Za-z0-9_-]
 *     and never contains ':' or '='.
 *   - <wrappedDek> is the KMS-wrapped 32-byte DEK, as produced by the active
 *     HiveKmsProvider. Format is provider-specific (KMS blob for AWS;
 *     nonce||ct for static).
 *   - <nonce || ct+tag> is the XChaCha20-Poly1305 ciphertext of the UTF-8
 *     plaintext under the DEK.
 *
 * Backward compatibility:
 *   v1 format (hive:enc:v1:…) is still accepted by decryptValue() so existing
 *   Bot.config rows keep working. Writes always emit v2.
 *
 * Cross-language: the Python module `hive_base.envelope` produces and consumes
 * the exact same wire format. See workers/base/hive_base/envelope.py.
 */
/// <reference path="../../../../packages/crypto/src/sodium-native.d.ts" />
import sodium from 'sodium-native';
import { decrypt as decryptV1, isEncrypted as isEncryptedV1, PREFIX as PREFIX_V1 } from '@hive/crypto';
import { getKmsProvider } from '@hive/kms';
import type { EncryptedDek, HiveKmsProvider } from '@hive/kms';

export const PREFIX_V2 = 'hive:enc:v2:';

const KEYBYTES = sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES;
const NONCEBYTES = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
const ABYTES = sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES;

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function fromB64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

/** True if `v` is any recognized hive ciphertext envelope (v1 or v2). */
export function isEnvelope(v: unknown): v is string {
  return typeof v === 'string' && (v.startsWith(PREFIX_V2) || v.startsWith(PREFIX_V1));
}

/** True specifically for v2 envelopes. */
export function isV2Envelope(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith(PREFIX_V2);
}

export interface EncryptOpts {
  kms?: HiveKmsProvider;
}

/** Encrypt UTF-8 plaintext into a v2 envelope. */
export async function encryptValue(plaintext: string, opts: EncryptOpts = {}): Promise<string> {
  if (typeof plaintext !== 'string') {
    throw new Error('encryptValue() expects a string');
  }
  const kms = opts.kms ?? getKmsProvider();

  const dek = Buffer.alloc(KEYBYTES);
  sodium.randombytes_buf(dek);
  try {
    const wrapped = await kms.encryptDek(dek);

    const nonce = Buffer.alloc(NONCEBYTES);
    sodium.randombytes_buf(nonce);
    const message = Buffer.from(plaintext, 'utf-8');
    const ct = Buffer.alloc(message.length + ABYTES);
    sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(ct, message, null, null, nonce, dek);
    const dataPayload = Buffer.concat([nonce, ct]);

    const keyIdField = b64url(Buffer.from(wrapped.keyId, 'utf-8'));
    return [
      PREFIX_V2 + keyIdField,
      Buffer.from(wrapped.ciphertext, 'base64').toString('base64'),
      dataPayload.toString('base64'),
    ].join(':');
  } finally {
    dek.fill(0);
  }
}

interface ParsedV2 {
  keyId: string;
  wrappedDek: EncryptedDek;
  nonce: Buffer;
  ct: Buffer;
}

function parseV2(blob: string): ParsedV2 {
  if (!blob.startsWith(PREFIX_V2)) {
    throw new Error('parseV2: missing hive:enc:v2: prefix');
  }
  const rest = blob.slice(PREFIX_V2.length);
  const parts = rest.split(':');
  if (parts.length !== 3) {
    throw new Error(`parseV2: expected 3 fields after prefix, got ${parts.length}`);
  }
  const [keyIdField, wrappedDekB64, dataB64] = parts;
  const keyId = fromB64url(keyIdField).toString('utf-8');
  const data = Buffer.from(dataB64, 'base64');
  if (data.length < NONCEBYTES + ABYTES) {
    throw new Error('parseV2: data payload too short');
  }
  return {
    keyId,
    wrappedDek: {
      ciphertext: wrappedDekB64,
      keyId,
      // We don't carry per-envelope algorithm; provider knows its own.
      // AWS provider ignores this; static provider ignores this.
      algorithm: 'XCHACHA20',
    },
    nonce: data.subarray(0, NONCEBYTES),
    ct: data.subarray(NONCEBYTES),
  };
}

/** Decrypt a hive envelope. Accepts v1 (legacy) and v2. */
export async function decryptValue(blob: string, opts: EncryptOpts = {}): Promise<string> {
  if (isV2Envelope(blob)) {
    const kms = opts.kms ?? getKmsProvider();
    const parsed = parseV2(blob);
    const dek = await kms.decryptDek(parsed.wrappedDek);
    try {
      const plain = Buffer.alloc(parsed.ct.length - ABYTES);
      sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        plain,
        null,
        parsed.ct,
        null,
        parsed.nonce,
        dek,
      );
      return plain.toString('utf-8');
    } finally {
      dek.fill(0);
    }
  }
  if (isEncryptedV1(blob)) {
    return decryptV1(blob);
  }
  throw new Error('decryptValue: input is not a recognized hive envelope');
}

/** Extract just the wrapping-KEK keyId from a v2 envelope without decrypting. */
export function keyIdOf(blob: string): string | null {
  if (!isV2Envelope(blob)) return null;
  try {
    return parseV2(blob).keyId;
  } catch {
    return null;
  }
}

/** Re-wrap a v2 envelope's DEK under the current KEK without touching the data
 *  ciphertext. No-op if the envelope is already wrapped under the current KEK.
 *  Returns the new envelope (or the original if no change). */
export async function rewrapV2(blob: string, opts: EncryptOpts = {}): Promise<string> {
  if (!isV2Envelope(blob)) {
    throw new Error('rewrapV2: input is not a v2 envelope');
  }
  const kms = opts.kms ?? getKmsProvider();
  const currentKeyId = kms.currentKeyId();
  const parsed = parseV2(blob);
  if (parsed.keyId === currentKeyId) return blob;
  const dek = await kms.decryptDek(parsed.wrappedDek);
  try {
    const rewrapped = await kms.encryptDek(dek);
    const keyIdField = b64url(Buffer.from(rewrapped.keyId, 'utf-8'));
    const dataPayload = Buffer.concat([parsed.nonce, parsed.ct]);
    return [
      PREFIX_V2 + keyIdField,
      Buffer.from(rewrapped.ciphertext, 'base64').toString('base64'),
      dataPayload.toString('base64'),
    ].join(':');
  } finally {
    dek.fill(0);
  }
}
