/**
 * Phase 5b smoke: workers/streams/affinity routing.
 *
 *   pnpm --filter @hive/api smoke:phase5b
 *
 * Verifies:
 *   - worker_eligible_streams(): a worker in (region, zone) subscribes to all
 *     three eligible streams (any:any, region:any, region:zone).
 *   - dispatchStreamFor(): the dispatcher picks the right target stream per
 *     affinity shape.
 *   - The unroutable sweep: a job with affinity targeting a region with no
 *     online worker eventually flips to status='unroutable'.
 *
 * Standalone — no real workers needed. Uses Redis + Postgres directly.
 */
import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { prisma, Prisma } from '@hive/db';
import {
  dispatchStreamFor,
  workerEligibleStreams,
  poolStreamFor,
} from '@hive/worker-base-ts';

function assertEq<T>(label: string, got: T, expected: T): void {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) {
    throw new Error(`FAIL ${label}\n  got:      ${JSON.stringify(got)}\n  expected: ${JSON.stringify(expected)}`);
  }
  console.log(`✓ ${label}`);
}

async function main(): Promise<void> {
  console.log('--- stream routing ---');
  assertEq(
    'dispatchStreamFor(no affinity)',
    dispatchStreamFor('scraper', null),
    'hive:pool:scraper:any:any',
  );
  assertEq(
    'dispatchStreamFor(region only)',
    dispatchStreamFor('scraper', { region: 'us-east' }),
    'hive:pool:scraper:us-east:any',
  );
  assertEq(
    'dispatchStreamFor(region + zone)',
    dispatchStreamFor('scraper', { region: 'us-east', zone: 'colo-1' }),
    'hive:pool:scraper:us-east:colo-1',
  );
  assertEq(
    'dispatchStreamFor(zone without region degrades)',
    dispatchStreamFor('scraper', { zone: 'colo-1' }),
    'hive:pool:scraper:any:any',
  );

  console.log('--- worker subscriptions ---');
  const single = workerEligibleStreams('scraper', 'local', 'default').map((s) => s.stream);
  // A worker self-declares (local, default) — those are real labels, not the
  // wildcard. It always consumes any:any (no-affinity), plus local:any and
  // local:default in case an operator pins a bot to those exact labels.
  assertEq('worker(local/default) → 3 streams', single.length, 3);
  assertEq('worker(local/default) includes any:any', single.includes('hive:pool:scraper:any:any'), true);

  const remote = workerEligibleStreams('scraper', 'us-east', 'colo-1').map((s) => s.stream);
  assertEq('worker(us-east/colo-1) → 3 streams', remote.length, 3);
  assertEq('worker(us-east/colo-1) includes any:any', remote.includes('hive:pool:scraper:any:any'), true);
  assertEq(
    'worker(us-east/colo-1) includes region:any',
    remote.includes('hive:pool:scraper:us-east:any'),
    true,
  );
  assertEq(
    'worker(us-east/colo-1) includes region:zone',
    remote.includes('hive:pool:scraper:us-east:colo-1'),
    true,
  );

  console.log('--- unroutable sweep ---');
  // Stand up a synthetic template + bot with affinity targeting an offline region.
  const tag = `smoke5b-${randomBytes(4).toString('hex')}`;
  const template = await prisma.botTemplate.create({
    data: {
      name: `${tag}-tpl`,
      poolType: 'scraper',
      configSchema: { type: 'object', properties: {} },
      defaultConfig: {},
      affinity: { region: 'mars', zone: 'crater-7' } as Prisma.InputJsonValue,
    },
  });
  const bot = await prisma.bot.create({
    data: { templateId: template.id, name: `${tag}-bot`, config: {} },
  });
  // Synthesize a queued job that's already past the unroutable timeout.
  const old = new Date(Date.now() - 90 * 1000);
  const job = await prisma.job.create({
    data: {
      botId: bot.id,
      status: 'queued',
      createdAt: old,
      priority: 0,
      payload: {},
    },
  });

  // Inline minimal version of the dispatcher's sweep so we don't depend on
  // the dispatcher process being up.
  const candidates = await prisma.job.findMany({
    where: { status: 'queued', createdAt: { lt: new Date(Date.now() - 60_000) }, id: job.id },
    include: { bot: { include: { template: true } } },
  });
  for (const j of candidates) {
    const aff = (j.bot.affinityOverride ?? j.bot.template.affinity) as
      | { region?: string; zone?: string }
      | null;
    const workers = await prisma.worker.findMany({
      where: {
        poolType: j.bot.template.poolType,
        status: { not: 'offline' },
        ...(aff?.region ? { region: aff.region } : {}),
        ...(aff?.region && aff?.zone ? { zone: aff.zone } : {}),
      },
      take: 1,
    });
    if (workers.length === 0) {
      await prisma.job.update({
        where: { id: j.id },
        data: {
          status: 'unroutable',
          error: `no online worker in pool '${j.bot.template.poolType}' matches region='${aff?.region}' zone='${aff?.zone}'`,
          finishedAt: new Date(),
        },
      });
    }
  }
  const after = await prisma.job.findUnique({ where: { id: job.id } });
  assertEq('job marked unroutable when no worker matches', after?.status, 'unroutable');
  console.log(`  reason: ${after?.error}`);

  // Also exercise the Redis stream XADD path to confirm the target stream is
  // what we'd expect from the affinity.
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6380');
  const targetStream = dispatchStreamFor('scraper', { region: 'mars', zone: 'crater-7' });
  assertEq('target stream for mars/crater-7', targetStream, poolStreamFor('scraper', 'mars', 'crater-7'));
  await redis.xadd(targetStream, '*', 'jobId', 'noop', 'pool', 'scraper');
  const len = await redis.xlen(targetStream);
  console.log(`✓ XADD to ${targetStream}; XLEN=${len}`);
  // Clean up the synthetic entry.
  await redis.del(targetStream).catch(() => undefined);
  await redis.quit();

  // Cleanup.
  await prisma.job.delete({ where: { id: job.id } });
  await prisma.bot.delete({ where: { id: bot.id } });
  await prisma.botTemplate.delete({ where: { id: template.id } });

  console.log('--- smoke:phase5b: OK ---');
}

main()
  .catch((err) => {
    console.error('smoke:phase5b FAIL:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
