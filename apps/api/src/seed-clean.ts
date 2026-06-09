/**
 * Clean reset: remove all demo/seed content and create exactly ONE bot per
 * template (named after the template, no duplicates). Leaves real online
 * workers alone; clears stale offline worker rows.
 *
 *   pnpm --filter @hive/api seed:clean
 *
 * Use this to turn the demo-populated instance into a clean, real starting
 * state you can actually operate.
 */
import { prisma, Prisma } from '@hive/db';
import { encryptBotConfig } from './lib/secrets.js';

async function main() {
  console.log('… clearing demo/seed content');
  // Order respects FKs; deleting bots cascades their jobs + schedules.
  await prisma.paperTrade.deleteMany({});
  await prisma.tradeAudit.deleteMany({});
  await prisma.paperWallet.deleteMany({});
  await prisma.aiUsage.deleteMany({});
  await prisma.artifact.deleteMany({});
  await prisma.schedule.deleteMany({});
  await prisma.job.deleteMany({});
  await prisma.bot.deleteMany({});
  // Drop stale worker rows (prior-session/demo). Real workers re-register on
  // their next heartbeat (~10s), so only remove ones not currently online.
  const staleWorkers = await prisma.worker.deleteMany({ where: { status: { not: 'online' } } });
  // Remove the demo audit markers + fake incident; keep genuine audit history.
  await prisma.auditLog.deleteMany({ where: { action: { in: ['demo.seeded', 'system.incident'] } } });
  console.log(`✓ cleared (removed ${staleWorkers.count} stale worker rows)`);

  const templates = await prisma.botTemplate.findMany({ orderBy: [{ poolType: 'asc' }, { name: 'asc' }] });
  console.log(`… creating one bot per template (${templates.length} templates)`);
  let n = 0;
  for (const t of templates) {
    const config = await encryptBotConfig(t, (t.defaultConfig ?? {}) as Prisma.InputJsonValue);
    await prisma.bot.create({
      data: {
        templateId: t.id,
        name: t.name, // one bot named after each template — no duplicates
        config: config as Prisma.InputJsonValue,
        enabled: true,
      },
    });
    n++;
  }
  console.log(`✓ created ${n} bots (one per template)`);

  const counts = {
    bots: await prisma.bot.count(),
    jobs: await prisma.job.count(),
    schedules: await prisma.schedule.count(),
    workersOnline: await prisma.worker.count({ where: { status: 'online' } }),
  };
  console.log('\n✅ Clean state:', JSON.stringify(counts));
}

main()
  .catch((err) => { console.error('seed_clean_failed', err); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
