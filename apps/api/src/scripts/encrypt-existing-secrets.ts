/**
 * One-shot data migration: encrypts any Bot.config field that the bot's
 * template now marks as `x-secret: true` but which is still plaintext in
 * Postgres.
 *
 *   pnpm --filter @hive/api encrypt-existing-secrets
 *
 * Idempotent — values that already carry the `hive:enc:v1:` prefix are left
 * alone. After encrypting we round-trip every touched row through decrypt to
 * catch silent corruption before exit.
 *
 * Run order (per Phase 4a):
 *   1) pnpm db:migrate                (no schema change; safe re-run)
 *   2) pnpm --filter @hive/api seed   (updates template schemas)
 *   3) pnpm --filter @hive/api encrypt-existing-secrets
 */
import { prisma, Prisma } from '@hive/db';
import { collectSecretPaths, encryptBotConfig } from '../lib/secrets.js';
import { decryptValue, isEnvelope } from '../lib/envelope.js';

interface Counters {
  inspected: number;
  updated: number;
  fieldsEncrypted: number;
  alreadyEncrypted: number;
  skippedNoSecrets: number;
}

async function main(): Promise<void> {
  const counters: Counters = {
    inspected: 0,
    updated: 0,
    fieldsEncrypted: 0,
    alreadyEncrypted: 0,
    skippedNoSecrets: 0,
  };

  const bots = await prisma.bot.findMany({ include: { template: true } });
  for (const bot of bots) {
    counters.inspected += 1;
    const secretPaths = collectSecretPaths(bot.template.configSchema);
    if (secretPaths.length === 0) {
      counters.skippedNoSecrets += 1;
      continue;
    }
    const config = bot.config as Record<string, unknown>;

    // Count what's already encrypted vs needs encrypting, for clean logging.
    let needsWork = false;
    for (const path of secretPaths) {
      const parts = path.split('.');
      let cursor: unknown = config;
      for (const p of parts) {
        if (cursor && typeof cursor === 'object' && p in (cursor as object)) {
          cursor = (cursor as Record<string, unknown>)[p];
        } else {
          cursor = undefined;
          break;
        }
      }
      if (typeof cursor !== 'string' || cursor === '') continue;
      if (isEnvelope(cursor)) {
        counters.alreadyEncrypted += 1;
      } else {
        needsWork = true;
        counters.fieldsEncrypted += 1;
      }
    }

    if (!needsWork) continue;

    const next = await encryptBotConfig(bot.template, config);

    // Sanity: decrypt every secret we just encrypted; fail loudly if any throws.
    for (const path of secretPaths) {
      const parts = path.split('.');
      let cursor: unknown = next;
      for (const p of parts) {
        if (cursor && typeof cursor === 'object' && p in (cursor as object)) {
          cursor = (cursor as Record<string, unknown>)[p];
        } else {
          cursor = undefined;
          break;
        }
      }
      if (typeof cursor === 'string' && isEnvelope(cursor)) {
        await decryptValue(cursor); // throws on tamper
      }
    }

    await prisma.bot.update({
      where: { id: bot.id },
      data: { config: next as Prisma.InputJsonValue },
    });
    counters.updated += 1;
    console.log(
      `✓ encrypted bot ${bot.id} (${bot.name}) — ${secretPaths.length} secret path(s) checked`,
    );
  }

  console.log('---');
  console.log(`inspected:          ${counters.inspected}`);
  console.log(`skipped (no x-secret in template): ${counters.skippedNoSecrets}`);
  console.log(`already encrypted (no change):    ${counters.alreadyEncrypted}`);
  console.log(`fields encrypted this run:        ${counters.fieldsEncrypted}`);
  console.log(`rows updated:                     ${counters.updated}`);
}

main()
  .catch((err) => {
    console.error('encrypt-existing-secrets failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
