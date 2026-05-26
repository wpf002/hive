/**
 * Hive artifact storage abstraction.
 *
 *   const storage = getStorageProvider();
 *   await storage.put('jobId/screenshot.png', buf, 'image/png');
 *   const stream = await storage.getStream('jobId/screenshot.png');
 *
 * Provider selection: HIVE_STORAGE_PROVIDER env var, 'local' (default) | 's3'.
 */
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { Readable } from 'node:stream';

export interface PutResult {
  /** Provider-internal key used to reference this object. */
  key: string;
  /** Final size in bytes (post-storage, e.g. after any encoding). */
  size: number;
}

export interface PresignedUrl {
  url: string;
  expiresAt: Date;
}

export type StorageStream = Readable | NodeReadableStream;

export interface HiveStorageProvider {
  /** Provider tag, persisted alongside the key so we know how to read it later. */
  readonly providerName: 'local' | 's3';
  /** Upload bytes. `key` is the canonical path (e.g. `${jobId}/${filename}`). */
  put(key: string, body: Buffer, contentType: string): Promise<PutResult>;
  /** Read the full object as a Buffer. Use only for small objects. */
  get(key: string): Promise<Buffer>;
  /** Stream the object — preferred for HTTP responses. */
  getStream(key: string): Promise<StorageStream>;
  /** Remove the object. No-op if it doesn't exist. */
  delete(key: string): Promise<void>;
  /** Time-limited direct-download URL. Used to bypass the API for large files. */
  presignGet(key: string, ttlSeconds: number): Promise<PresignedUrl>;
}
