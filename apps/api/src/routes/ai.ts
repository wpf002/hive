import type { FastifyInstance } from 'fastify';
import { prisma } from '@hive/db';
import { requireAuth } from '../auth.js';

export async function aiRoutes(app: FastifyInstance) {
  app.get('/api/ai/usage/today', { preHandler: requireAuth('api') }, async () => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const rows = await prisma.aiUsage.findMany({
      where: { createdAt: { gte: start } },
      select: { costCents: true, provider: true, inputTokens: true, outputTokens: true },
    });
    const totalCostCents = rows.reduce((s, r) => s + r.costCents, 0);
    const byProvider: Record<string, { costCents: number; calls: number; inputTokens: number; outputTokens: number }> = {};
    for (const r of rows) {
      const p = (byProvider[r.provider] ??= { costCents: 0, calls: 0, inputTokens: 0, outputTokens: 0 });
      p.costCents += r.costCents;
      p.calls += 1;
      p.inputTokens += r.inputTokens;
      p.outputTokens += r.outputTokens;
    }
    return {
      startOfDay: start.toISOString(),
      totalCostCents,
      calls: rows.length,
      byProvider,
    };
  });

  app.get('/api/ai/jobs/recent', { preHandler: requireAuth('api') }, async () => {
    return prisma.job.findMany({
      where: { bot: { template: { poolType: 'ai_agent' } } },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: { bot: { include: { template: true } } },
    });
  });
}
