/**
 * @hive/storage — pluggable artifact storage backend.
 *
 *   import { getStorageProvider } from '@hive/storage';
 *   const storage = getStorageProvider();
 *   await storage.put('jobId/screenshot.png', buf, 'image/png');
 *
 * Selection: HIVE_STORAGE_PROVIDER env var, 'local' (default) | 's3'.
 */
export type {
  HiveStorageProvider,
  PutResult,
  PresignedUrl,
  StorageStream,
} from './types.js';
export { LocalFsStorageProvider, signLocalPresign, verifyLocalPresign } from './local-provider.js';
export type { LocalOptions, VerifiedToken } from './local-provider.js';
export { S3StorageProvider } from './s3-provider.js';
export type { S3Options } from './s3-provider.js';

import type { HiveStorageProvider } from './types.js';
import { LocalFsStorageProvider } from './local-provider.js';
import { S3StorageProvider } from './s3-provider.js';

let CACHED: HiveStorageProvider | null = null;

export type StorageProviderName = 'local' | 's3';

export function resolveStorageProviderName(): StorageProviderName {
  const raw = (process.env.HIVE_STORAGE_PROVIDER ?? 'local').trim().toLowerCase();
  if (raw === 's3') return 's3';
  if (raw === 'local' || raw === '') return 'local';
  throw new Error(`Unknown HIVE_STORAGE_PROVIDER='${raw}'. Expected 'local' or 's3'.`);
}

export interface BuildOptions {
  /** Local provider base dir. Required when name resolves to 'local'. */
  localBaseDir?: string;
}

export function buildStorageProvider(opts: BuildOptions = {}): HiveStorageProvider {
  const name = resolveStorageProviderName();
  if (name === 's3') return new S3StorageProvider();
  if (!opts.localBaseDir) {
    throw new Error(
      'buildStorageProvider({ localBaseDir }) must be supplied when HIVE_STORAGE_PROVIDER=local',
    );
  }
  return new LocalFsStorageProvider({ baseDir: opts.localBaseDir });
}

export function setStorageProvider(p: HiveStorageProvider): void {
  CACHED = p;
}

export function getStorageProvider(): HiveStorageProvider {
  if (!CACHED) throw new Error('storage provider not initialized; call setStorageProvider() first');
  return CACHED;
}

export function __resetStorageProviderForTests(): void {
  CACHED = null;
}
