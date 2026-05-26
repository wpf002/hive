/**
 * Artifact storage glue. Routes call into here; the actual backend is a
 * pluggable HiveStorageProvider (local FS or S3) wired up at boot via
 * initStorage().
 *
 * Key scheme: `${jobId}/${filename}` — provider-relative.
 *   - Local: joined with HIVE_ARTIFACT_DIR at read time.
 *   - S3:    used verbatim as the object key.
 */
import { basename } from 'node:path';
import { prisma } from '@hive/db';
import {
  LocalFsStorageProvider,
  S3StorageProvider,
  setStorageProvider,
  getStorageProvider,
  resolveStorageProviderName,
  type HiveStorageProvider,
} from '@hive/storage';
import { env } from '../env.js';

export interface SaveResult {
  artifactId: string;
  storageKey: string;
  size: number;
  provider: 'local' | 's3';
}

/** Reject filenames that try to break out of the per-job key prefix.
 * basename() strips '/'; we also forbid '..' to be defensive. */
function safeFilename(input: string): string {
  const base = basename(input).trim();
  if (!base || base === '.' || base === '..' || base.includes('/') || base.includes('\\')) {
    throw new Error(`unsafe filename: '${input}'`);
  }
  return base;
}

export function jobKeyPrefix(jobId: string): string {
  return `${jobId}/`;
}

export function storageKeyFor(jobId: string, filename: string): string {
  return `${jobId}/${safeFilename(filename)}`;
}

/** Boot the configured storage provider once at startup. */
export async function initStorage(): Promise<HiveStorageProvider> {
  const name = resolveStorageProviderName();
  const provider: HiveStorageProvider =
    name === 's3'
      ? new S3StorageProvider()
      : new LocalFsStorageProvider({ baseDir: env.HIVE_ARTIFACT_DIR });
  setStorageProvider(provider);
  return provider;
}

export { getStorageProvider };

export async function saveArtifact(
  jobId: string,
  filename: string,
  buffer: Buffer,
  contentType: string,
): Promise<SaveResult> {
  const storage = getStorageProvider();
  const key = storageKeyFor(jobId, filename);
  const put = await storage.put(key, buffer, contentType || 'application/octet-stream');
  const row = await prisma.artifact.create({
    data: {
      jobId,
      filename: safeFilename(filename),
      contentType: contentType || 'application/octet-stream',
      sizeBytes: put.size,
      storageKey: put.key,
      storageProvider: storage.providerName,
    },
  });
  return {
    artifactId: row.id,
    storageKey: row.storageKey,
    size: row.sizeBytes,
    provider: storage.providerName,
  };
}

export async function openArtifactStream(storageKey: string) {
  const storage = getStorageProvider();
  return storage.getStream(storageKey);
}

export async function presignArtifactGet(storageKey: string, ttlSeconds: number) {
  const storage = getStorageProvider();
  return storage.presignGet(storageKey, ttlSeconds);
}
