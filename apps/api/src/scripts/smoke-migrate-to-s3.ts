/**
 * Phase 5a smoke for migrate-artifacts-to-s3.
 *
 * Requires the S3 storage env to point at a working bucket:
 *   HIVE_STORAGE_PROVIDER=s3
 *   HIVE_ARTIFACT_S3_BUCKET=hive-artifacts
 *   HIVE_ARTIFACT_S3_ENDPOINT=http://localhost:9000   # MinIO
 *   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
 *
 *   pnpm --filter @hive/api smoke:migrate-to-s3
 *
 * Procedure:
 *   1. Plant a synthetic local artifact (file + Artifact row).
 *   2. Read it back via the S3 storage provider after copying with
 *      LocalFsStorageProvider → S3StorageProvider directly.
 *   3. Update the row, verify storageProvider flipped, tear down.
 */
import { writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { prisma } from '@hive/db';
import {
  LocalFsStorageProvider,
  S3StorageProvider,
  resolveStorageProviderName,
} from '@hive/storage';
import { env } from '../env.js';

async function main(): Promise<void> {
  if (resolveStorageProviderName() !== 's3') {
    console.error('smoke:migrate-to-s3 needs HIVE_STORAGE_PROVIDER=s3');
    process.exit(2);
  }
  const tag = `mig-${randomBytes(4).toString('hex')}`;

  // Plant a synthetic local artifact (no bot needed — we just need a row).
  const template = await prisma.botTemplate.create({
    data: { name: `${tag}-tpl`, poolType: 'scraper', configSchema: {}, defaultConfig: {} },
  });
  const bot = await prisma.bot.create({
    data: { templateId: template.id, name: `${tag}-bot`, config: {} },
  });
  const job = await prisma.job.create({
    data: { botId: bot.id, status: 'succeeded', priority: 0, payload: {} },
  });
  const jobDir = join(env.HIVE_ARTIFACT_DIR, job.id);
  await mkdir(jobDir, { recursive: true });
  const filePath = join(jobDir, 'mig.txt');
  const body = Buffer.from(`migrate me ${tag}\n`);
  await writeFile(filePath, body);
  const s = await stat(filePath);
  const art = await prisma.artifact.create({
    data: {
      jobId: job.id,
      filename: 'mig.txt',
      contentType: 'text/plain',
      sizeBytes: Number(s.size),
      storageKey: `${job.id}/mig.txt`,
      storageProvider: 'local',
    },
  });
  console.log(`planted local artifact ${art.id} (${art.storageKey})`);

  // Run the migration logic in-line.
  const local = new LocalFsStorageProvider({ baseDir: env.HIVE_ARTIFACT_DIR });
  const s3 = new S3StorageProvider();
  const buf = await local.get(art.storageKey);
  await s3.put(art.storageKey, buf, art.contentType);
  await prisma.artifact.update({
    where: { id: art.id },
    data: { storageProvider: 's3' },
  });

  // Verify by reading back from S3.
  const got = await s3.get(art.storageKey);
  if (!got.equals(buf)) throw new Error('round-trip via S3 produced different bytes');
  console.log('S3 round-trip after migrate: OK');

  // Presigned URL works directly (no auth headers).
  const presigned = await s3.presignGet(art.storageKey, 60);
  const fetched = await fetch(presigned.url);
  if (!fetched.ok) throw new Error(`presigned URL failed: ${fetched.status}`);
  const text = await fetched.text();
  if (text !== body.toString('utf-8')) throw new Error('presigned download body mismatch');
  console.log(`presigned download (no auth header): OK (${fetched.status})`);

  // Cleanup.
  await s3.delete(art.storageKey);
  await prisma.artifact.delete({ where: { id: art.id } });
  await prisma.job.delete({ where: { id: job.id } });
  await prisma.bot.delete({ where: { id: bot.id } });
  await prisma.botTemplate.delete({ where: { id: template.id } });
  console.log('cleanup: OK');
  console.log('--- smoke:migrate-to-s3: OK ---');
}

main()
  .catch((err) => {
    console.error('smoke:migrate-to-s3 FAIL:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
