/**
 * One-shot migration: copies every Artifact row whose storageProvider='local'
 * out of the local filesystem and into the S3-backed provider, then flips the
 * row's storageProvider to 's3'.
 *
 *   pnpm --filter @hive/api migrate-artifacts-to-s3 [--delete-local]
 *
 * Requires HIVE_STORAGE_PROVIDER=s3 + HIVE_ARTIFACT_S3_BUCKET to be set so
 * the S3 provider is the active one. We instantiate the local provider
 * manually so we can read from disk regardless of the active provider.
 *
 * Idempotent — rows that are already on s3 are skipped.
 *
 * --delete-local removes the source file on disk after a successful upload.
 * Off by default so the migration is reversible.
 */
import { prisma } from '@hive/db';
import { LocalFsStorageProvider, resolveStorageProviderName } from '@hive/storage';
import { getStorageProvider, initStorage } from '../lib/artifacts.js';
import { env } from '../env.js';

interface Args {
  deleteLocal: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { deleteLocal: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--delete-local') out.deleteLocal = true;
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: pnpm --filter @hive/api migrate-artifacts-to-s3 [--delete-local]',
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  if (resolveStorageProviderName() !== 's3') {
    console.error(
      'migrate-artifacts-to-s3 requires HIVE_STORAGE_PROVIDER=s3 (and HIVE_ARTIFACT_S3_BUCKET set).',
    );
    process.exit(2);
  }
  await initStorage();
  const dest = getStorageProvider();
  if (dest.providerName !== 's3') {
    console.error(`active storage provider is '${dest.providerName}', not 's3'.`);
    process.exit(2);
  }
  const source = new LocalFsStorageProvider({ baseDir: env.HIVE_ARTIFACT_DIR });

  const rows = await prisma.artifact.findMany({
    where: { storageProvider: 'local' },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`Found ${rows.length} local artifact(s) to migrate.`);

  let migrated = 0;
  let bytesUploaded = 0;
  let failed = 0;
  for (const art of rows) {
    try {
      const buf = await source.get(art.storageKey);
      await dest.put(art.storageKey, buf, art.contentType || 'application/octet-stream');
      await prisma.artifact.update({
        where: { id: art.id },
        data: { storageProvider: 's3' },
      });
      bytesUploaded += buf.byteLength;
      migrated += 1;
      if (args.deleteLocal) {
        await source.delete(art.storageKey);
      }
      console.log(`✓ ${art.id} (${art.storageKey}, ${buf.byteLength}B)`);
    } catch (err) {
      failed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`✗ ${art.id} (${art.storageKey}): ${msg}`);
    }
  }

  console.log('---');
  console.log(`migrated: ${migrated}`);
  console.log(`failed:   ${failed}`);
  console.log(`bytes:    ${bytesUploaded}`);
  console.log(`deleteLocal: ${args.deleteLocal}`);
}

main()
  .catch((err) => {
    console.error('migrate-artifacts-to-s3 failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
