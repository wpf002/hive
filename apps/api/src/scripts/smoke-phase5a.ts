/**
 * Phase 5a smoke test: exercises envelope encryption (v1 fallback + v2 write),
 * the KmsKey table, and the storage abstraction against both providers.
 *
 *   pnpm --filter @hive/api smoke:phase5a
 *
 * Intentionally side-effecting: creates and tears down a sentinel Bot row and
 * writes a tiny artifact to whichever storage provider is active. Designed
 * to run against a live local stack (Postgres + Redis + optionally MinIO).
 */
import { randomBytes } from 'node:crypto';
import { prisma } from '@hive/db';
import { encrypt as encryptV1 } from '@hive/crypto';
import { encryptValue, decryptValue, isV2Envelope, keyIdOf } from '../lib/envelope.js';
import { getKmsProvider, resolveProviderName } from '@hive/kms';
import {
  LocalFsStorageProvider,
  S3StorageProvider,
  resolveStorageProviderName,
} from '@hive/storage';
import { env } from '../env.js';

async function main(): Promise<void> {
  console.log('--- KMS / envelope ---');
  const kms = getKmsProvider();
  console.log(`provider: ${resolveProviderName()}`);
  console.log(`currentKeyId: ${kms.currentKeyId()}`);

  const secret = `smoke-${randomBytes(4).toString('hex')}`;
  const v1 = encryptV1(secret);
  const v2 = await encryptValue(secret);
  console.log(`v1 sample: ${v1.slice(0, 40)}...`);
  console.log(`v2 sample: ${v2.slice(0, 60)}...`);
  if (!isV2Envelope(v2)) throw new Error('v2 envelope did not have v2 prefix');
  if (keyIdOf(v2) !== kms.currentKeyId()) {
    throw new Error(`v2 envelope keyId mismatch: ${keyIdOf(v2)} vs ${kms.currentKeyId()}`);
  }
  const back1 = await decryptValue(v1);
  const back2 = await decryptValue(v2);
  if (back1 !== secret) throw new Error('v1 round-trip mismatch');
  if (back2 !== secret) throw new Error('v2 round-trip mismatch');
  console.log('round-trip v1 + v2: OK');

  // KmsKey row check
  await prisma.kmsKey.upsert({
    where: { keyId: kms.currentKeyId() },
    update: { status: 'active', provider: resolveProviderName() },
    create: { keyId: kms.currentKeyId(), provider: resolveProviderName(), status: 'active' },
  });
  const k = await prisma.kmsKey.findUnique({ where: { keyId: kms.currentKeyId() } });
  if (!k) throw new Error('KmsKey row did not persist');
  console.log(`KmsKey row: id=${k.id} status=${k.status}`);

  console.log('--- storage ---');
  const storageName = resolveStorageProviderName();
  console.log(`provider: ${storageName}`);
  const localTest = new LocalFsStorageProvider({ baseDir: env.HIVE_ARTIFACT_DIR });
  const key = `smoke/${randomBytes(4).toString('hex')}.txt`;
  const body = Buffer.from(`hive phase 5a smoke ${new Date().toISOString()}\n`);
  await localTest.put(key, body, 'text/plain');
  const back = await localTest.get(key);
  if (!back.equals(body)) throw new Error('local storage round-trip mismatch');
  console.log(`local put/get: OK (${key}, ${body.length}B)`);

  if (storageName === 's3' && env.HIVE_ARTIFACT_S3_BUCKET) {
    const s3 = new S3StorageProvider();
    const s3Key = `smoke/${randomBytes(4).toString('hex')}.txt`;
    await s3.put(s3Key, body, 'text/plain');
    const got = await s3.get(s3Key);
    if (!got.equals(body)) throw new Error('s3 round-trip mismatch');
    const presigned = await s3.presignGet(s3Key, 60);
    console.log(`s3 put/get + presign: OK (${s3Key}, ${body.length}B)`);
    console.log(`  presigned URL: ${presigned.url.slice(0, 90)}...`);
    await s3.delete(s3Key);
  }
  await localTest.delete(key);

  console.log('--- smoke 5a: OK ---');
}

main()
  .catch((err) => {
    console.error('smoke:phase5a FAIL:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
