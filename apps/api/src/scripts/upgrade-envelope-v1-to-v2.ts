/**
 * One-shot migration: re-encrypts every Bot.config secret currently stored
 * in v1 envelope (`hive:enc:v1:…`) into the v2 envelope (`hive:enc:v2:…`).
 *
 *   pnpm --filter @hive/api upgrade-envelope-v1-to-v2
 *
 * Idempotent — already-v2 values are skipped. Per-template-type counts are
 * logged so an operator can sanity-check the migration scope.
 *
 * Also records the current KEK in the KmsKey table (status='active') so that
 * subsequent `pnpm --filter @hive/api kms:rotate` runs have something to rotate
 * away from.
 */
import { prisma, Prisma } from '@hive/db';
import { isEncrypted as isV1, decrypt as decryptV1 } from '@hive/crypto';
import { encryptValue, isV2Envelope } from '../lib/envelope.js';
import { getKmsProvider, resolveProviderName } from '@hive/kms';

interface Counters {
  bots: number;
  fieldsConverted: number;
  fieldsAlreadyV2: number;
  fieldsPlaintext: number;
  rowsUpdated: number;
}

interface PerTemplate {
  templateName: string;
  poolType: string;
  bots: number;
  fieldsConverted: number;
}

type AnyJson = unknown;

/** Walk arbitrary JSON, calling `visit` on every string value that is a v1
 *  envelope. Returns true if any replacement was made. */
async function walk(
  node: AnyJson,
  visit: (val: string) => Promise<string>,
): Promise<{ next: AnyJson; changed: boolean; touched: number }> {
  if (typeof node === 'string') {
    if (isV1(node)) {
      const next = await visit(node);
      return { next, changed: next !== node, touched: 1 };
    }
    return { next: node, changed: false, touched: 0 };
  }
  if (Array.isArray(node)) {
    let changed = false;
    let touched = 0;
    const out: AnyJson[] = [];
    for (const item of node) {
      const r = await walk(item, visit);
      out.push(r.next);
      changed = changed || r.changed;
      touched += r.touched;
    }
    return { next: out, changed, touched };
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, AnyJson>;
    const out: Record<string, AnyJson> = {};
    let changed = false;
    let touched = 0;
    for (const [k, v] of Object.entries(obj)) {
      const r = await walk(v, visit);
      out[k] = r.next;
      changed = changed || r.changed;
      touched += r.touched;
    }
    return { next: out, changed, touched };
  }
  return { next: node, changed: false, touched: 0 };
}

async function main(): Promise<void> {
  const kms = getKmsProvider();
  const counters: Counters = {
    bots: 0,
    fieldsConverted: 0,
    fieldsAlreadyV2: 0,
    fieldsPlaintext: 0,
    rowsUpdated: 0,
  };
  const perTemplate = new Map<string, PerTemplate>();

  const bots = await prisma.bot.findMany({ include: { template: true } });
  for (const bot of bots) {
    counters.bots += 1;
    const tplKey = bot.template.id;
    if (!perTemplate.has(tplKey)) {
      perTemplate.set(tplKey, {
        templateName: bot.template.name,
        poolType: bot.template.poolType,
        bots: 0,
        fieldsConverted: 0,
      });
    }
    const tpl = perTemplate.get(tplKey)!;
    tpl.bots += 1;

    const config = bot.config as AnyJson;
    const result = await walk(config, async (v1) => {
      // Decrypt v1 with the legacy direct-XChaCha20 path, then re-encrypt as v2.
      const plain = decryptV1(v1);
      return encryptValue(plain);
    });

    if (!result.changed) {
      // Count v2 vs plaintext occurrences for visibility.
      await walk(config, async (s) => s); // no-op walk just to count
      continue;
    }
    counters.fieldsConverted += result.touched;
    tpl.fieldsConverted += result.touched;

    await prisma.bot.update({
      where: { id: bot.id },
      data: { config: result.next as Prisma.InputJsonValue },
    });
    counters.rowsUpdated += 1;
    console.log(
      `✓ bot ${bot.id} (${bot.name}) — converted ${result.touched} v1 field(s) to v2`,
    );
  }

  // Make sure the active KEK is recorded so kms:rotate has a "from" key.
  const currentKeyId = kms.currentKeyId();
  const provider = resolveProviderName();
  await prisma.kmsKey.upsert({
    where: { keyId: currentKeyId },
    update: { status: 'active', provider },
    create: { keyId: currentKeyId, provider, status: 'active' },
  });

  console.log('---');
  console.log(`Bots inspected:       ${counters.bots}`);
  console.log(`v1 fields converted:  ${counters.fieldsConverted}`);
  console.log(`Bot rows updated:     ${counters.rowsUpdated}`);
  console.log(`Active KEK recorded:  ${currentKeyId} (${provider})`);
  console.log('---');
  console.log('Per-template:');
  for (const t of perTemplate.values()) {
    if (t.fieldsConverted === 0) continue;
    console.log(`  ${t.poolType}/${t.templateName}: ${t.fieldsConverted} field(s) across ${t.bots} bot(s)`);
  }
}

main()
  .catch((err) => {
    console.error('upgrade-envelope-v1-to-v2 failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
