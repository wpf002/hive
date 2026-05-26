/**
 * Phase 5a end-to-end smoke for the v1→v2 upgrade + S3 migrate scripts.
 *
 *   pnpm --filter @hive/api smoke:upgrade-and-migrate
 *
 * Side-effecting: creates a sentinel BotTemplate + Bot + Job + Artifact, then
 *   1. Re-uses the secrets.ts code path to upgrade the bot's v1 ciphertext to v2.
 *   2. Re-runs it to confirm idempotency.
 *   3. Tears the sentinel rows down.
 *
 * The S3 migration script itself is only exercised in a higher-level test
 * (because it requires HIVE_STORAGE_PROVIDER=s3 env at script entry). The
 * artifact row is created so an operator can run migrate-artifacts-to-s3
 * against the same DB and confirm row #1 flips to storageProvider='s3'.
 */
import { writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { prisma } from '@hive/db';
import { encrypt as encryptV1 } from '@hive/crypto';
import { isV2Envelope } from '../lib/envelope.js';
import { encryptBotConfig, decryptBotConfig } from '../lib/secrets.js';
import { env } from '../env.js';

async function main(): Promise<void> {
  const tag = `smoke-${randomBytes(4).toString('hex')}`;
  console.log(`tag: ${tag}`);

  const template = await prisma.botTemplate.create({
    data: {
      name: `${tag}-tpl`,
      description: 'phase 5a smoke template',
      poolType: 'scraper',
      configSchema: {
        type: 'object',
        properties: { apiKey: { type: 'string', 'x-secret': true } },
      },
      defaultConfig: { apiKey: '' },
    },
  });

  const plaintext = `tok-${randomBytes(4).toString('hex')}`;
  const v1 = encryptV1(plaintext);
  const bot = await prisma.bot.create({
    data: {
      templateId: template.id,
      name: `${tag}-bot`,
      config: { apiKey: v1 },
    },
  });
  console.log(`bot created with v1 ciphertext: ${(bot.config as Record<string, string>).apiKey.slice(0, 30)}...`);

  const job = await prisma.job.create({
    data: { botId: bot.id, status: 'succeeded', priority: 0, payload: {} },
  });
  const jobDir = join(env.HIVE_ARTIFACT_DIR, job.id);
  await mkdir(jobDir, { recursive: true });
  const filePath = join(jobDir, 'smoke.txt');
  const body = Buffer.from(`hello phase 5a ${tag}\n`);
  await writeFile(filePath, body);
  const s = await stat(filePath);
  const artifact = await prisma.artifact.create({
    data: {
      jobId: job.id,
      filename: 'smoke.txt',
      contentType: 'text/plain',
      sizeBytes: Number(s.size),
      storageKey: `${job.id}/smoke.txt`,
      storageProvider: 'local',
    },
  });
  console.log(`local artifact created: ${artifact.id}`);

  // Manual upgrade: same path the upgrade-envelope-v1-to-v2 CLI follows.
  const reloaded = await prisma.bot.findUnique({
    where: { id: bot.id },
    include: { template: true },
  });
  if (!reloaded) throw new Error('bot vanished');
  const decrypted = await decryptBotConfig(reloaded.template, reloaded.config);
  if ((decrypted as Record<string, string>).apiKey !== plaintext) {
    throw new Error('v1 decrypt produced wrong plaintext');
  }
  const reencrypted = await encryptBotConfig(reloaded.template, decrypted);
  await prisma.bot.update({
    where: { id: bot.id },
    data: { config: reencrypted as object },
  });

  const after = await prisma.bot.findUnique({ where: { id: bot.id } });
  const apiKey = (after?.config as Record<string, unknown>)?.apiKey;
  if (typeof apiKey !== 'string' || !isV2Envelope(apiKey)) {
    throw new Error(`expected v2 envelope after upgrade, got: ${String(apiKey).slice(0, 60)}`);
  }
  console.log(`bot upgraded to v2: ${apiKey.slice(0, 40)}...`);

  // Idempotency check: a second pass should not change the envelope.
  const before2 = apiKey;
  const reloaded2 = await prisma.bot.findUnique({
    where: { id: bot.id },
    include: { template: true },
  });
  const dec2 = await decryptBotConfig(reloaded2!.template, reloaded2!.config);
  const enc2 = await encryptBotConfig(reloaded2!.template, dec2);
  await prisma.bot.update({ where: { id: bot.id }, data: { config: enc2 as object } });
  const after2 = await prisma.bot.findUnique({ where: { id: bot.id } });
  const apiKey2 = (after2?.config as Record<string, unknown>)?.apiKey as string;
  // The envelopes are NOT byte-identical (new DEK + nonce each time), but
  // both should be v2 and decrypt to the same plaintext.
  void before2;
  const back = await decryptBotConfig(template, after2!.config);
  if ((back as Record<string, string>).apiKey !== plaintext) {
    throw new Error('round-trip after idempotent encrypt diverged');
  }
  if (!isV2Envelope(apiKey2)) throw new Error('second pass produced non-v2 envelope');
  console.log('idempotent re-encrypt: OK (still v2, same plaintext)');

  // Cleanup.
  await prisma.artifact.delete({ where: { id: artifact.id } });
  await prisma.job.delete({ where: { id: job.id } });
  await prisma.bot.delete({ where: { id: bot.id } });
  await prisma.botTemplate.delete({ where: { id: template.id } });
  console.log('cleanup: OK');
  console.log('--- smoke:upgrade-and-migrate: OK ---');
}

main()
  .catch((err) => {
    console.error('smoke:upgrade-and-migrate FAIL:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
