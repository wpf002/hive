/**
 * KMS master-key rotation.
 *
 *   pnpm --filter @hive/api kms:rotate [--new-key-id <id>]
 *
 * Procedure:
 *   1. Take a Postgres advisory lock so only one rotation runs at a time.
 *   2. Record the new KEK in KmsKey (status='active'); mark any previously
 *      active/retiring KEKs as 'retiring'.
 *   3. Walk every Bot.config v2 envelope; for any whose wrapping KEK is not
 *      the new KEK, re-wrap the DEK under the new KEK and write the new
 *      envelope back. The data ciphertext is untouched — only the wrapped
 *      DEK changes.
 *   4. Re-scan; any retiring KEKs with zero remaining references are marked
 *      'revoked'.
 *
 * Required environment before invocation:
 *   - HIVE_KMS_PROVIDER, HIVE_KMS_KEY_ID (aws) OR HIVE_SECRETS_KEY +
 *     HIVE_KMS_STATIC_KEY_ID (static) — must point at the NEW KEK.
 *   - For the static provider in rotation mode: HIVE_KMS_STATIC_RETIRED_KEYS
 *     must include the OLD keyId=hex pair so the old wrapped DEKs can be
 *     unwrapped during the sweep.
 *   - For AWS: the runner's IAM role must have kms:Decrypt on the old key
 *     and kms:Encrypt on the new key.
 *
 * Locking note: per-row UPDATEs are used so other API writes during the sweep
 * stay unblocked. Concurrent writes during the window land as v2 envelopes
 * under the new key — they'll be skipped by the sweep, which is correct.
 */
import { prisma, Prisma } from '@hive/db';
import { getKmsProvider, resolveProviderName } from '@hive/kms';
import { rewrapV2, isV2Envelope, keyIdOf } from '../lib/envelope.js';

const ADVISORY_LOCK_KEY = 909090n; // arbitrary fixed bigint; only kms:rotate uses it.

interface Args {
  newKeyId?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--new-key-id') {
      out.newKeyId = argv[++i];
    } else if (a.startsWith('--new-key-id=')) {
      out.newKeyId = a.slice('--new-key-id='.length);
    } else if (a === '--help' || a === '-h') {
      console.log('Usage: pnpm --filter @hive/api kms:rotate [--new-key-id <id>]');
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

type AnyJson = unknown;

async function walkAndRewrap(
  node: AnyJson,
  newKeyId: string,
): Promise<{ next: AnyJson; rewrapped: number; alreadyCurrent: number }> {
  if (typeof node === 'string' && isV2Envelope(node)) {
    if (keyIdOf(node) === newKeyId) {
      return { next: node, rewrapped: 0, alreadyCurrent: 1 };
    }
    const next = await rewrapV2(node);
    return { next, rewrapped: 1, alreadyCurrent: 0 };
  }
  if (Array.isArray(node)) {
    const out: AnyJson[] = [];
    let rewrapped = 0;
    let alreadyCurrent = 0;
    for (const item of node) {
      const r = await walkAndRewrap(item, newKeyId);
      out.push(r.next);
      rewrapped += r.rewrapped;
      alreadyCurrent += r.alreadyCurrent;
    }
    return { next: out, rewrapped, alreadyCurrent };
  }
  if (node && typeof node === 'object') {
    const out: Record<string, AnyJson> = {};
    let rewrapped = 0;
    let alreadyCurrent = 0;
    for (const [k, v] of Object.entries(node as Record<string, AnyJson>)) {
      const r = await walkAndRewrap(v, newKeyId);
      out[k] = r.next;
      rewrapped += r.rewrapped;
      alreadyCurrent += r.alreadyCurrent;
    }
    return { next: out, rewrapped, alreadyCurrent };
  }
  return { next: node, rewrapped: 0, alreadyCurrent: 0 };
}

async function countReferencesByKeyId(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const bots = await prisma.bot.findMany({ select: { config: true } });
  function visit(n: AnyJson): void {
    if (typeof n === 'string' && isV2Envelope(n)) {
      const kid = keyIdOf(n);
      if (kid) out.set(kid, (out.get(kid) ?? 0) + 1);
      return;
    }
    if (Array.isArray(n)) {
      for (const x of n) visit(x);
      return;
    }
    if (n && typeof n === 'object') {
      for (const v of Object.values(n as Record<string, AnyJson>)) visit(v);
    }
  }
  for (const b of bots) visit(b.config as AnyJson);
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const provider = resolveProviderName();
  const kms = getKmsProvider();
  const newKeyId = args.newKeyId ?? kms.currentKeyId();

  if (provider === 'aws' && !args.newKeyId) {
    console.error('--new-key-id is required when HIVE_KMS_PROVIDER=aws');
    process.exit(2);
  }
  if (args.newKeyId && args.newKeyId !== kms.currentKeyId()) {
    console.error(
      `--new-key-id=${args.newKeyId} does not match the active provider's currentKeyId=${kms.currentKeyId()}. ` +
        `Set the env to point at the new key first.`,
    );
    process.exit(2);
  }

  const started = Date.now();

  // Acquire the advisory lock; release in finally.
  await prisma.$executeRawUnsafe(`SELECT pg_advisory_lock(${ADVISORY_LOCK_KEY})`);
  try {
    // Step 1: mark previous active/retiring keys as 'retiring'; upsert new key as 'active'.
    await prisma.$transaction(async (tx) => {
      await tx.kmsKey.updateMany({
        where: { status: { in: ['active', 'retiring'] }, NOT: { keyId: newKeyId } },
        data: { status: 'retiring' },
      });
      await tx.kmsKey.upsert({
        where: { keyId: newKeyId },
        update: { status: 'active', provider, retiredAt: null },
        create: { keyId: newKeyId, provider, status: 'active' },
      });
    });
    console.log(`Recorded ${newKeyId} as active KEK (${provider}).`);

    // Step 2: sweep every Bot.config and re-wrap v2 envelopes under the new KEK.
    const bots = await prisma.bot.findMany({ select: { id: true, name: true, config: true } });
    let processed = 0;
    let rowsUpdated = 0;
    let envelopesRewrapped = 0;
    let envelopesAlreadyCurrent = 0;
    for (const bot of bots) {
      processed += 1;
      const r = await walkAndRewrap(bot.config as AnyJson, newKeyId);
      envelopesRewrapped += r.rewrapped;
      envelopesAlreadyCurrent += r.alreadyCurrent;
      if (r.rewrapped > 0) {
        await prisma.bot.update({
          where: { id: bot.id },
          data: { config: r.next as Prisma.InputJsonValue },
        });
        rowsUpdated += 1;
      }
      if (processed % 100 === 0) {
        console.log(
          `… ${processed}/${bots.length} bots processed; ${envelopesRewrapped} envelope(s) rewrapped so far`,
        );
      }
    }

    // Step 3: any retiring keys with zero refs become revoked.
    const refs = await countReferencesByKeyId();
    const retiring = await prisma.kmsKey.findMany({ where: { status: 'retiring' } });
    let revoked = 0;
    for (const key of retiring) {
      if (!refs.has(key.keyId)) {
        await prisma.kmsKey.update({
          where: { keyId: key.keyId },
          data: { status: 'revoked', retiredAt: new Date() },
        });
        revoked += 1;
      }
    }

    const durationSeconds = ((Date.now() - started) / 1000).toFixed(2);
    console.log('---');
    console.log(`Rotation complete.`);
    console.log(`  newKeyId:                 ${newKeyId}`);
    console.log(`  bots inspected:           ${processed}`);
    console.log(`  bots updated:             ${rowsUpdated}`);
    console.log(`  envelopes rewrapped:      ${envelopesRewrapped}`);
    console.log(`  envelopes already current:${envelopesAlreadyCurrent}`);
    console.log(`  retired keys revoked:     ${revoked}`);
    console.log(`  duration (s):             ${durationSeconds}`);
  } finally {
    await prisma.$executeRawUnsafe(`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`);
  }
}

main()
  .catch((err) => {
    console.error('kms:rotate failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
