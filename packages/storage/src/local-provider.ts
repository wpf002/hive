/**
 * Local filesystem storage. Files live under HIVE_ARTIFACT_DIR.
 *
 * presignGet returns a short-lived HMAC-signed URL pointing at
 *   `${apiBaseUrl}/api/artifacts/presigned/:token`
 * The token's HMAC is verified by the API route before streaming the file.
 * The shared secret is HIVE_SECRETS_KEY (already available in every API
 * process), so no extra key material is needed.
 */
import { mkdir, writeFile, stat, readFile, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { dirname, join, sep, posix } from 'node:path';
import { createHmac } from 'node:crypto';
import type { HiveStorageProvider, PresignedUrl, PutResult, StorageStream } from './types.js';

export interface LocalOptions {
  /** Base directory on disk. Required. */
  baseDir: string;
  /** Public base URL for presigned download links (e.g. http://localhost:4000). */
  apiBaseUrl?: string;
  /** Hex-encoded HMAC secret for presigned URLs. Default: HIVE_SECRETS_KEY. */
  signingSecret?: string;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function signLocalPresign(key: string, expiresEpochSec: number, secret: Buffer): string {
  const payload = `${key}:${expiresEpochSec}`;
  const sig = createHmac('sha256', secret).update(payload).digest();
  return [b64url(Buffer.from(key, 'utf-8')), String(expiresEpochSec), b64url(sig)].join('.');
}

export interface VerifiedToken {
  key: string;
  expiresAt: number;
}

export function verifyLocalPresign(token: string, secret: Buffer): VerifiedToken {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed presign token');
  const [keyField, expStr, sigField] = parts;
  const key = Buffer.from(
    keyField.replace(/-/g, '+').replace(/_/g, '/') +
      (keyField.length % 4 ? '='.repeat(4 - (keyField.length % 4)) : ''),
    'base64',
  ).toString('utf-8');
  const exp = Number.parseInt(expStr, 10);
  if (!Number.isFinite(exp)) throw new Error('malformed presign token (expiry)');
  if (Math.floor(Date.now() / 1000) > exp) throw new Error('presign token expired');
  const expected = b64url(createHmac('sha256', secret).update(`${key}:${exp}`).digest());
  if (expected !== sigField) throw new Error('presign token signature mismatch');
  return { key, expiresAt: exp };
}

function safeKey(key: string): string {
  // Reject anything that could escape the base dir. Keys are always poison-free
  // strings produced by our routes; this is belt-and-braces.
  if (!key || key.includes('..') || key.startsWith('/') || key.includes('\\')) {
    throw new Error(`unsafe storage key '${key}'`);
  }
  return key.split('/').join(sep);
}

export class LocalFsStorageProvider implements HiveStorageProvider {
  readonly providerName = 'local' as const;
  private readonly baseDir: string;
  private readonly apiBaseUrl: string;
  private readonly signingSecret: Buffer;

  constructor(opts: LocalOptions) {
    this.baseDir = opts.baseDir;
    this.apiBaseUrl = opts.apiBaseUrl ?? process.env.API_BASE_URL ?? 'http://localhost:4000';
    const hex = opts.signingSecret ?? process.env.HIVE_SECRETS_KEY;
    if (!hex) {
      throw new Error(
        'LocalFsStorageProvider needs a signing secret (HIVE_SECRETS_KEY or opts.signingSecret).',
      );
    }
    this.signingSecret = Buffer.from(hex, 'hex');
  }

  async put(key: string, body: Buffer, _contentType: string): Promise<PutResult> {
    const full = join(this.baseDir, safeKey(key));
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, body);
    const s = await stat(full);
    return { key, size: Number(s.size) };
  }

  async get(key: string): Promise<Buffer> {
    return readFile(join(this.baseDir, safeKey(key)));
  }

  async getStream(key: string): Promise<StorageStream> {
    return createReadStream(join(this.baseDir, safeKey(key)));
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(join(this.baseDir, safeKey(key)));
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') throw err;
    }
  }

  async presignGet(key: string, ttlSeconds: number): Promise<PresignedUrl> {
    const expEpoch = Math.floor(Date.now() / 1000) + ttlSeconds;
    const token = signLocalPresign(key, expEpoch, this.signingSecret);
    const base = this.apiBaseUrl.replace(/\/$/, '');
    const url = `${base}/api/artifacts/presigned/${encodeURIComponent(token)}`;
    void posix; // referenced to keep import in case of future cross-OS work
    return { url, expiresAt: new Date(expEpoch * 1000) };
  }
}
