/**
 * S3-compatible storage provider.
 *
 * Works with AWS S3 (default), Cloudflare R2, MinIO, Wasabi, Backblaze B2, etc.
 * Non-AWS endpoints: set HIVE_ARTIFACT_S3_ENDPOINT. AWS path: leave blank.
 *
 * Env vars consumed:
 *   HIVE_ARTIFACT_S3_BUCKET   target bucket (required)
 *   HIVE_ARTIFACT_S3_ENDPOINT custom endpoint URL (blank = AWS)
 *   HIVE_ARTIFACT_S3_REGION   AWS region (default us-east-1)
 *   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (or instance role)
 *
 * `forcePathStyle` is enabled when an endpoint is set — required for MinIO and
 * most non-AWS S3 implementations. AWS uses virtual-hosted-style by default.
 */
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'node:stream';
import type { HiveStorageProvider, PresignedUrl, PutResult, StorageStream } from './types.js';

export interface S3Options {
  bucket?: string;
  endpoint?: string;
  region?: string;
  client?: S3Client;
}

export class S3StorageProvider implements HiveStorageProvider {
  readonly providerName = 's3' as const;
  private readonly bucket: string;
  private readonly client: S3Client;

  constructor(opts: S3Options = {}) {
    const bucket = opts.bucket ?? process.env.HIVE_ARTIFACT_S3_BUCKET;
    if (!bucket) {
      throw new Error('HIVE_ARTIFACT_S3_BUCKET is required when HIVE_STORAGE_PROVIDER=s3');
    }
    this.bucket = bucket;
    if (opts.client) {
      this.client = opts.client;
    } else {
      const endpoint = opts.endpoint ?? process.env.HIVE_ARTIFACT_S3_ENDPOINT?.trim();
      const region = opts.region ?? process.env.HIVE_ARTIFACT_S3_REGION ?? 'us-east-1';
      this.client = new S3Client({
        region,
        ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
      });
    }
  }

  async put(key: string, body: Buffer, contentType: string): Promise<PutResult> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
    return { key, size: body.byteLength };
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error(`S3 GetObject for '${key}' returned no body`);
    const stream = res.Body as Readable;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async getStream(key: string): Promise<StorageStream> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error(`S3 GetObject for '${key}' returned no body`);
    return res.Body as Readable;
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async presignGet(key: string, ttlSeconds: number): Promise<PresignedUrl> {
    const cmd = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    const url = await getSignedUrl(this.client, cmd, { expiresIn: ttlSeconds });
    return { url, expiresAt: new Date(Date.now() + ttlSeconds * 1000) };
  }
}
